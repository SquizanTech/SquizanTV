import http from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AddTorrentResult, TorrentFileInfo, TorrentSnapshot } from '../src/types'

/**
 * Servicio de torrents del proceso principal.
 *
 * No depende de Electron a proposito: recibe la carpeta de descarga y usa
 * webtorrent como cliente BitTorrent (DHT + trackers TCP/UDP). Para reproducir,
 * expone cada archivo por un servidor HTTP local con soporte de `Range`, que es
 * lo que permite al <video> hacer streaming y saltar en el tiempo.
 */

interface WebTorrentFile {
  name: string
  length: number
  offset: number
  progress: number
  select: (priority?: number) => void
  deselect: () => void
  createReadStream: (opts?: { start?: number; end?: number }) => NodeJS.ReadableStream
}

interface WebTorrentTorrent {
  infoHash: string
  name: string
  magnetURI: string
  pieceLength: number
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  numPeers: number
  timeRemaining: number
  ready: boolean
  destroyed: boolean
  files: WebTorrentFile[]
  select: (start: number, end: number, priority?: number) => void
  deselect: (start: number, end: number, priority?: number) => void
  on: (event: string, cb: (...args: unknown[]) => void) => void
  destroy: (opts?: unknown, cb?: () => void) => void
}

interface WebTorrentClient {
  add: (source: string | Buffer, opts?: Record<string, unknown>) => WebTorrentTorrent
  get: (id: string | Buffer) => WebTorrentTorrent | null
  remove: (torrent: WebTorrentTorrent, cb?: () => void) => void
  destroy: (cb?: () => void) => void
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

type WebTorrentConstructor = new (opts?: Record<string, unknown>) => WebTorrentClient

interface Session {
  id: string
  source: string
  torrent: WebTorrentTorrent
  token: string
  server: http.Server | null
  port: number
  timer: NodeJS.Timeout | null
  metadataTimer: NodeJS.Timeout | null
  error: string
  createdAt: number
}

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'mov',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'ogv',
  'ogg',
  'flv',
  'wmv',
  '3gp',
])

const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])
const NFO_EXTENSIONS = new Set(['nfo', 'txt', 'md'])

/** Tamano maximo de una respuesta abierta: mantiene la descarga secuencial. */
const RANGE_CHUNK = 16 * 1024 * 1024
/** Bytes que se preparan al recibir los metadatos para que el play sea instantaneo. */
const PREBUFFER_BYTES = 3 * 1024 * 1024

/**
 * bittorrent-dht trae una lista de bootstrap que en la practica deja la tabla
 * con un solo nodo; con estos routers se llena en segundos y el torrent
 * encuentra pares por DHT aunque los trackers fallen.
 */
const DHT_BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
  'dht.libtorrent.org:25401',
  'dht.aelitis.com:6881',
]

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  ssa: 'text/plain; charset=utf-8',
  sub: 'text/plain; charset=utf-8',
}

export function extensionOf(name: string): string {
  const clean = name.split('?')[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

export function kindOf(name: string): TorrentFileInfo['kind'] {
  const ext = extensionOf(name)
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (NFO_EXTENSIONS.has(ext)) return 'nfo'
  return 'other'
}

function contentTypeFor(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream'
}

function decodeText(buffer: Buffer, maxBytes: number): string {
  const slice = buffer.subarray(0, Math.min(buffer.length, maxBytes))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice).replace(/^\uFEFF/, '')
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(slice)
    } catch {
      return slice.toString('utf8')
    }
  }
}

function magnetName(source: string): string {
  if (!/^magnet:\?/i.test(source)) return path.basename(source).replace(/\.torrent$/i, '')
  try {
    const query = source.slice(source.indexOf('?') + 1)
    return new URLSearchParams(query).get('dn') ?? ''
  } catch {
    return ''
  }
}

function bareHashToMagnet(value: string): string | null {
  if (/^[a-f0-9]{40}$/i.test(value)) return `magnet:?xt=urn:btih:${value.toLowerCase()}`
  if (/^[a-f0-9]{64}$/i.test(value)) return `magnet:?xt=urn:btmh:1220${value.toLowerCase()}`
  return null
}

async function directorySize(dir: string): Promise<number> {
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += await directorySize(full)
      else if (entry.isFile()) total += (await fs.stat(full)).size
    }
  } catch {
    return 0
  }
  return total
}

export class TorrentService extends EventEmitter {
  private readonly downloadDir: string
  private readonly clientFactory: () => WebTorrentClient
  private client: WebTorrentClient | null = null
  private readonly sessions = new Map<string, Session>()

  constructor(downloadDir: string, clientFactory?: () => WebTorrentClient) {
    super()
    this.downloadDir = downloadDir
    this.clientFactory =
      clientFactory ??
      (() => {
        // webtorrent 1.x es CommonJS; se carga aparte del bundle (external).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebTorrent = require('webtorrent') as WebTorrentConstructor
        return new WebTorrent({
          maxConns: 150,
          dht: { bootstrap: DHT_BOOTSTRAP },
          tracker: true,
          utp: false,
        })
      })
  }

