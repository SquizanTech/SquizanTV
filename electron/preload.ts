import { contextBridge, ipcRenderer } from 'electron'
import type { AddTorrentResult, TorrentSnapshot } from '../src/types'

export type FetchRequest = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
}

const api = {
  db: {
    read: (): Promise<unknown> => ipcRenderer.invoke('db:read'),
    write: (data: unknown): Promise<boolean> => ipcRenderer.invoke('db:write', data),
  },
  net: {
    fetch: (req: FetchRequest): Promise<{
      ok: boolean
      status: number
      statusText: string
      text: string
      contentType: string
    }> => ipcRenderer.invoke('net:fetch', req),
  },
  dialog: {
    openPlaylist: (): Promise<{ path: string; name: string; content: string } | null> =>
      ipcRenderer.invoke('dialog:openPlaylist'),
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:openDataFolder'),
    externalPlayer: (): Promise<string> => ipcRenderer.invoke('app:externalPlayer'),
    openExternalPlayer: (
      url: string,
    ): Promise<{ ok: boolean; player?: string; message?: string }> =>
      ipcRenderer.invoke('app:openExternalPlayer', url),
  },
  media: {
    openSubtitle: (): Promise<{ name: string; data: string } | null> =>
      ipcRenderer.invoke('media:openSubtitle'),
    probeTs: (url: string): Promise<{ ok: boolean; ts?: boolean; audio?: string | null; video?: boolean; reason?: string }> =>
      ipcRenderer.invoke('media:probeTs', url),
    probeStream: (
      url: string,
    ): Promise<{ ok: boolean; container?: string; video?: string; audio?: string; duration?: number; reason?: string }> =>
      ipcRenderer.invoke('media:probeStream', url),
    transcodeStream: (
      url: string,
      fullTranscode?: boolean,
    ): Promise<{ ok: boolean; url?: string; reason?: string }> =>
      ipcRenderer.invoke('media:transcodeStream', url, fullTranscode),
  },
  updates: {
    check: (feedUrl?: string): Promise<{ ok: boolean; message?: string; version?: string }> =>
      ipcRenderer.invoke('updates:check', feedUrl),
    install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
    onEvent: (cb: (payload: Record<string, unknown>) => void): (() => void) => {
      const handler = (_event: unknown, payload: Record<string, unknown>) => cb(payload)
      ipcRenderer.on('updates:event', handler)
      return () => ipcRenderer.removeListener('updates:event', handler)
    },
  },
  torrents: {
    add: (input: { magnet?: string; path?: string }): Promise<AddTorrentResult> =>
      ipcRenderer.invoke('torrent:add', input),
    list: (): Promise<TorrentSnapshot[]> => ipcRenderer.invoke('torrent:list'),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('torrent:remove', id),
    clearCache: (): Promise<{ ok: boolean; bytes: number }> => ipcRenderer.invoke('torrent:clearCache'),
    openFile: (): Promise<string | null> => ipcRenderer.invoke('torrent:openFile'),
    readText: (id: string, index: number): Promise<string> =>
      ipcRenderer.invoke('torrent:readText', { id, index }),
    onUpdate: (cb: (snapshot: TorrentSnapshot) => void): (() => void) => {
      const handler = (_event: unknown, snapshot: TorrentSnapshot) => cb(snapshot)
      ipcRenderer.on('torrent:update', handler)
      return () => ipcRenderer.removeListener('torrent:update', handler)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const handler = (_event: unknown, message: string) => cb(message)
      ipcRenderer.on('torrent:client-error', handler)
      return () => ipcRenderer.removeListener('torrent:client-error', handler)
    },
  },
}

contextBridge.exposeInMainWorld('nova', api)

export type NovaApi = typeof api
