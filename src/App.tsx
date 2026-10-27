import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Channel, EpgData, PageId, Playlist, TorrentDetails, TorrentFileInfo, TorrentSnapshot } from './types'
import { useDb } from './store'
import { parseXmltv, mergeEpg } from './lib/xmltv'
import { playlistEpgUrls } from './lib/m3u'
import { baseName, formatSpeed, hostOf, uid } from './lib/util'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Player } from './components/Player'
import { AddPlaylistModal } from './components/AddPlaylistModal'
import { BrandMark, Icon } from './components/Icons'
import { HomePage } from './pages/HomePage'
import { LivePage } from './pages/LivePage'
import { MoviesPage } from './pages/MoviesPage'
import { SeriesPage } from './pages/SeriesPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { EpgPage } from './pages/EpgPage'
import { TorrentsPage } from './pages/TorrentsPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { HistoryPage } from './pages/HistoryPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SettingsPage } from './pages/SettingsPage'

interface PlayerState {
  channel: Channel
  playlist: Playlist
  list: Channel[]
  transient?: boolean
  torrentId?: string
  details?: TorrentDetails
}

function describeTorrent(snapshot: TorrentSnapshot): string {
  if (snapshot.error) return snapshot.error
  if (!snapshot.ready) return `Conectando · ${snapshot.peers} pares`
  const parts = [`${snapshot.progress}% descargado`]
  if (snapshot.downloadSpeed > 0) parts.push(formatSpeed(snapshot.downloadSpeed))
  parts.push(`${snapshot.peers} pares`)
  return parts.join(' · ')
}