  private ensureClient(): WebTorrentClient {
    if (this.client) return this.client
    const client = this.clientFactory()
    client.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.emit('client-error', message)
    })
    this.client = client
    return client
  }

  /** Arranca el cliente (y su DHT) antes de que el usuario anada un torrent. */
  warmUp(): void {
    try {
      this.ensureClient()
    } catch {
      /* se reintenta al anadir */
    }
  }

  async add(raw: string): Promise<AddTorrentResult> {
    const value = raw.trim()
    if (!value) return { ok: false, message: 'Pega un enlace magnet o abre un archivo .torrent.' }

    let source: string | Buffer = value
    const bare = bareHashToMagnet(value)
    if (bare) {
      source = bare
    } else if (!/^magnet:\?/i.test(value)) {
      // Un .torrent se lee en memoria: asi podemos detectar duplicados sin
      // depender de la ruta y funciona igual con el selector de archivos.
      const content = await fs.readFile(value).catch(() => null)
      if (!content) {
        return { ok: false, message: 'El texto no es un enlace magnet válido ni un archivo .torrent existente.' }
      }
      source = content
    }

    await fs.mkdir(this.downloadDir, { recursive: true })

    const client = this.ensureClient()

    // WebTorrent destruye el torrent nuevo y emite un error si el infoHash ya
    // existe; es mejor devolver la sesion que ya esta en la lista.
    let existingTorrent: WebTorrentTorrent | null = null
    try {
      existingTorrent = client.get(source)
    } catch {
      existingTorrent = null
    }
    if (existingTorrent) {
      const existing = Array.from(this.sessions.values()).find(
        (session) => session.torrent === existingTorrent || session.torrent.infoHash === existingTorrent.infoHash,
      )
      if (existing) {
        return {
          ok: true,
          id: existing.id,
          duplicate: true,
          message: 'Ese torrent ya está en la lista.',
        }
      }
    }

    let torrent: WebTorrentTorrent
    try {
      torrent = client.add(source, { path: this.downloadDir })
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'No se pudo añadir el torrent.',
      }
    }

    const id = randomBytes(6).toString('hex')
    const session: Session = {
      id,
      source: typeof source === 'string' ? source : value,
      torrent,
      token: randomBytes(10).toString('hex'),
      server: null,
      port: 0,
      timer: null,
      metadataTimer: null,
      error: '',
      createdAt: Date.now(),
    }
    this.sessions.set(id, session)

    torrent.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      session.error = /duplicate torrent/i.test(message) ? 'Ese torrent ya está en la lista.' : message
      this.emitUpdate(session)
    })

    torrent.on('warning', () => {
      /* avisos de tracker: no rompen la reproduccion */
    })

    const onReady = () => {
      if (session.metadataTimer) {
        clearTimeout(session.metadataTimer)
        session.metadataTimer = null
      }
      void this.startServer(session)
    }

    if (torrent.ready) onReady()
    else torrent.on('ready', onReady)
    torrent.on('metadata', onReady)

    session.metadataTimer = setTimeout(() => {
      if (session.server) return
      session.error =
        'Sin metadatos tras 90 s. Comprueba que el enlace tenga trackers, que el firewall permita UDP/TCP y que el torrent tenga pares.'
      this.emitUpdate(session)
    }, 90_000)

    session.timer = setInterval(() => {
      this.emitUpdate(session)
      if (session.torrent.destroyed) this.stopTimer(session)
    }, 800)

    this.emitUpdate(session)
    return { ok: true, id }
  }

  list(): TorrentSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => this.snapshot(session))
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    this.stopTimer(session)
    if (session.metadataTimer) clearTimeout(session.metadataTimer)
    if (session.server) {
      try {
        session.server.close()
      } catch {
        /* noop */
      }
      session.server = null
    }
    try {
      session.torrent.destroy()
    } catch {
      /* noop */
    }
    this.emit('update', this.list())
    return true
  }

  async clearCache(): Promise<{ ok: boolean; bytes: number }> {
    for (const id of Array.from(this.sessions.keys())) this.remove(id)
    const bytes = await directorySize(this.downloadDir)
    await fs.rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(this.downloadDir, { recursive: true }).catch(() => undefined)
    return { ok: true, bytes }
  }

  /**
   * Lee un archivo de texto pequeno del torrent (tipicamente el .nfo con la
   * sinopsis). No descarga nada si el archivo es demasiado grande.
   */
  async readText(id: string, index: number, maxBytes = 512 * 1024): Promise<string> {
    const session = this.sessions.get(id)
    const file = session?.torrent.files?.[index]
    if (!session || !file || file.length === 0 || file.length > maxBytes * 2) return ''

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let active: NodeJS.ReadableStream | null = null

      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(decodeText(Buffer.concat(chunks), maxBytes))
      }

      timer = setTimeout(() => {
        const destroyable = active as unknown as { destroy?: () => void } | null
        destroyable?.destroy?.()
        finish()
      }, 20_000)

      active = file.createReadStream({
        start: 0,
        end: Math.min(file.length, maxBytes) - 1,
      })
      active.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total <= maxBytes + 64 * 1024) chunks.push(chunk)
      })
      active.on('end', finish)
      active.on('error', finish)
      active.on('close', finish)
    })
  }

  dispose(): void {
    for (const id of Array.from(this.sessions.keys())) this.remove(id)
    if (this.client) {
      try {
        this.client.destroy()
      } catch {
        /* noop */
      }
      this.client = null
    }
  }

  private stopTimer(session: Session): void {
    if (session.timer) {
      clearInterval(session.timer)
      session.timer = null
    }
  }

  private snapshot(session: Session): TorrentSnapshot {
    const { torrent } = session
    const files: TorrentFileInfo[] = (torrent.files ?? []).map((file, index) => ({
      index,
      name: file.name,
      length: file.length,
      progress: Math.round((file.progress ?? 0) * 100),
      kind: kindOf(file.name),
    }))

    return {
      id: session.id,
      name: torrent.name || magnetName(session.source) || 'Obteniendo metadatos…',
      infoHash: torrent.infoHash ?? '',
      progress: Math.round((torrent.progress ?? 0) * 100),
      downloadSpeed: torrent.downloadSpeed ?? 0,
      uploadSpeed: torrent.uploadSpeed ?? 0,
      peers: torrent.numPeers ?? 0,
      timeRemaining: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining : 0,
      ready: Boolean(session.server),
      streamBase:
        session.server && session.port > 0
          ? `http://127.0.0.1:${session.port}/s/${session.token}/`
          : '',
      error: session.error,
      files,
      createdAt: session.createdAt,
    }
  }

  private emitUpdate(session: Session): void {
    this.emit('update', this.snapshot(session))
  }

  private async startServer(session: Session): Promise<void> {
    if (session.server) return

    const server = http.createServer((req, res) => this.handleRequest(session, req, res))
    session.server = server

    await new Promise<void>((resolve) => {
      server.once('error', () => resolve())
      server.listen(0, '127.0.0.1', () => resolve())
    })

    if (!server.listening) {
      session.server = null
      session.error = 'No se pudo abrir el servidor local de reproducción.'
      this.emitUpdate(session)
      return
    }

    session.port = (server.address() as AddressInfo).port
    this.emitUpdate(session)
    this.prebuffer(session)
  }

  /**
   * Descarga los primeros MB del video principal en cuanto hay metadatos, para
   * que al pulsar Reproducir el primer fotograma salga sin esperar a los pares.
   */
  private prebuffer(session: Session): void {
    const pieceLength = session.torrent.pieceLength
    if (!pieceLength) return

    let main: WebTorrentFile | null = null
    for (const file of session.torrent.files ?? []) {
      if (kindOf(file.name) !== 'video') continue
      if (!main || file.length > main.length) main = file
    }
    if (!main) return

    const start = Math.floor(main.offset / pieceLength)
    const end = Math.floor((main.offset + Math.min(main.length, PREBUFFER_BYTES) - 1) / pieceLength)
    try {
      session.torrent.select(start, end, 1)
    } catch {
      /* sin pares todavia */
    }
  }

  private handleRequest(session: Session, req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const prefix = `/s/${session.token}/`
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }

    const index = Number(url.pathname.slice(prefix.length))
    const file = session.torrent.files?.[index]
    if (!file || !Number.isFinite(index)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }

    if (file.length === 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */0' }).end()
      return
    }

    const total = file.length
    const headers: Record<string, string | number> = {
      'Content-Type': contentTypeFor(file.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    }

    const rangeHeader = req.headers.range
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null

    if (match) {
      // `bytes=-N` pide los ultimos N bytes (util para el atomo moov de MP4).
      const suffix = !match[1] && match[2]
      const start = suffix
        ? Math.max(0, total - Number(match[2]))
        : match[1]
          ? Number(match[1])
          : 0
      const requestedEnd = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
      // Un rango abierto (`bytes=N-`) se sirve por bloques: asi WebTorrent solo
      // selecciona la ventana que se esta viendo y descarga en orden, no todo el
      // archivo a la vez en orden aleatorio.
      const end = suffix
        ? total - 1
        : match[2]
          ? requestedEnd
          : Math.min(total - 1, start + RANGE_CHUNK - 1)

      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
        return
      }

      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      })

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const stream = file.createReadStream({ start, end })
      stream.on('error', () => res.destroy())
      res.on('close', () => {
        const destroyable = stream as unknown as { destroy?: () => void }
        destroyable.destroy?.()
      })
      stream.pipe(res)
      return
    }

    res.writeHead(200, { ...headers, 'Content-Length': total })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = file.createReadStream()
    stream.on('error', () => res.destroy())
    res.on('close', () => {
      const destroyable = stream as unknown as { destroy?: () => void }
      destroyable.destroy?.()
    })
    stream.pipe(res)
  }
}
