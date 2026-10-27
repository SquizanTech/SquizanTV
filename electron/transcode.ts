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
  srcUrl: string
  proc: ChildProcess
  res: http.ServerResponse | null
  idle: NodeJS.Timeout | null
  stderrTail: string
  exited: boolean
  /**
   * Ultimos bloques producidos por ffmpeg. mpegts.js corta la conexion cuando
   * ya tiene 60 s de bufer y la reabre despues con `Range: bytes=N-` desde la
   * posicion que aun no habia consumido. Sin estos bloques el servidor no
   * podria contestar a esa peticion (antes respondia 404 y el reproductor
   * mostraba el aviso de error).
   */
  chunks: Buffer[]
  /** Offset absoluto del primer byte de `chunks[0]` dentro del flujo TS. */
  start: number
  /** Offset absoluto tras el ultimo byte recibido de ffmpeg. */
  end: number
  /** Siguiente byte que hay que enviar por `res`. */
  sent: number
  /** Ultimo byte (sin incluirlo) que pidio el cliente; Infinity si es abierto. */
  limit: number
  /** `res` no acepta mas datos ahora mismo (contrapresion). */
  blocked: boolean
}

/**
 * Bytes que se guardan de cada conversion para poder reanudarla.
 *
 * mpegts.js guarda como maximo 8 MB de datos sin consumir, asi que con 24 MB
 * hay margen de sobra para contestar al `Range` de reconexion con los bytes
 * exactos que pide.
 */
const RETAIN_BYTES = 24 * 1024 * 1024

/**
 * Tiempo que se mantiene viva una conversion sin ningun reproductor conectado.
 *
 * mpegts.js pausa la conexion al llenar el bufer y la reanuda unos 45 s
 * despues; hay que esperar mas que eso para no matar ffmpeg justo antes de que
 * vuelva a pedir datos.
 */
const IDLE_KILL_MS = 90_000

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

/** Elimina de la retencion los bytes anteriores a `offset`. */
function dropBefore(session: TranscodeSession, offset: number): void {
  while (session.chunks.length > 0 && session.start + session.chunks[0].length <= offset) {
    session.start += session.chunks[0].length
    session.chunks.shift()
  }
  if (session.chunks.length > 0 && session.start < offset) {
    const skip = offset - session.start
    session.chunks[0] = session.chunks[0].subarray(skip)
    session.start = offset
  }
}

/** Libera los bloques mas antiguos que ya no hacen falta para reconectar. */
function trimRetention(session: TranscodeSession): void {
  const keepFrom = session.res ? Math.min(session.sent, session.end - RETAIN_BYTES) : session.end - RETAIN_BYTES
  if (keepFrom > session.start) dropBefore(session, keepFrom)
}

/** Bloques que cubren [from, to) del flujo convertido. */
function readRange(session: TranscodeSession, from: number, to: number): Buffer[] {
  const pieces: Buffer[] = []
  let offset = session.start
  for (const chunk of session.chunks) {
    if (offset >= to) break
    const chunkEnd = offset + chunk.length
    if (chunkEnd > from) {
      const begin = Math.max(0, from - offset)
      pieces.push(chunk.subarray(begin, Math.min(chunk.length, to - offset)))
    }
    offset = chunkEnd
  }
  return pieces
}

/** Envia a la respuesta actual todo lo que haya disponible. */
function flushSession(session: TranscodeSession): void {
  const res = session.res
  if (!res || res.destroyed || session.blocked) return
  const to = Math.min(session.end, session.limit)
  if (session.sent >= session.limit) {
    if (!res.writableEnded) res.end()
    session.res = null
    session.sent = session.end
    session.limit = Infinity
    session.proc.stdout?.pause()
    scheduleIdleKill(session)
    return
  }
  if (session.sent >= to) return
  for (const piece of readRange(session, session.sent, to)) {
    session.sent += piece.length
    if (!res.write(piece)) {
      // El reproductor no puede absorber mas ahora mismo: se deja de leer de
      // ffmpeg hasta que la respuesta se vacie. Asi la tuberia hace de freno.
      session.blocked = true
      session.proc.stdout?.pause()
      return
    }
  }
}

