import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AddonStream,
  CatalogMeta,
  StremioAddon,
  StremioCatalog,
  SubtitleFile,
  TorrentDetails,
  TorrentFileInfo,
  TorrentSnapshot,
} from '../types'
import { useDb } from '../store'
import {
  addonSupports,
  fetchCatalog,
  fetchMeta,
  fetchStreams,
  installAddon,
  magnetForStream,
  normalizeAddonUrl,
  pickStreamFile,
  type ResolvedStream,
} from '../lib/stremio'
import { baseName } from '../lib/util'
import { Icon } from '../components/Icons'

interface DiscoverPageProps {
  onPlayTorrent: (snapshot: TorrentSnapshot, file: TorrentFileInfo, details: TorrentDetails) => void
  onPlayDirect: (url: string, title: string, details: TorrentDetails) => void
}

type Notice = { type: 'ok' | 'error' | 'info'; text: string }

const SUGGESTED: Array<{ name: string; url: string; description: string }> = [
  {
    name: 'Cinemeta',
    url: 'https://v3-cinemeta.strem.io/manifest.json',
    description: 'Catálogos oficiales de IMDb: populares, mejor valoradas y búsqueda de películas y series.',
  },
]

interface CatalogEntry {
  addon: StremioAddon
  catalog: StremioCatalog
  key: string
}

function catalogEntries(addons: StremioAddon[]): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const addon of addons) {
    if (!addon.enabled) continue
    for (const catalog of addon.catalogs) {
      if (catalog.type !== 'movie' && catalog.type !== 'series') continue
      out.push({ addon, catalog, key: `${addon.url}|${catalog.type}|${catalog.id}` })
    }
  }
  return out
}

