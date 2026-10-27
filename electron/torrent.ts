import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { TorrentService } from './torrent-service'
import type { AddTorrentResult, TorrentSnapshot } from '../src/types'

let service: TorrentService | null = null

function getService(): TorrentService {
  if (service) return service
  const downloadDir = path.join(app.getPath('temp'), 'SquizanTV', 'torrents')
  service = new TorrentService(downloadDir)
  service.warmUp()
  service.on('update', (snapshot: TorrentSnapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('torrent:update', snapshot)
    }
  })
  service.on('client-error', (message: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('torrent:client-error', message)
    }
  })
  return service
}

export function registerTorrentIpc(): void {
  ipcMain.handle('torrent:add', async (_event, input: { magnet?: string; path?: string }): Promise<AddTorrentResult> => {
    const source = input?.magnet?.trim() || input?.path?.trim() || ''
    return getService().add(source)
  })

  ipcMain.handle('torrent:list', (): TorrentSnapshot[] => getService().list())

  ipcMain.handle('torrent:remove', (_event, id: string): boolean => getService().remove(id))

  ipcMain.handle('torrent:clearCache', () => getService().clearCache())

  ipcMain.handle('torrent:readText', (_event, input: { id?: string; index?: number }): Promise<string> => {
    if (!input?.id || typeof input.index !== 'number') return Promise.resolve('')
    return getService().readText(input.id, input.index)
  })

  ipcMain.handle('torrent:openFile', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Abrir archivo .torrent',
          properties: ['openFile'],
          filters: [
            { name: 'Torrents', extensions: ['torrent'] },
            { name: 'Todos los archivos', extensions: ['*'] },
          ],
        })
      : await dialog.showOpenDialog({
          title: 'Abrir archivo .torrent',
          properties: ['openFile'],
          filters: [
            { name: 'Torrents', extensions: ['torrent'] },
            { name: 'Todos los archivos', extensions: ['*'] },
          ],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

export function disposeTorrents(): void {
  service?.dispose()
  service = null
}
