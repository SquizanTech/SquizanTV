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
 * Chromium/Electron no decodifica Dolby (AC-3/E-AC-3), DTS ni TrueHD, y no
 * demuxa contenedores como AVI. VLC sí. Para que un magnet "suenec" dentro de
 * Nova, si el audio no es soportado lo convertimos a AAC en caliente (copiando
 * el vídeo tal cual) y lo servimos como MPEG-TS en vivo por HTTP local, que el
 * reproductor MPEG-TS de la app ya sabe consumir.
 */

export interface StreamProbeResult {
  ok: boolean
  container?: string
  video?: string
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

/** Códecs de vídeo que podemos copiar sin recodificar (el resto va a H.264). */
export function isVideoCopyable(codec: string): boolean {
  return ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg1video', 'mpeg2video', 'mpeg4'].includes(codec)
}

/** Contenedores que Chromium demuxa de forma nativa. */
export function isContainerNative(container: string): boolean {
  return ['matroska', 'webm', 'mpegts', 'mov', 'mp4', 'm4a', 'mj2', '3gp', '3g2', 'ogg', 'wav', 'flac', 'adts', 'mp3', 'aac', 'caf', 'm4v'].includes(container)
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
          if (!['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(codec)) videos.push(codec)
        } else {
          audios.push(codec)
        }
      }
      if (!container && videos.length === 0 && audios.length === 0) {
        return { ok: false, reason: tail(text) || 'no se pudo analizar el fichero' }
      }
      return { ok: true, container, video: videos[0], audio: audios[0], duration: Math.round(duration) }
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
      // Si nadie reconecta en 8 s (cambio de canal, cierre del reproductor),
      // matamos el ffmpeg para no gastar CPU ni red.
      session.idle = setTimeout(() => killSession(session.id), 8000)
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
export async function transcodeStream(srcUrl: string, fullTranscode = false): Promise<TranscodeResult> {
  const port = await ensureServer()
  if (!port) return { ok: false, reason: 'No se pudo abrir el servidor local de conversión.' }

  const id = randomBytes(6).toString('hex')
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-i', srcUrl, '-sn', '-dn']
  if (fullTranscode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23')
  else args.push('-c:v', 'copy')
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1')

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
      console.warn(`[NovaTV] conversión terminada con código ${code}: ${session.stderrTail.slice(-300)}`)
    }
  })

  // Si ffmpeg muere nada más arrancar (fichero corrupto o sin datos), fallamos
  // en vez de dar una URL vacía al reproductor.
  const earlyExit = await new Promise<string | null>((resolve) => {
    const done = (value: string | null) => {
      clearTimeout(wait)
      proc.removeListener('close', onClose)
      resolve(value)
    }
    const onClose = (code: number | null) => done(code === null ? null : session.stderrTail.slice(-300) || `ffmpeg salió con código ${code}`)
    const wait = setTimeout(() => done(null), 2500)
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