function cleanStreamText(value: string | undefined): string {
  if (!value) return ''
  return value
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function initial(name: string): string {
  return name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().charAt(0).toUpperCase() || '?'
}

function subtitleLanguage(name: string): string {
  const lower = baseName(name).toLowerCase()
  if (/\bespa|castellano|latino|\.es\.[^a-z]|(?<=^|\W)es(?=\W|$)/.test(lower)) return 'es'
  if (/\bingles|english|\.en\.[^a-z]|(?<=^|\W)en(?=\W|$)/.test(lower)) return 'en'
  return ''
}

function detailsFrom(
  meta: CatalogMeta,
  episode: NonNullable<CatalogMeta['videos']>[number] | null,
  snapshot?: TorrentSnapshot,
): TorrentDetails {
  const suffix =
    episode && typeof episode.season === 'number' && typeof episode.episode === 'number'
      ? ` · T${episode.season}E${String(episode.episode).padStart(2, '0')}`
      : ''
  const subtitles: SubtitleFile[] = snapshot?.streamBase
    ? snapshot.files
        .filter((file) => file.kind === 'subtitle')
        .map((file) => ({
          url: `${snapshot.streamBase}${file.index}`,
          name: baseName(file.name),
          language: subtitleLanguage(file.name),
        }))
    : []
  return {
    title: `${meta.name}${suffix}`,
    originalTitle: '',
    plot: meta.description ?? '',
    year: meta.releaseInfo ?? '',
    genre: (meta.genres ?? []).join(', '),
    rating: meta.imdbRating ?? '',
    runtime: meta.runtime ?? '',
    posterUrl: meta.poster ?? '',
    backdropUrl: meta.background ?? meta.poster ?? '',
    logoUrl: meta.logo ?? '',
    subtitles,
  }
}

/* ---------------- Gestor de addons ---------------- */

function AddonManager({
  onClose,
  initialNotice = null,
}: {
  onClose: () => void
  initialNotice?: Notice | null
}) {
  const { db, addAddon, removeAddon, toggleAddon } = useDb()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyUrl, setBusyUrl] = useState('')
  const [notice, setNotice] = useState<Notice | null>(initialNotice)

  const addons = db.addons
  const installed = useMemo(() => new Set(addons.map((addon) => addon.url)), [addons])

  const install = useCallback(
    async (value: string) => {
      if (busy) return
      setBusy(true)
      setBusyUrl(value)
      setNotice({ type: 'info', text: 'Leyendo el manifest del addon…' })
      try {
        const addon = await installAddon(value)
        addAddon(addon)
        setInput('')
        setNotice({
          type: 'ok',
          text: `${addon.name} instalado. ${addon.catalogs.length ? `${addon.catalogs.length} catálogos disponibles.` : 'Solo aporta fuentes o metadatos.'}`,
        })
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo instalar el addon.' })
      } finally {
        setBusy(false)
        setBusyUrl('')
      }
    },
    [addAddon, busy],
  )

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal addon-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Addons de Stremio</h2>
            <p>Catálogos, metadatos y fuentes. Instala los que quieras y actívalos cuando los necesites.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Cerrar">
            <Icon name="x" size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="addon-form">
            <label className="field">
              <span>Dirección del addon</span>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void install(input)
                }}
                placeholder="https://…/manifest.json"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void install(input)}
              disabled={busy || !input.trim()}
            >
              {busy && busyUrl === input ? <span className="spinner small" /> : <Icon name="plus" size={16} />}
              Añadir
            </button>
          </div>

          <p className="hint">
            Acepta la URL del manifest, la raíz del addon o un enlace de instalación de Stremio
            (<code>stremio://…</code>).
          </p>

          {notice && (
            <div className={`alert ${notice.type === 'error' ? 'error' : notice.type === 'ok' ? 'ok' : ''}`}>
              <Icon name={notice.type === 'error' ? 'info' : notice.type === 'ok' ? 'check' : 'download'} size={15} />
              <span>{notice.text}</span>
            </div>
          )}

          <div className="addon-list">
            {addons.length === 0 && <p className="muted addon-empty">Todavía no hay addons instalados.</p>}
            {addons.map((addon) => (
              <div className={`addon-row ${addon.enabled ? '' : 'is-off'}`} key={addon.url}>
                <span className="addon-logo">
                  {addon.logo ? (
                    <img src={addon.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <Icon name="puzzle" size={18} />
                  )}
                </span>
                <div className="addon-meta">
                  <strong>{addon.name}</strong>
                  <span className="addon-url" title={addon.url}>
                    {addon.url}
                  </span>
                  <div className="addon-tags">
                    {addon.catalogs.length > 0 && <em>{addon.catalogs.length} catálogos</em>}
                    {addon.resources.includes('meta') && <em>fichas</em>}
                    {addon.resources.includes('stream') && <em>fuentes</em>}
                    {addon.version && <em>v{addon.version}</em>}
                  </div>
                </div>
                <div className="addon-actions">
                  <button
                    type="button"
                    className={`switch ${addon.enabled ? 'on' : ''}`}
                    onClick={() => toggleAddon(addon.url)}
                    title={addon.enabled ? 'Desactivar' : 'Activar'}
                  >
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => removeAddon(addon.url)}
                    title="Quitar addon"
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="suggest-block">
            <span className="suggest-title">Recomendados</span>
            <div className="suggest-grid">
              {SUGGESTED.map((suggestion) => {
                const normalized = normalizeAddonUrl(suggestion.url)
                const isInstalled = normalized ? installed.has(normalized) : false
                return (
                  <div className="suggest-card" key={suggestion.url}>
                    <div>
                      <strong>{suggestion.name}</strong>
                      <p>{suggestion.description}</p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || isInstalled}
                      onClick={() => void install(suggestion.url)}
                    >
                      {busyUrl === suggestion.url ? (
                        <span className="spinner small" />
                      ) : isInstalled ? (
                        <Icon name="check" size={14} />
                      ) : (
                        <Icon name="plus" size={14} />
                      )}
                      {isInstalled ? 'Instalado' : 'Instalar'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Ficha con fuentes ---------------- */

interface MetaDrawerProps {
  item: CatalogMeta
  addons: StremioAddon[]
  preferredAddonUrl: string
  onClose: () => void
  onPlayTorrent: DiscoverPageProps['onPlayTorrent']
  onPlayDirect: DiscoverPageProps['onPlayDirect']
}

function MetaDrawer({ item, addons, preferredAddonUrl, onClose, onPlayTorrent, onPlayDirect }: MetaDrawerProps) {
  const [meta, setMeta] = useState<CatalogMeta>(item)
  const [streams, setStreams] = useState<ResolvedStream[]>([])
  const [streamsLoading, setStreamsLoading] = useState(false)
  const [streamsError, setStreamsError] = useState('')
  const [pendingKey, setPendingKey] = useState('')
  const pending = useRef<{ off: () => void; timer: number } | null>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [episodeId, setEpisodeId] = useState<string | null>(null)

  const isSeries = (meta.type || item.type) === 'series'
  const videos = useMemo(
    () => (meta.videos ?? []).filter((video) => typeof video.season === 'number' && typeof video.episode === 'number'),
    [meta.videos],
  )
  const seasons = useMemo(
    () => Array.from(new Set(videos.map((video) => video.season as number))).sort((a, b) => a - b),
    [videos],
  )
  const activeSeason = season !== null && seasons.includes(season) ? season : seasons[0] ?? null
  const episodes = useMemo(
    () =>
      videos
        .filter((video) => video.season === activeSeason)
        .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)),
    [videos, activeSeason],
  )
  const activeEpisode = episodes.find((episode) => episode.id === episodeId) ?? episodes[0] ?? null
  const activeEpisodeRef = useRef(activeEpisode)
  activeEpisodeRef.current = activeEpisode

  const clearPending = useCallback(() => {
    if (pending.current) {
      pending.current.off()
      window.clearTimeout(pending.current.timer)
      pending.current = null
    }
    setPendingKey('')
  }, [])

  useEffect(() => clearPending, [clearPending])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Ficha completa: primero el addon del catálogo, luego cualquier otro con meta.
  useEffect(() => {
    let alive = true
    const candidates = [...addons].sort((a, b) => {
      const aPreferred = a.url === preferredAddonUrl ? 0 : 1
      const bPreferred = b.url === preferredAddonUrl ? 0 : 1
      return aPreferred - bPreferred
    })
    void (async () => {
      for (const addon of candidates) {
        if (!addonSupports(addon, 'meta', item.type, item.id)) continue
        try {
          const full = await fetchMeta(addon, item.type, item.id)
          if (!alive) return
          setMeta(full)
          return
        } catch {
          /* probamos el siguiente addon */
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [addons, item, preferredAddonUrl])

  const targetId = isSeries ? activeEpisode?.id : meta.id
  const targetType = isSeries ? 'series' : meta.type || item.type

  useEffect(() => {
    let alive = true
    if (!targetId) {
      setStreams([])
      setStreamsLoading(false)
      return
    }
    setStreams([])
    setStreamsError('')
    setStreamsLoading(true)
    void fetchStreams(addons, targetType, targetId)
      .then((list) => {
        if (alive) setStreams(list)
      })
      .catch((error) => {
        if (alive) setStreamsError(error instanceof Error ? error.message : 'No se pudieron cargar las fuentes.')
      })
      .finally(() => {
        if (alive) setStreamsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [addons, targetId, targetType])

  const play = async (resolved: ResolvedStream): Promise<void> => {
    if (pendingKey) return
    const details = detailsFrom(meta, activeEpisodeRef.current)
    const { stream } = resolved

    if (stream.url) {
      onPlayDirect(stream.url, details.title, details)
      onClose()
      return
    }
    if (stream.externalUrl) {
      void window.nova.app.openExternal(stream.externalUrl)
      return
    }

    const magnet = magnetForStream(stream)
    if (!magnet) {
      setStreamsError('Esa fuente no incluye un enlace reproducible.')
      return
    }

    clearPending()
    setStreamsError('')
    setPendingKey(resolved.key)

    try {
      const result = await window.nova.torrents.add({ magnet })
      if (!result.ok || !result.id) {
        setPendingKey('')
        setStreamsError(result.message ?? 'No se pudo añadir el torrent.')
        return
      }

      let settled = false
      const finish = (): void => {
        settled = true
        if (pending.current) {
          pending.current.off()
          window.clearTimeout(pending.current.timer)
          pending.current = null
        }
        setPendingKey('')
      }

      const off = window.nova.torrents.onUpdate((snapshot) => {
        if (settled || snapshot.id !== result.id) return
        if (snapshot.error) {
          finish()
          setStreamsError(snapshot.error)
          return
        }
        if (!snapshot.ready) return
        const file = pickStreamFile(snapshot.files, stream.fileIdx, stream.behaviorHints?.filename)
        if (!file) {
          finish()
          setStreamsError('El torrent no contiene ningún vídeo reconocible.')
          return
        }
        finish()
        onPlayTorrent(snapshot, file, detailsFrom(meta, activeEpisodeRef.current, snapshot))
        onClose()
      })

      const timer = window.setTimeout(() => {
        if (settled) return
        finish()
        setStreamsError('El torrent no consiguió pares en 2 minutos. Prueba con otra fuente.')
      }, 120000)

      pending.current = { off, timer }
    } catch (error) {
      setPendingKey('')
      setStreamsError(error instanceof Error ? error.message : 'No se pudo reproducir esa fuente.')
    }
  }

  const backdrop = meta.background || meta.poster
  const chips = [
    meta.releaseInfo,
    meta.imdbRating ? `★ ${meta.imdbRating}` : '',
    meta.runtime,
    (meta.genres ?? []).slice(0, 3).join(' · '),
  ].filter((chip): chip is string => Boolean(chip))

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={meta.name}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="drawer-close icon-btn" onClick={onClose} title="Cerrar">
          <Icon name="x" size={17} />
        </button>

        <div className="meta-hero">
          {backdrop && <img className="meta-hero-img" src={backdrop} alt="" referrerPolicy="no-referrer" />}
          <span className="meta-hero-fade" />
          <div className="meta-hero-content">
            {meta.poster && <img className="meta-poster" src={meta.poster} alt={`Póster de ${meta.name}`} />}
            <div className="meta-titles">
              {meta.logo ? (
                <img className="meta-logo" src={meta.logo} alt={meta.name} />
              ) : (
                <h2>{meta.name}</h2>
              )}
              {chips.length > 0 && (
                <div className="meta-chips">
                  {chips.map((chip, index) => (
                    <span key={`${chip}-${index}`} className={chip.startsWith('★') ? 'is-rating' : ''}>
                      {chip}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="meta-body">
          {meta.description && <p className="meta-plot">{meta.description}</p>}
          {meta.cast && meta.cast.length > 0 && (
            <p className="meta-cast">
              <strong>Reparto:</strong> {meta.cast.slice(0, 6).join(', ')}
            </p>
          )}

          {isSeries && seasons.length > 0 && (
            <div className="episode-row">
              <label className="drawer-select">
                <span>Temporada</span>
                <select
                  value={activeSeason ?? ''}
                  onChange={(event) => {
                    setSeason(Number(event.target.value))
                    setEpisodeId(null)
                  }}
                >
                  {seasons.map((value) => (
                    <option key={value} value={value}>
                      Temporada {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="drawer-select">
                <span>Episodio</span>
                <select value={activeEpisode?.id ?? ''} onChange={(event) => setEpisodeId(event.target.value)}>
                  {episodes.map((episode) => (
                    <option key={episode.id} value={episode.id}>
                      {`${episode.episode}. ${episode.title ?? 'Episodio'}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="stream-head">
            <div>
              <strong>Fuentes disponibles</strong>
              <span>
                {isSeries && activeEpisode
                  ? `T${activeEpisode.season}E${String(activeEpisode.episode).padStart(2, '0')}`
                  : 'Reproduce con el motor interno'}
              </span>
            </div>
            {streamsLoading && <span className="spinner small" />}
          </div>

          {streamsError && (
            <div className="alert error">
              <Icon name="info" size={15} />
              <span>{streamsError}</span>
            </div>
          )}

          {pendingKey && (
            <div className="alert">
              <Icon name="download" size={15} />
              <span>Añadiendo el torrent y buscando pares… puede tardar unos segundos.</span>
            </div>
          )}

          <div className="stream-list">
            {streams.map((resolved) => {
              const { stream } = resolved
              const title = cleanStreamText(stream.title || stream.description || stream.name)
              const name = (stream.name ?? '').replace(/\s+/g, ' ').trim()
              const isPending = pendingKey === resolved.key
              return (
                <button
                  type="button"
                  key={resolved.key}
                  className="stream-item"
                  onClick={() => void play(resolved)}
                  disabled={Boolean(pendingKey)}
                >
                  <span className="stream-info">
                    <span className="stream-name">
                      {name || 'Fuente'}
                      <em>{resolved.addon.name}</em>
                    </span>
                    {title && <span className="stream-title">{title}</span>}
                    {stream.behaviorHints?.filename && (
                      <span className="stream-file">{baseName(stream.behaviorHints.filename)}</span>
                    )}
                  </span>
                  <span className={`stream-play ${isPending ? 'is-busy' : ''}`}>
                    {isPending ? <span className="spinner small" /> : <Icon name="play" size={16} />}
                  </span>
                </button>
              )
            })}
          </div>

          {!streamsLoading && streams.length === 0 && !streamsError && (
            <p className="hint">
              No hay fuentes para este título con los addons instalados. Elige otro episodio o añade una fuente
              desde «Addons».
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

/* ---------------- Página ---------------- */

export function DiscoverPage({ onPlayTorrent, onPlayDirect }: DiscoverPageProps) {
  const { db, addAddon } = useDb()
  const addons = db.addons
  const catalogs = useMemo(() => catalogEntries(addons), [addons])
  const catalogAddons = useMemo(() => {
    const seen = new Set<string>()
    const out: StremioAddon[] = []
    for (const entry of catalogs) {
      if (seen.has(entry.addon.url)) continue
      seen.add(entry.addon.url)
      out.push(entry.addon)
    }
    return out
  }, [catalogs])

  const [catalogKey, setCatalogKey] = useState('')
  const [genre, setGenre] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [metas, setMetas] = useState<CatalogMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(true)
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerNotice, setManagerNotice] = useState<Notice | null>(null)
  const [selected, setSelected] = useState<CatalogMeta | null>(null)
  const tokenRef = useRef(0)

  const current = catalogs.find((entry) => entry.key === catalogKey) ?? catalogs[0] ?? null
  const currentAddonUrl = current?.addon.url ?? catalogAddons[0]?.url ?? ''

  useEffect(() => {
    if (catalogs.length === 0) {
      if (catalogKey) setCatalogKey('')
      return
    }
    if (!catalogs.some((entry) => entry.key === catalogKey)) setCatalogKey(catalogs[0].key)
  }, [catalogs, catalogKey])

  const genreExtra = useMemo(
    () => current?.catalog.extra?.find((extra) => extra.name === 'genre') ?? null,
    [current],
  )
  const genres = useMemo(() => genreExtra?.options ?? [], [genreExtra])

  useEffect(() => {
    setGenre('')
    setSearch('')
    setSearchInput('')
  }, [catalogKey])

  useEffect(() => {
    if (!genreExtra) {
      if (genre) setGenre('')
      return
    }
    if (genre && !genres.includes(genre)) {
      setGenre(genreExtra.isRequired ? genres[0] ?? '' : '')
      return
    }
    if (!genre && genreExtra.isRequired && genres.length > 0) setGenre(genres[0])
  }, [genre, genreExtra, genres])

  const load = useCallback(
    async (skip: number, append: boolean): Promise<void> => {
      if (!current) return
      const token = ++tokenRef.current
      setLoading(true)
      setError('')
      try {
        const page = await fetchCatalog(current.addon, current.catalog, { genre, search, skip })
        if (token !== tokenRef.current) return
        setMetas((prev) => {
          const merged = append ? [...prev, ...page.metas] : page.metas
          const seen = new Set<string>()
          return merged.filter((meta) => {
            const key = `${meta.type}:${meta.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        })
        setHasMore(page.metas.length > 0)
      } catch (cause) {
        if (token !== tokenRef.current) return
        setError(cause instanceof Error ? cause.message : 'No se pudo cargar el catálogo.')
        if (!append) {
          setMetas([])
          setHasMore(false)
        }
      } finally {
        if (token === tokenRef.current) setLoading(false)
      }
    },
    [current, genre, search],
  )

  useEffect(() => {
    if (!current) {
      setMetas([])
      return
    }
    setMetas([])
    setHasMore(true)
    void load(0, false)
  }, [current, load])

  const applySearch = (): void => {
    setSearch(searchInput.trim())
  }

  const catalogName = (entry: CatalogEntry): string =>
    `${entry.catalog.type === 'movie' ? 'Películas' : 'Series'} · ${entry.catalog.name}`

  const noCatalogs = catalogs.length === 0
  const installedSuggestions = new Set(addons.map((addon) => addon.url))
  const [installing, setInstalling] = useState('')

  const openManager = (notice: Notice | null = null): void => {
    setManagerNotice(notice)
    setManagerOpen(true)
  }

  return (
    <div className="page discover">
      <div className="discover-bar">
        <div className="discover-filters">
          {catalogAddons.length > 1 && (
            <label className="discover-select">
              <span>Addon</span>
              <select
                value={currentAddonUrl}
                onChange={(event) => {
                  const next = catalogs.find((entry) => entry.addon.url === event.target.value)
                  if (next) setCatalogKey(next.key)
                }}
              >
                {catalogAddons.map((addon) => (
                  <option key={addon.url} value={addon.url}>
                    {addon.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {catalogs.length > 0 && (
            <label className="discover-select grow">
              <span>Catálogo</span>
              <select value={current?.key ?? ''} onChange={(event) => setCatalogKey(event.target.value)}>
                {catalogs
                  .filter((entry) => entry.addon.url === currentAddonUrl)
                  .map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {catalogName(entry)}
                    </option>
                  ))}
              </select>
            </label>
          )}

          {genres.length > 0 && (
            <label className="discover-select">
              <span>Género</span>
              <select value={genre} onChange={(event) => setGenre(event.target.value)}>
                {!genreExtra?.isRequired && <option value="">Todos</option>}
                {genres.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="discover-search">
            <Icon name="search" size={15} />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySearch()
              }}
              placeholder="Buscar en el catálogo…"
              spellCheck={false}
            />
            {searchInput && (
              <button
                type="button"
                className="search-clear"
                onClick={() => {
                  setSearchInput('')
                  setSearch('')
                }}
                title="Limpiar"
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </label>
          <button type="button" className="btn btn-primary" onClick={applySearch} disabled={loading}>
            Buscar
          </button>
        </div>

        <button type="button" className="btn btn-ghost discover-addons" onClick={() => openManager()}>
          <Icon name="puzzle" size={16} />
          Addons
        </button>
      </div>

      {noCatalogs ? (
        <div className="discover-empty">
          <span className="discover-empty-icon">
            <Icon name="compass" size={30} />
          </span>
          <h2>Descubre con addons de Stremio</h2>
          <p>
            Instala Cinemeta para navegar por los catálogos de IMDb o cualquier addon de catálogo y metadatos
            que uses en Stremio. SquizanTV no incluye addons: tú decides cuáles añadir.
          </p>
          <div className="suggest-grid">
            {SUGGESTED.map((suggestion) => {
              const normalized = normalizeAddonUrl(suggestion.url)
              const isInstalled = normalized ? installedSuggestions.has(normalized) : false
              return (
                <div className="suggest-card" key={suggestion.url}>
                  <div>
                    <strong>{suggestion.name}</strong>
                    <p>{suggestion.description}</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={isInstalled || Boolean(installing)}
                    onClick={async () => {
                      if (installing) return
                      setInstalling(suggestion.url)
                      try {
                        const addon = await installAddon(suggestion.url)
                        addAddon(addon)
                      } catch (cause) {
                        openManager({
                          type: 'error',
                          text:
                            cause instanceof Error
                              ? cause.message
                              : 'No se pudo instalar el addon. Comprueba tu conexión.',
                        })
                      } finally {
                        setInstalling('')
                      }
                    }}
                  >
                    {installing === suggestion.url ? (
                      <span className="spinner small" />
                    ) : isInstalled ? (
                      <Icon name="check" size={14} />
                    ) : (
                      <Icon name="plus" size={14} />
                    )}
                    {isInstalled ? 'Instalado' : 'Instalar'}
                  </button>
                </div>
              )
            })}
          </div>
          <button type="button" className="btn" onClick={() => openManager()}>
            <Icon name="puzzle" size={16} />
            Gestionar addons
          </button>
        </div>
      ) : (
        <>
          <div className="discover-meta">
            <span>
              {loading && metas.length === 0
                ? 'Cargando catálogo…'
                : `${metas.length.toLocaleString('es-ES')} títulos · ${current?.addon.name ?? ''}`}
            </span>
            {search && <span className="discover-search-tag">Búsqueda: «{search}»</span>}
          </div>

          {error && (
            <div className="alert error">
              <Icon name="info" size={15} />
              <span>{error}</span>
            </div>
          )}

          {loading && metas.length === 0 ? (
            <div className="discover-grid">
              {Array.from({ length: 12 }).map((_, index) => (
                <div className="discover-card skeleton" key={index}>
                  <span className="discover-art" />
                  <span className="discover-card-title" />
                </div>
              ))}
            </div>
          ) : metas.length === 0 ? (
            <div className="discover-empty small">
              <span className="discover-empty-icon">
                <Icon name="search" size={26} />
              </span>
              <h2>Sin resultados</h2>
              <p>Prueba con otro término, cambia de género o elige otro catálogo.</p>
            </div>
          ) : (
            <div className="discover-grid">
              {metas.map((meta) => (
                <button
                  type="button"
                  className="discover-card"
                  key={`${meta.type}:${meta.id}`}
                  onClick={() => setSelected(meta)}
                  title={meta.name}
                >
                  <span className="discover-art">
                    {meta.poster ? (
                      <img src={meta.poster} alt={`Póster de ${meta.name}`} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="discover-art-fallback">{initial(meta.name)}</span>
                    )}
                    {meta.imdbRating && <span className="discover-rating">★ {meta.imdbRating}</span>}
                    <span className="discover-type">{meta.type === 'series' ? 'Serie' : 'Película'}</span>
                  </span>
                  <span className="discover-card-body">
                    <strong className="discover-card-title">{meta.name}</strong>
                    <span className="discover-card-sub">
                      {[meta.releaseInfo, (meta.genres ?? [])[0]].filter(Boolean).join(' · ') || 'Sin datos'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {metas.length > 0 && (
            <div className="discover-more">
              {hasMore ? (
                <button type="button" className="btn" onClick={() => void load(metas.length, true)} disabled={loading}>
                  {loading ? <span className="spinner small" /> : <Icon name="down" size={15} />}
                  Cargar más
                </button>
              ) : (
                <span className="muted">No hay más resultados.</span>
              )}
            </div>
          )}
        </>
      )}

      {managerOpen && (
        <AddonManager
          initialNotice={managerNotice}
          onClose={() => {
            setManagerOpen(false)
            setManagerNotice(null)
          }}
        />
      )}

      {selected && (
        <MetaDrawer
          key={`${selected.type}:${selected.id}`}
          item={selected}
          addons={addons}
          preferredAddonUrl={current?.addon.url ?? ''}
          onClose={() => setSelected(null)}
          onPlayTorrent={onPlayTorrent}
          onPlayDirect={onPlayDirect}
        />
      )}
    </div>
  )
}
