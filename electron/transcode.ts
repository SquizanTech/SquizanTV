import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import type { AddressInfo } from 'node:net'

/**
 * Sonda y transcodificación con el ffmpeg empaquetado (@ffmpeg-installer).
 *
 * Chromium/Electron no decodifica Dolby (AC-3/E-AC-3), DTS ni TrueHD, no
 * demuxa bien MKV en todas las versiones y no admite HEVC/AV1/VP9 en cualquier
 * equipo. Para que una película se abra siempre dentro de SquizanTV:
 *
 * - si el vídeo es H.264 de 8 bits se copia (sin gastar CPU) y solo se
 *   convierte el audio a AAC;
 * - si es HEVC, H.264 de 10 bits, AV1, VP9 o un códec antiguo se recodifica a
 *   H.264 de 8 bits, limitado a 1080p para que un 4K no sature la CPU.
 *
 * El resultado se sirve como MPEG-TS por HTTP local, que es lo que consume
 * mpegts.js dentro de la app.
 */

export interface StreamProbeResult {
  ok: boolean
  container?: string
  video?: string
  /** Formato de pixeles del video (yuv420p, yuv420p10le, ...). */
  videoPixFmt?: string
  audio?: string
  duration?: number
  reason?: string
}

export interface TranscodeResult {
  ok: boolean
  url?: string
  reason?: string
}

interface TranscodeSession {
  id: string
  proc: ChildProcess
  res: http.ServerResponse | null
  idle: NodeJS.Timeout | null
  stderrTail: string
  exited: boolean
}

const sessions = new Map<string, TranscodeSession>()
let server: http.Server | null = null
let serverPort = 0

/** Ruta del ffmpeg empaquetado (asar.unpacked en producción, node_modules en desarrollo). */
export function ffmpegBinary(): string {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', `${process.platform}-${arch}`, name),
    )
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installed = require('@ffmpeg-installer/ffmpeg') as { path?: string }
    if (installed?.path) candidates.push(installed.path)
  } catch {
    /* no está instalado el paquete */
  }
  if (app.isPackaged === false) {
    candidates.push(path.join(app.getAppPath(), 'node_modules', '@ffmpeg-installer', `${process.platform}-${arch}`, name))
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? 'ffmpeg'
}

/** Códecs de audio que el <video> de Chromium decodifica; el resto se convierte. */
export function isAudioSupported(codec: string): boolean {
  return ['aac', 'mp3', 'mp2', 'opus', 'flac', 'vorbis'].includes(codec)
}

/**
 * Códecs de vídeo que se pueden copiar a MPEG-TS sin recodificar.
 *
 * Solo H.264 de 8 bits y 4:2:0: es lo que mpegts.js y Chromium decodifican de
 * forma fiable. HEVC, AV1, VP9, MPEG-4 y H.264 de 10 bits (Hi10P) se recodifican
 * a H.264; copiarlos era la causa de que muchos MKV terminasen con el error
 * "el formato MPEG-TS no es compatible".
 */
export function isVideoCopyable(codec: string, pixFmt = ''): boolean {
  if (codec !== 'h264') return false
  const fmt = pixFmt.toLowerCase()
  if (!fmt) return false
  return ['yuv420p', 'yuvj420p', 'nv12'].includes(fmt)
}

/** Contenedores que Chromium demuxa de forma nativa. */
export function isContainerNative(container: string): boolean {
  return ['matroska', 'webm', 'mpegts', 'mov', 'mp4', 'm4a', 'mj2', '3gp', '3g2', 'ogg', 'wav', 'flac', 'adts', 'mp3', 'aac', 'caf', 'm4v'].includes(container)
}

/** Vídeo que Chromium reproduce sin recodificar (si el contenedor lo permite). */
export function isVideoDirect(codec: string, pixFmt = ''): boolean {
  const fmt = pixFmt.toLowerCase()
  const eightBit420 = ['h264', 'hevc'].includes(codec) && ['yuv420p', 'yuvj420p', 'nv12'].includes(fmt)
  const modern = ['vp8', 'vp9', 'av1'].includes(codec)
  return eightBit420 || modern
}

/**
 * Extrae la cabecera de un stream (contenedor, códecs y duración) con ffmpeg.
 * Corta en cuanto ffmpeg ha escrito la lista de streams del Input.
 */