export default function App() {
  const { db, ready, activePlaylist, addPlaylist } = useDb()
  const [page, setPage] = useState<PageId>('home')
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [player, setPlayer] = useState<PlayerState | null>(null)
  const [epg, setEpg] = useState<EpgData | null>(null)
  const [epgLoading, setEpgLoading] = useState(false)
  const [epgError, setEpgError] = useState('')
  const [torrentStatus, setTorrentStatus] = useState('')
  const epgCache = useRef<{ key: string; data: EpgData } | null>(null)

  const playlist = activePlaylist
  const epgSources = useMemo(() => (playlist ? playlistEpgUrls(playlist) : []), [playlist])
  const epgRefresh = playlist?.epgRefresh ?? 3600

  const loadEpg = useCallback(
    async (force = false) => {
      const urls = epgSources
      if (urls.length === 0) {
        setEpg(null)
        setEpgError('')
        return
      }
      const key = urls.join('\n')
      if (!force && epgCache.current?.key === key) {
        setEpg(epgCache.current.data)
        return
      }
      setEpgLoading(true)
      setEpgError('')
      try {
        // Una lista puede declarar varias fuentes (por ejemplo una general y
        // otra por país). Se descargan en paralelo y se unen; si una falla, se
        // usa el resto. La copia en disco evita bajar 35 MB en cada arranque.
        const results = await Promise.allSettled(
          urls.map((url) =>
            window.nova.net.fetch({
              url,
              timeout: 180000,
              cacheSeconds: force ? 0 : Math.max(60, epgRefresh),
            }),
          ),
        )
        const parts: EpgData[] = []
        const failures: string[] = []
        results.forEach((result, position) => {
          const url = urls[position]
          if (result.status !== 'fulfilled') {
            failures.push(`${hostOf(url)} (${result.reason instanceof Error ? result.reason.message : 'sin conexión'})`)
            return
          }
          const response = result.value
          if (!response.ok) {
            failures.push(`${hostOf(url)} (HTTP ${response.status})`)
            return
          }
          if (!response.text.trim()) {
            failures.push(`${hostOf(url)} (vacío)`)
            return
          }
          try {
            const data = parseXmltv(response.text, url)
            if (data.programmes.length === 0) {
              failures.push(`${hostOf(url)} (sin programas)`)
              return
            }
            parts.push(data)
          } catch (cause) {
            failures.push(`${hostOf(url)} (${cause instanceof Error ? cause.message : 'XMLTV no válido'})`)
          }
        })
        if (parts.length === 0) {
          throw new Error(
            failures.length > 0 ? `No se pudo cargar el EPG: ${failures.join(' · ')}` : 'El EPG está vacío.',
          )
        }
        const merged = mergeEpg(parts, urls.join(', '))
        epgCache.current = { key, data: merged }
        setEpg(merged)
        if (failures.length > 0) setEpgError(`Algunas fuentes del EPG fallaron: ${failures.join(' · ')}`)
      } catch (cause) {
        setEpgError(cause instanceof Error ? cause.message : 'Error al cargar el EPG.')
        if (epgCache.current?.key === key) setEpg(epgCache.current.data)
        else setEpg(null)
      } finally {
        setEpgLoading(false)
      }
    },
    [epgSources, epgRefresh],
  )

  useEffect(() => {
    if (epgSources.length === 0) {
      setEpg(null)
      setEpgError('')
      return
    }
    if (!db.settings.epgAutoRefresh) return
    void loadEpg()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist?.id, epgSources, db.settings.epgAutoRefresh])

  // Las listas indican cada cuánto cambia su guía (`refresh`, normalmente 1 h).
  useEffect(() => {
    if (epgSources.length === 0 || !db.settings.epgAutoRefresh) return
    const every = Math.max(900, epgRefresh) * 1000
    const timer = setInterval(() => void loadEpg(true), every)
    return () => clearInterval(timer)
  }, [epgSources, epgRefresh, db.settings.epgAutoRefresh, loadEpg])

  const navigate = useCallback((next: PageId) => {
    setPage(next)
    if (next === 'settings' || next === 'playlists') setQuery('')
  }, [])

  const play = useCallback(
    (channel: Channel, list: Channel[], target?: Playlist) => {
      const source = target ?? activePlaylist
      if (!source) return
      setPlayer({ channel, playlist: source, list })
    },
    [activePlaylist],
  )

  const playTorrent = useCallback((snapshot: TorrentSnapshot, file: TorrentFileInfo, details: TorrentDetails) => {
    if (!snapshot.streamBase) return
    const channels: Channel[] = snapshot.files
      .filter((entry) => entry.kind === 'video')
      .map((entry) => ({
        id: `${snapshot.id}:${entry.index}`,
        name: baseName(entry.name),
        url: `${snapshot.streamBase}${entry.index}`,
        group: details.title || snapshot.name,
        kind: 'movie',
        addedAt: snapshot.createdAt,
      }))

    const channel = channels.find((entry) => entry.id === `${snapshot.id}:${file.index}`)
    if (!channel) return

    const synthetic: Playlist = {
      id: `torrent:${snapshot.id}`,
      name: details.title || snapshot.name,
      type: 'm3u',
      channels,
      createdAt: snapshot.createdAt,
      updatedAt: Date.now(),
    }

    setTorrentStatus(describeTorrent(snapshot))
    setPlayer({ channel, playlist: synthetic, list: channels, transient: true, torrentId: snapshot.id, details })
  }, [])

  useEffect(() => {
    const torrentId = player?.torrentId
    if (!torrentId) {
      setTorrentStatus('')
      return
    }
    return window.nova.torrents.onUpdate((snapshot) => {
      if (snapshot.id === torrentId) setTorrentStatus(describeTorrent(snapshot))
    })
  }, [player?.torrentId])

  // Fuentes directas de addons (HTTP/HLS): se envuelven en una lista temporal
  // para reutilizar el reproductor sin ensuciar historial ni listas.
  const playDirect = useCallback((url: string, title: string, details: TorrentDetails) => {
    const channel: Channel = {
      id: `addon:${uid()}`,
      name: title,
      url,
      group: 'Addons',
      kind: 'movie',
      addedAt: Date.now(),
    }
    const synthetic: Playlist = {
      id: `addon:${uid()}`,
      name: title,
      type: 'm3u',
      channels: [channel],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setPlayer({ channel, playlist: synthetic, list: [channel], transient: true, details })
  }, [])

  const counts = useMemo(() => {
    const channels = playlist?.channels ?? []
    return {
      live: channels.filter((channel) => channel.kind === 'live').length,
      movies: channels.filter((channel) => channel.kind === 'movie').length,
      series: channels.filter((channel) => channel.kind === 'series').length,
      favorites: db.favorites.filter((key) => key.startsWith(`${playlist?.id}::`)).length,
    }
  }, [playlist, db.favorites])

  if (!ready) {
    return (
      <div className="splash">
        <div className="brand-mark">
          <BrandMark size={64} />
        </div>
        <p>SquizanTV</p>
      </div>
    )
  }

  const showSearch = page !== 'settings' && page !== 'playlists' && page !== 'torrents' && page !== 'discover'

  return (
    <div className="app">
      <Sidebar page={page} onNavigate={navigate} counts={counts} />

      <div className="main">
        <Topbar
          page={page}
          query={query}
          onQuery={setQuery}
          onAdd={() => setAddOpen(true)}
          showSearch={showSearch}
          showAdd={page !== 'discover'}
        />

        {page === 'home' && (
          <HomePage
            playlist={playlist}
            epg={epg}
            onAdd={() => setAddOpen(true)}
            onNavigate={navigate}
            onPlay={play}
          />
        )}
        {page === 'live' && <LivePage playlist={playlist} query={query} epg={epg} onPlay={play} />}
        {page === 'movies' && <MoviesPage playlist={playlist} query={query} onPlay={play} />}
        {page === 'series' && <SeriesPage playlist={playlist} query={query} onPlay={play} />}
        {page === 'discover' && <DiscoverPage onPlayTorrent={playTorrent} onPlayDirect={playDirect} />}
        {page === 'epg' && (
          <EpgPage
            playlist={playlist}
            epg={epg}
            loading={epgLoading}
            error={epgError}
            query={query}
            onReload={() => void loadEpg(true)}
            onPlay={play}
          />
        )}
        {page === 'favorites' && <FavoritesPage query={query} onPlay={play} />}
        {page === 'history' && <HistoryPage query={query} onPlay={play} />}
        {page === 'torrents' && <TorrentsPage onPlayTorrent={playTorrent} />}
        {page === 'playlists' && (
          <PlaylistsPage onAdd={() => setAddOpen(true)} />
        )}
        {page === 'settings' && <SettingsPage />}
      </div>

      {addOpen && (
        <AddPlaylistModal
          onClose={() => setAddOpen(false)}
          onAdded={(created) => {
            addPlaylist(created)
            setPage('live')
            setQuery('')
          }}
        />
      )}

      {player && (
        <Player
          channel={player.channel}
          playlist={player.playlist}
          list={player.list}
          epg={epg}
          transient={player.transient}
          statusText={player.transient ? torrentStatus : undefined}
          details={player.details}
          onClose={() => setPlayer(null)}
          onSelect={(channel) => setPlayer((prev) => (prev ? { ...prev, channel } : prev))}
        />
      )}
    </div>
  )
}
