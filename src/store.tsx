import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AppSettings, Channel, DB, Playlist, StremioAddon } from './types'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  volume: 1,
  updateFeed: '',
  epgAutoRefresh: true,
}

function defaultDb(): DB {
  return {
    version: 1,
    playlists: [],
    favorites: [],
    history: [],
    settings: { ...DEFAULT_SETTINGS },
    activePlaylist: null,
    addons: [],
  }
}

function normalizeDb(raw: unknown): DB {
  const base = defaultDb()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Partial<DB>
  return {
    version: 1,
    playlists: Array.isArray(data.playlists) ? data.playlists : [],
    favorites: Array.isArray(data.favorites) ? data.favorites : [],
    history: Array.isArray(data.history) ? data.history : [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
    activePlaylist: data.activePlaylist ?? null,
    addons: Array.isArray(data.addons) ? data.addons : [],
  }
}

export function favoriteKey(playlistId: string, channelId: string): string {
  return `${playlistId}::${channelId}`
}

interface DbApi {
  db: DB
  ready: boolean
  activePlaylist: Playlist | null
  setActivePlaylist: (id: string | null) => void
  addPlaylist: (playlist: Playlist) => void
  updatePlaylist: (id: string, patch: Partial<Playlist>) => void
  removePlaylist: (id: string) => void
  toggleFavorite: (playlistId: string, channelId: string) => void
  isFavorite: (playlistId: string, channelId: string) => boolean
  pushHistory: (playlistId: string, channel: Channel) => void
  clearHistory: () => void
  updateSettings: (patch: Partial<AppSettings>) => void
  addAddon: (addon: StremioAddon) => void
  removeAddon: (url: string) => void
  toggleAddon: (url: string) => void
  resetAll: () => void
}

const DbContext = createContext<DbApi | null>(null)

export function DbProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<DB>(defaultDb)
  const [ready, setReady] = useState(false)
  const skipWrite = useRef(true)

  useEffect(() => {
    let alive = true
    window.nova.db
      .read()
      .then((raw) => {
        if (!alive) return
        setDb(normalizeDb(raw))
      })
      .finally(() => {
        if (!alive) return
        setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    if (skipWrite.current) {
      skipWrite.current = false
      return
    }
    const timer = setTimeout(() => {
      void window.nova.db.write(db)
    }, 350)
    return () => clearTimeout(timer)
  }, [db, ready])

  useEffect(() => {
    document.documentElement.dataset.theme = db.settings.theme
  }, [db.settings.theme])

  const setActivePlaylist = useCallback((id: string | null) => {
    setDb((prev) => ({ ...prev, activePlaylist: id }))
  }, [])

  const addPlaylist = useCallback((playlist: Playlist) => {
    setDb((prev) => {
      const exists = prev.playlists.findIndex((item) => item.id === playlist.id)
      const playlists = [...prev.playlists]
      if (exists >= 0) playlists[exists] = playlist
      else playlists.push(playlist)
      return { ...prev, playlists, activePlaylist: playlist.id }
    })
  }, [])

  const updatePlaylist = useCallback((id: string, patch: Partial<Playlist>) => {
    setDb((prev) => ({
      ...prev,
      playlists: prev.playlists.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
      ),
    }))
  }, [])

  const removePlaylist = useCallback((id: string) => {
    setDb((prev) => {
      const prefix = `${id}::`
      return {
        ...prev,
        playlists: prev.playlists.filter((item) => item.id !== id),
        favorites: prev.favorites.filter((key) => !key.startsWith(prefix)),
        history: prev.history.filter((item) => item.playlistId !== id),
        activePlaylist:
          prev.activePlaylist === id ? (prev.playlists.find((item) => item.id !== id)?.id ?? null) : prev.activePlaylist,
      }
    })
  }, [])

  const toggleFavorite = useCallback((playlistId: string, channelId: string) => {
    const key = favoriteKey(playlistId, channelId)
    setDb((prev) => {
      const exists = prev.favorites.includes(key)
      return {
        ...prev,
        favorites: exists ? prev.favorites.filter((item) => item !== key) : [key, ...prev.favorites],
      }
    })
  }, [])

  const isFavorite = useCallback(
    (playlistId: string, channelId: string) => db.favorites.includes(favoriteKey(playlistId, channelId)),
    [db.favorites],
  )

  const pushHistory = useCallback((playlistId: string, channel: Channel) => {
    const key = favoriteKey(playlistId, channel.id)
    setDb((prev) => ({
      ...prev,
      history: [
        { key, channelId: channel.id, playlistId, at: Date.now() },
        ...prev.history.filter((item) => item.key !== key),
      ].slice(0, 80),
    }))
  }, [])

  const clearHistory = useCallback(() => {
    setDb((prev) => ({ ...prev, history: [] }))
  }, [])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setDb((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  }, [])

  const addAddon = useCallback((addon: StremioAddon) => {
    setDb((prev) => {
      const exists = prev.addons.findIndex((item) => item.url === addon.url)
      const addons = [...prev.addons]
      if (exists >= 0) addons[exists] = { ...addon, enabled: true, addedAt: prev.addons[exists].addedAt }
      else addons.push(addon)
      return { ...prev, addons }
    })
  }, [])

  const removeAddon = useCallback((url: string) => {
    setDb((prev) => ({ ...prev, addons: prev.addons.filter((item) => item.url !== url) }))
  }, [])

  const toggleAddon = useCallback((url: string) => {
    setDb((prev) => ({
      ...prev,
      addons: prev.addons.map((item) => (item.url === url ? { ...item, enabled: !item.enabled } : item)),
    }))
  }, [])

  const resetAll = useCallback(() => {
    setDb({ ...defaultDb(), settings: { ...DEFAULT_SETTINGS } })
  }, [])

  const activePlaylist = useMemo(
    () => db.playlists.find((item) => item.id === db.activePlaylist) ?? db.playlists[0] ?? null,
    [db.playlists, db.activePlaylist],
  )

  const value = useMemo<DbApi>(
    () => ({
      db,
      ready,
      activePlaylist,
      setActivePlaylist,
      addPlaylist,
      updatePlaylist,
      removePlaylist,
      toggleFavorite,
      isFavorite,
      pushHistory,
      clearHistory,
      updateSettings,
      addAddon,
      removeAddon,
      toggleAddon,
      resetAll,
    }),
    [
      db,
      ready,
      activePlaylist,
      setActivePlaylist,
      addPlaylist,
      updatePlaylist,
      removePlaylist,
      toggleFavorite,
      isFavorite,
      pushHistory,
      clearHistory,
      updateSettings,
      addAddon,
      removeAddon,
      toggleAddon,
      resetAll,
    ],
  )

  return <DbContext.Provider value={value}>{children}</DbContext.Provider>
}

export function useDb(): DbApi {
  const context = useContext(DbContext)
  if (!context) throw new Error('useDb debe usarse dentro de DbProvider')
  return context
}