export function probeStream(srcUrl: string, timeoutMs = 45000): Promise<StreamProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    let proc: ChildProcess | null = null
    let stderr = ''
    const finish = (result: StreamProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc?.kill()
      } catch {
        /* ya muerto */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish(parseHeader(stderr)), timeoutMs)
    try {
      proc = spawn(
        ffmpegBinary(),
        ['-hide_banner', '-nostdin', '-i', srcUrl, '-t', '8', '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      return
    }
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // La lista de streams llega junta: con una línea de Audio (y la cabecera
      // Input/Duration ya escritas) podemos analizar y cortar.
      if (/: Audio:/.test(stderr) && (/Duration:/.test(stderr) || /: Video:/.test(stderr))) {
        finish(parseHeader(stderr))
      }
    })
    proc.on('error', (error) => finish({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    proc.on('close', () => finish(parseHeader(stderr)))

    function parseHeader(text: string): StreamProbeResult {
      const container = /Input #\d+, ([a-z0-9_]+),/i.exec(text)?.[1]?.toLowerCase()
      const lines = text.split('\n')
      const videos: string[] = []
      const audios: string[] = []
      let videoPixFmt = ''
      let duration = 0
      for (const line of lines) {
        const durationMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(line)
        if (durationMatch) {
          duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
          continue
        }
        if (line.includes('attached pic')) continue // miniaturas embebidas, no son vídeo real
        const streamMatch = /Stream #\d+:\d+.*?: (Video|Audio): ([\w]+)/.exec(line)
        if (!streamMatch) continue
        const codec = streamMatch[2].toLowerCase()
        if (streamMatch[1] === 'Video') {
          if (['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(codec)) continue
          videos.push(codec)
          if (!videoPixFmt) {
            // "Video: h264 (High 10), yuv420p10le(tv, ...)" -> yuv420p10le
            const pix = /Video: [\w]+(?: \([^)]*\))?, ([\w]+)/.exec(line)
            if (pix) videoPixFmt = pix[1].toLowerCase()
          }
        } else {
          audios.push(codec)
        }
      }
      if (!container && videos.length === 0 && audios.length === 0) {
        return { ok: false, reason: tail(text) || 'no se pudo analizar el fichero' }
      }
      return { ok: true, container, video: videos[0], videoPixFmt, audio: audios[0], duration: Math.round(duration) }
    }

    function tail(text: string): string {
      return text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
    }
  })
}

/** Levanta (una vez) el servidor HTTP local que reparte los flujos convertidos. */
async function ensureServer(): Promise<number> {
  if (server?.listening) return serverPort
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = http.createServer(handleRequest)
  await new Promise<void>((resolve) => {
    server?.once('error', () => resolve())
    server?.listen(0, '127.0.0.1', () => resolve())
  })
  if (!server.listening) return 0
  serverPort = (server.address() as AddressInfo).port
  return serverPort
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.on('error', () => undefined)
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith('/t/')) {
    res.writeHead(404).end('Not found')
    return
  }
  const session = sessions.get(url.pathname.slice(3))
  if (!session) {
    res.writeHead(404).end('Sesión de conversión no encontrada')
    return
  }
  if (session.exited) {
    res.writeHead(502).end('La conversión terminó inesperadamente')
    return
  }
  const out = session.proc.stdout
  if (!out) {
    res.writeHead(502).end('La conversión no produce salida')
    return
  }

  session.res?.destroy()
  session.res = res
  if (session.idle) {
    clearTimeout(session.idle)
    session.idle = null
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })

  if (out.readableEnded || session.proc.exitCode !== null) {
    res.end()
    return
  }

  out.unpipe()
  out.pipe(res)

  res.on('close', () => {
    try {
      out.unpipe(res)
    } catch {
      /* el proceso ya no existe */
    }
    if (session.res === res) session.res = null
    if (!session.res && session.proc.exitCode === null && !session.idle) {
      // Si nadie reconecta en 3 s (cambio de canal, salto en el tiempo, cierre
      // del reproductor), matamos el ffmpeg para no gastar CPU ni red.
      session.idle = setTimeout(() => killSession(session.id), 3000)
    }
  })
}

function killSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  if (session.idle) clearTimeout(session.idle)
  try {
    session.proc.kill()
  } catch {
    /* ya muerto */
  }
}

