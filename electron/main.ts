import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { disposeTorrents, registerTorrentIpc } from './torrent'
import { disposeTranscodes, probeStream, transcodeStream, type StreamProbeResult } from './transcode'

const gunzipAsync = promisify(gunzip)

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

// Autoplay con sonido: sin este switch Chromium puede bloquear el audio
// hasta que el usuario interactúe, y el reproductor arrancaría mudo.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const dataDir = app.getPath('userData')
const dbPath = path.join(dataDir, 'novatv.json')

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0c11',
    show: false,
    autoHideMenuBar: true,
    title: 'NovaTV',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => win?.show())

  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL as string)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })
}

const emptyDb = {
  version: 1,
  playlists: [],
  favorites: [],
  history: [],
  settings: {
    theme: 'dark',
    volume: 1,
    updateFeed: '',
    epgAutoRefresh: true,
  },
  activePlaylist: null,
}

async function readDb(): Promise<unknown> {
  try {
    const raw = await fs.readFile(dbPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return emptyDb
  }
}

async function writeDb(data: unknown): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const tmp = `${dbPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
  await fs.rename(tmp, dbPath)
}

/** Busca VLC en las rutas tipicas de Windows. */
function findExternalPlayer(): string {
  const candidates = [
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'mpv', 'mpv.exe'),
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? ''
}

function registerIpc(): void {
  ipcMain.handle('db:read', () => readDb())
  ipcMain.handle('db:write', async (_event, data: unknown) => {
    await writeDb(data)
    return true
  })

  ipcMain.handle(
    'net:fetch',
    async (
      _event,
      req: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number },
    ) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), req.timeout ?? 30000)
      try {
        const res = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers: req.headers,
          body: req.body,
          redirect: 'follow',
          signal: controller.signal,
        })
        let buffer = Buffer.from(await res.arrayBuffer())
        // Muchos proveedores publican el XMLTV como .gz sin cabecera Content-Encoding.
        if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
          buffer = await gunzipAsync(buffer)
        }
        let text = buffer.toString('utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          text,
          contentType: res.headers.get('content-type') ?? '',
        }
      } catch (error) {
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : String(error),
          text: '',
          contentType: '',
        }
      } finally {
        clearTimeout(timer)
      }
    },
  )

  ipcMain.handle('dialog:openPlaylist', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Abrir lista M3U / XMLTV',
      properties: ['openFile'],
      filters: [
        { name: 'Listas IPTV', extensions: ['m3u', 'm3u8', 'xspf', 'xml', 'xmltv'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const file = result.filePaths[0]
    try {
      const content = await fs.readFile(file, 'utf8')
      return { path: file, name: path.basename(file), content }
    } catch {
      return null
    }
  })

  ipcMain.handle('app:version', () => app.getVersion())

  // Sondea los primeros paquetes de un MPEG-TS y devuelve los tipos de stream
  // de la PMT. Sirve para detectar audio AC-3/E-AC-3, que Chromium no decodifica.
  ipcMain.handle('media:probeTs', async (_event, url: string) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'NovaTV/0.3.2' },
      })
      clearTimeout(timer)
      if (!res.ok || !res.body) return { ok: false, reason: `http ${res.status}` }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      const target = 188 * 40
      while (total < target) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
      }
      try {
        await reader.cancel()
      } catch {
        /* el stream puede cerrarse solo tras abortar */
      }
      controller.abort()
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      return { ok: true, ts: looksLikeTs(buf), audio: probeTsAudio(buf), video: hasTsVideo(buf) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  // Sonda de contenedor/códecs con el ffmpeg empaquetado (ficheros de torrent,
  // MKV con Dolby/DTS, AVI…). Decide si se puede reproducir directo o conviene
  // convertir el audio a AAC para que se oiga en el reproductor interno.
  ipcMain.handle('media:probeStream', async (_event, url: string): Promise<StreamProbeResult> => {
    return probeStream(url)
  })

  ipcMain.handle('media:transcodeStream', async (_event, url: string, fullTranscode?: boolean) => {
    return transcodeStream(url, Boolean(fullTranscode))
  })

  ipcMain.handle('app:openExternal', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle('app:openDataFolder', () => shell.openPath(dataDir))
  ipcMain.handle('media:openSubtitle', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Abrir subtítulos (SRT, VTT, ASS)',
      properties: ['openFile'],
      filters: [
        { name: 'Subtítulos', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sub', 'txt'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const file = result.filePaths[0]
    try {
      const buffer = await fs.readFile(file)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
      } catch {
        try {
          text = new TextDecoder('windows-1252').decode(buffer)
        } catch {
          text = buffer.toString('utf8')
        }
      }
      return { name: path.basename(file), data: text }
    } catch {
      return null
    }
  })
  ipcMain.handle('app:externalPlayer', () => findExternalPlayer())
  ipcMain.handle('app:openExternalPlayer', (_event, url: string) => {
    const player = findExternalPlayer()
    if (!player) return { ok: false, message: 'No se encontró VLC ni mpv en el equipo.' }
    if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url)) {
      return { ok: false, message: 'Solo se pueden abrir fuentes locales de NovaTV.' }
    }
    try {
      const child = spawn(player, [url], { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, player: path.basename(player, '.exe') }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'No se pudo abrir el reproductor.' }
    }
  })

  ipcMain.handle('updates:check', async (_event, feedUrl?: string) => {
    if (!app.isPackaged) {
      return { ok: false, message: 'Las actualizaciones solo funcionan en la version instalada (.exe).' }
    }
    if (feedUrl && feedUrl.trim()) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl.trim() })
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo.version ?? app.getVersion() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('updates:install', () => {
    autoUpdater.quitAndInstall(false, true)
  })
}

function registerUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const send = (payload: unknown) => win?.webContents.send('updates:event', payload)
  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => send({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send({ type: 'none' }))
  autoUpdater.on('download-progress', (p) => send({ type: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => send({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => send({ type: 'error', message: err.message }))
}

app.whenReady().then(() => {
  registerIpc()
  registerTorrentIpc()
  registerUpdater()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  disposeTorrents()
  disposeTranscodes()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ---------- Sonda de códecs de un MPEG-TS ---------- */

/** True si el buffer parece MPEG-TS (≥5 paquetes seguidos con sincronía 0x47 a saltos de 188). */
function looksLikeTs(buf: Buffer): boolean {
  if (buf.length < 188 * 5) return false
  let run = 0
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) {
      run = 0
      continue
    }
    run += 1
    if (run >= 5) return true
  }
  return false
}

/** Tipos de stream audio reconocidos en la PMT (pid 0x81 AC-3, 0x0F/0x11 AAC, 0x03/0x04 MP3…). */
function probeTsAudio(buf: Buffer): string | null {
  const found = pmtStreamTypes(buf)
  if (found.some((t) => t === 'ac3')) return 'ac3'
  if (found.some((t) => t === 'aac')) return 'aac'
  if (found.some((t) => t === 'mp3')) return 'mp3'
  return null
}

function hasTsVideo(buf: Buffer): boolean {
  return pmtStreamTypes(buf).some((t) => t === 'video')
}

function pmtStreamTypes(buf: Buffer): string[] {
  const types: string[] = []
  const pmtPids = new Set<number>()
  let pmtSeen = false
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) break
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]
    const afc = (buf[i + 3] >> 4) & 3
    let p = i + 4
    if (afc & 2) p += 1 + buf[i + 4]
    if (!(afc & 1) || p >= i + 188) continue
    // Los paquetes PSI llevan pointer_field; la tabla empieza detrás.
    const pointer = buf[p]
    const start = p + 1 + pointer
    if (start + 3 > i + 188) continue
    const tableId = buf[start]
    if (tableId === 0x00 && pid === 0) {
      // PAT: apunta a los PMT de cada programa.
      const sectionLen = ((buf[start + 1] & 0x0f) << 8) | buf[start + 2]
      let q = start + 8
      const end = Math.min(start + 3 + sectionLen - 4, i + 188)
      while (q + 4 <= end) {
        const program = (buf[q] << 8) | buf[q + 1]
        const pmtPid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3]
        if (program !== 0 && pmtPid !== 0) pmtPids.add(pmtPid)
        q += 4
      }
      continue
    }
    if (tableId === 0x02 && pmtPids.has(pid)) {
      pmtSeen = true
      const sectionLen = ((buf[start + 1] & 0x0f) << 8) | buf[start + 2]
      const infoLen = ((buf[start + 10] & 0x0f) << 8) | buf[start + 11]
      let q = start + 12 + infoLen
      const end = Math.min(start + 3 + sectionLen - 4, i + 188, buf.length)
      while (q + 5 <= end) {
        const streamType = buf[q]
        const esLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4]
        if (streamType === 0x81 || streamType === 0x83 || streamType === 0x7f || streamType === 0x06) types.push('ac3')
        else if (streamType === 0x0f || streamType === 0x11 || streamType === 0x1c || streamType === 0x2d) types.push('aac')
        else if (streamType === 0x03 || streamType === 0x04) types.push('mp3')
        else if (streamType === 0x1b || streamType === 0x24 || streamType === 0x27 || streamType === 0x21) types.push('video')
        else types.push(`0x${streamType.toString(16)}`)
        q += 5 + esLen
      }
    }
  }
  if (!pmtSeen && types.length === 0) types.push('desconocido')
  return [...new Set(types)]
}