function scheduleIdleKill(session: TranscodeSession): void {
  if (session.idle) clearTimeout(session.idle)
  session.idle = setTimeout(() => killSession(session), IDLE_KILL_MS)
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

  // Una peticion nueva de la misma pelicula (un salto en el tiempo) deja
  // obsoletas las conversiones anteriores. Se cierran en cuanto la nueva
  // empieza a consumirse, no antes, para no cortar el fotograma en pantalla.
  for (const [otherId, other] of sessions) {
    if (otherId !== session.id && other.srcUrl === session.srcUrl) killSession(other)
  }

  // mpegts.js reabre el flujo con el byte exacto que aun no habia consumido.
  // Antes se ignoraba y se respondia desde donde estuviera ffmpeg (o 404 si ya
  // se habia matado), que es lo que rompia la reproduccion.
  const match = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null
  const startAt = match && match[1] ? Number(match[1]) : 0
  const limit = match && match[2] ? Number(match[2]) + 1 : Infinity

  if (!Number.isFinite(startAt) || startAt < session.start) {
    // Ya no se conservan esos bytes (pausa muy larga): que el reproductor
    // reinicie la conversion en el segundo actual.
    res.writeHead(410).end('La conversión ya no conserva ese fragmento')
    return
  }
  if (startAt > 0) {
    console.info(`[SquizanTV] conversión reanudada en el byte ${startAt}`)
  }

  session.res?.destroy()
  session.res = res
  session.sent = startAt
  session.limit = limit
  session.blocked = false
  if (session.idle) {
    clearTimeout(session.idle)
    session.idle = null
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })

  res.on('close', () => {
    if (session.res !== res) return
    session.res = null
    session.sent = session.end
    session.limit = Infinity
    session.blocked = false
    out.pause()
    scheduleIdleKill(session)
  })
  res.on('drain', () => {
    if (session.res !== res) return
    session.blocked = false
    flushSession(session)
    if (!session.blocked && session.res === res) out.resume()
  })

  flushSession(session)
  if (!session.blocked && session.res === res) out.resume()
}

function killSession(session: TranscodeSession): void {
  if (!sessions.has(session.id)) return
  sessions.delete(session.id)
  if (session.idle) clearTimeout(session.idle)
  session.chunks = []
  try {
    session.res?.destroy()
  } catch {
    /* ya cerrada */
  }
  try {
    session.proc.kill()
  } catch {
    /* ya muerto */
  }
}

/**
 * Convierte un stream/fichero (por ejemplo un vídeo de un torrent servido por
 * el servidor local) en MPEG-TS con audio AAC. Vídeo copiado si es
 * decodificable, H.264 si no. Se produce tan rápido como el reproductor
 * consuma; si mpegts.js corta la conexión al llenar su búfer, la conversión se
 * mantiene viva y se reanuda por el byte exacto que pide al reconectar.
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

  const session: TranscodeSession = {
    id,
    srcUrl,
    proc,
    res: null,
    idle: null,
    stderrTail: '',
    exited: false,
    chunks: [],
    start: 0,
    end: 0,
    sent: 0,
    limit: Infinity,
    blocked: false,
  }
  sessions.set(id, session)

  proc.stderr?.on('data', (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString()).slice(-2000)
  })

  const out = proc.stdout
  if (!out) {
    killSession(session)
    return { ok: false, reason: 'ffmpeg no produce salida' }
  }
  out.on('error', () => undefined)

  // Se lee siempre la salida de ffmpeg y se guarda en la retencion: asi una
  // reconexion de mpegts puede continuar exactamente por el byte que pide.
  let markStarted: (() => void) | null = null
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  out.on('data', (chunk: Buffer) => {
    if (markStarted) {
      markStarted()
      markStarted = null
    }
    session.chunks.push(chunk)
    session.end += chunk.length
    trimRetention(session)
    flushSession(session)
  })

  proc.on('close', (code) => {
    session.exited = true
    if (session.idle) {
      clearTimeout(session.idle)
      session.idle = null
    }
    const res = session.res
    if (res && !res.destroyed) {
      // Ultimo tramo: se vacia la retencion y se cierra la respuesta para que
      // mpegts marque el final de la pelicula.
      session.blocked = false
      session.sent = Math.min(session.sent, session.end)
      for (const piece of readRange(session, session.sent, session.end)) res.write(piece)
      res.end()
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
      resolve(value)
    }
    const onClose = (code: number | null) =>
      done(code === null ? null : session.stderrTail.slice(-300) || `ffmpeg salió con código ${code}`)
    const wait = setTimeout(() => done(null), 1200)
    void started.then(() => done(null))
    proc.once('close', onClose)
  })
  if (earlyExit !== null) {
    killSession(session)
    return { ok: false, reason: earlyExit }
  }

  return { ok: true, url: `http://127.0.0.1:${port}/t/${id}` }
}

/** Mata todas las conversiones activas (al cerrar la app). */
export function disposeTranscodes(): void {
  for (const session of [...sessions.values()]) killSession(session)
  if (server) {
    server.close()
    server = null
    serverPort = 0
  }
}