/**
 * Convierte un stream/fichero (por ejemplo un vídeo de un torrent servido por
 * el servidor local) en MPEG-TS en vivo con audio AAC. Vídeo copiado si es
 * decodificable, H.264 si no. El ritmo lo marca el consumidor (-re), como una
 * emisión en directo: sin saltos de tiempo, pero con sonido garantizado.
 */
export async function transcodeStream(srcUrl: string, fullTranscode = false, startSeconds = 0): Promise<TranscodeResult> {
  const port = await ensureServer()
  if (!port) return { ok: false, reason: 'No se pudo abrir el servidor local de conversión.' }

  const id = randomBytes(6).toString('hex')
  // Sin `-re`: para una película conviene producir tan rápido como el
  // reproductor consuma. mpegts.js deja de pedir datos cuando tiene suficiente
  // búfer (ver lazyLoad), la tubería se llena y ffmpeg se detiene, así que no
  // se descarga la película entera de golpe. Con `-re` el primer fotograma
  // tardaba más de 10 s porque el búfer inicial se llenaba a ritmo real.
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin']
  // Salto en el tiempo: `-ss` antes de `-i` hace un seek rápido en la fuente
  // (el servidor de torrents responde con Range) y el flujo nuevo empieza a
  // emitirse desde ahí. El reproductor suma este desfase a su cronómetro.
  if (startSeconds > 0) args.push('-ss', startSeconds.toFixed(3))
  args.push('-i', srcUrl, '-sn', '-dn')
  if (fullTranscode) {
    // HEVC/AV1/VP9/Hi10P y contenedores exóticos: H.264 de 8 bits, que es lo
    // que mpegts.js reproduce siempre. Se limita a 1080p para que un 4K no
    // sature la CPU; si la fuente es menor, se conserva su tamaño.
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-vf', "scale=w='min(1920,iw)':h=-2",
      '-max_muxing_queue_size', '4096',
    )
  } else {
    args.push('-c:v', 'copy')
  }
  args.push(
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '192k',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-flush_packets', '1',
    '-f', 'mpegts',
    'pipe:1',
  )

  let proc: ChildProcess
  try {
    proc = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  const session: TranscodeSession = { id, proc, res: null, idle: null, stderrTail: '', exited: false }
  sessions.set(id, session)
  proc.stderr?.on('data', (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString()).slice(-2000)
  })
  proc.stdout?.on('error', () => undefined)
  proc.on('close', (code) => {
    session.exited = true
    if (session.idle) {
      clearTimeout(session.idle)
      session.idle = null
    }
    if (session.res && !session.res.destroyed) {
      session.res.end()
      session.res = null
    }
    sessions.delete(id)
    if (code !== 0 && code !== null) {
      console.warn(`[SquizanTV] conversión terminada con código ${code}: ${session.stderrTail.slice(-300)}`)
    }
  })

  // Si ffmpeg muere nada más arrancar (fichero corrupto o sin datos), fallamos
  // en vez de dar una URL vacía al reproductor. En cuanto sale el primer bloque
  // devolvemos la URL: así el vídeo empieza sin esperas artificiales.
  const earlyExit = await new Promise<string | null>((resolve) => {
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(wait)
      proc.removeListener('close', onClose)
      proc.stdout?.removeListener('readable', onData)
      resolve(value)
    }
    const onData = () => done(null)
    const onClose = (code: number | null) =>
      done(code === null ? null : session.stderrTail.slice(-300) || `ffmpeg salió con código ${code}`)
    const wait = setTimeout(() => done(null), 1200)
    // `readable` deja los datos en el búfer. Con `data` el stream pasaría a
    // modo flowing y se perderían los bloques anteriores a la petición HTTP.
    proc.stdout?.once('readable', onData)
    proc.once('close', onClose)
  })
  if (earlyExit !== null) {
    sessions.delete(id)
    return { ok: false, reason: earlyExit }
  }

  return { ok: true, url: `http://127.0.0.1:${port}/t/${id}` }
}

/** Mata todas las conversiones activas (al cerrar la app). */
export function disposeTranscodes(): void {
  for (const id of [...sessions.keys()]) killSession(id)
  if (server) {
    server.close()
    server = null
    serverPort = 0
  }
}
