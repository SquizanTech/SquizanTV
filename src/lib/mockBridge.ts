import type { NovaApi } from '../../electron/preload'

/**
 * Puente de desarrollo: permite abrir la interfaz en un navegador normal
 * (sin Electron) usando localStorage y fetch del navegador.
 * En la app empaquetada window.nova siempre existe y esto no hace nada.
 */
export function installMockBridge(): void {
  if (typeof window === 'undefined' || window.nova) return

  const KEY = 'novatv-db'
  const mock = {
    db: {
      read: async (): Promise<unknown> => {
        try {
          const raw = localStorage.getItem(KEY)
          return raw ? JSON.parse(raw) : null
        } catch {
          return null
        }
      },
      write: async (data: unknown): Promise<boolean> => {
        localStorage.setItem(KEY, JSON.stringify(data))
        return true
      },
    },
    net: {
      fetch: async (req: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeout?: number
      }) => {
        try {
          const response = await fetch(req.url, {
            method: req.method ?? 'GET',
            headers: req.headers,
            body: req.body,
            signal: AbortSignal.timeout(req.timeout ?? 30000),
          })
          const text = await response.text()
          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text,
            contentType: response.headers.get('content-type') ?? '',
          }
        } catch (error) {
          return {
            ok: false,
            status: 0,
            statusText: error instanceof Error ? error.message : String(error),
            text: '',
            contentType: '',
          }
        }
      },
    },
    dialog: {
      openPlaylist: () =>
        new Promise<{ path: string; name: string; content: string } | null>((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.m3u,.m3u8,.txt,.xml'
          input.onchange = async () => {
            const file = input.files?.[0]
            if (!file) {
              resolve(null)
              return
            }
            resolve({ path: file.name, name: file.name, content: await file.text() })
          }
          input.click()
        }),
    },
    app: {
      version: async () => '0.1.0-web',
      openExternal: async (url: string) => {
        window.open(url, '_blank')
      },
      openDataFolder: async () => undefined,
      externalPlayer: async () => '',
      openExternalPlayer: async () => ({ ok: false, message: 'Solo disponible en la app de escritorio.' }),
    },
    media: {
      probeTs: async (): Promise<{ ok: boolean; ts?: boolean; audio?: string | null; video?: boolean }> => ({ ok: false }),
      probeStream: async (): Promise<{ ok: boolean; container?: string; video?: string; audio?: string }> => ({ ok: false }),
      transcodeStream: async (): Promise<{ ok: boolean; url?: string; reason?: string }> => ({
        ok: false,
        reason: 'Solo disponible en la app de escritorio.',
      }),
      openSubtitle: () =>
        new Promise<{ name: string; data: string } | null>((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.srt,.vtt,.ass,.ssa,.sub,.txt'
          input.onchange = async () => {
            const file = input.files?.[0]
            if (!file) {
              resolve(null)
              return
            }
            try {
              resolve({ name: file.name, data: await file.text() })
            } catch {
              resolve(null)
            }
          }
          input.click()
        }),
    },
    updates: {
      check: async () => ({ ok: false, message: 'Las actualizaciones solo funcionan en la app instalada.' }),
      install: async () => undefined,
      onEvent: () => () => undefined,
    },
    torrents: {
      add: async () => ({ ok: false, message: 'Los torrents solo funcionan dentro de la app de escritorio.' }),
      list: async () => [],
      remove: async () => false,
      clearCache: async () => ({ ok: false, bytes: 0 }),
      openFile: () =>
        new Promise<string | null>((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.torrent'
          input.onchange = () => resolve(input.files?.[0]?.name ?? null)
          input.click()
        }),
      readText: async () => '',
      onUpdate: () => () => undefined,
      onError: () => () => undefined,
    },
  }

  ;(window as unknown as { nova: NovaApi }).nova = mock as unknown as NovaApi
}
