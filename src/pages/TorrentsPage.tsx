import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TorrentDetails, TorrentFileInfo, TorrentSnapshot } from '../types'
import { baseName, formatBytes, formatRemaining, formatSpeed } from '../lib/util'
import { cleanReleaseName, parseNfo, pickArtwork } from '../lib/torrent-meta'
import type { TorrentMeta } from '../lib/torrent-meta'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icons'

interface TorrentsPageProps {
  onPlayTorrent: (snapshot: TorrentSnapshot, file: TorrentFileInfo, details: TorrentDetails) => void
}

type Notice = { type: 'ok' | 'error' | 'info'; text: string }

function titleFor(snapshot: TorrentSnapshot, meta: Partial<TorrentMeta>): string {
  return meta.title?.trim() || cleanReleaseName(snapshot.name).title || snapshot.name
}

function languageFromName(name: string): string {
  const lower = baseName(name).toLowerCase()
  if (/\bespa|castellano|latino|\.es\.[^a-z]|(?<=^|\W)es(?=\W|$)/.test(lower)) return 'es'
  if (/\bingles|english|\.en\.[^a-z]|(?<=^|\W)en(?=\W|$)/.test(lower)) return 'en'
  return ''
}

function detailsFor(snapshot: TorrentSnapshot, meta: Partial<TorrentMeta>): TorrentDetails {
  const guessed = cleanReleaseName(snapshot.name)
  const artwork = pickArtwork(snapshot.files)
  const base = snapshot.streamBase
  const url = (file: TorrentFileInfo | null): string => (base && file ? `${base}${file.index}` : '')
  const subtitles = snapshot.files
    .filter((file) => file.kind === 'subtitle')
    .map((file) => ({
      url: base ? `${base}${file.index}` : null,
      name: baseName(file.name),
      language: languageFromName(file.name),
    }))
  return {
    title: titleFor(snapshot, meta),
    originalTitle: '',
    plot: meta.plot ?? '',
    year: meta.year || guessed.year,
    genre: meta.genre ?? '',
    rating: meta.rating ?? '',
    runtime: meta.runtime ?? '',
    posterUrl: url(artwork.poster),
    backdropUrl: url(artwork.backdrop ?? artwork.poster),
    logoUrl: url(artwork.logo),
    subtitles,
  }
}

interface TorrentCardProps {
  snapshot: TorrentSnapshot
  onPlay: (snapshot: TorrentSnapshot, file: TorrentFileInfo, details: TorrentDetails) => void
  onRemove: (snapshot: TorrentSnapshot) => void
}

function TorrentCard({ snapshot, onPlay, onRemove }: TorrentCardProps) {
  const artwork = useMemo(() => pickArtwork(snapshot.files), [snapshot.files])
  const [meta, setMeta] = useState<Partial<TorrentMeta>>({})
  const [plotOpen, setPlotOpen] = useState(false)

  useEffect(() => {
    const nfo = artwork.nfo
    if (!snapshot.ready || !nfo) return
    let alive = true
    void window.nova.torrents
      .readText(snapshot.id, nfo.index)
      .then((text) => {
        if (alive) setMeta(parseNfo(text))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [snapshot.id, snapshot.ready, artwork.nfo?.index])

  const details = detailsFor(snapshot, meta)
  const videos = snapshot.files.filter((file) => file.kind === 'video')
  const main = videos.reduce<TorrentFileInfo | null>(
    (best, file) => (!best || file.length > best.length ? file : best),
    null,
  )
  const poster = details.posterUrl
  const state = snapshot.error
    ? 'Con problemas'
    : snapshot.ready
      ? snapshot.peers > 0
        ? `${snapshot.peers} pares`
        : 'Listo para reproducir'
      : snapshot.peers > 0
        ? `Conectando · ${snapshot.peers} pares`
        : 'Buscando pares…'

  const chips = [details.year, details.genre, details.runtime, details.rating ? `★ ${details.rating}` : ''].filter(Boolean)
  const plot = details.plot
  const canPlay = snapshot.ready && Boolean(main)

  return (
    <article className="torrent-card">
      <div className={`torrent-poster ${poster ? 'has-image' : ''}`}>
        {poster ? (
          <img src={poster} alt={`Póster de ${details.title}`} loading="lazy" />
        ) : (
          <span className="torrent-poster-fallback">
            <Icon name="magnet" size={26} />
          </span>
        )}
        {canPlay && (
          <button
            type="button"
            className="torrent-poster-play"
            title={`Reproducir ${main ? baseName(main.name) : ''}`}
            onClick={() => main && onPlay(snapshot, main, details)}
          >
            <Icon name="play" size={20} />
          </button>
        )}
      </div>

      <div className="torrent-body">
        <header className="torrent-card-head">
          <div className="torrent-title">
            <h4 title={snapshot.name}>{details.title}</h4>
            <span>
              {state}
              {chips.length > 0 ? ` · ${chips.join(' · ')}` : ''}
            </span>
          </div>
          <button type="button" className="icon-btn danger" title="Quitar torrent" onClick={() => onRemove(snapshot)}>
            <Icon name="trash" size={16} />
          </button>
        </header>

        {plot && (
          <p className={`torrent-plot ${plotOpen ? 'is-open' : ''}`} onClick={() => setPlotOpen((value) => !value)}>
            {plot}
          </p>
        )}

        <div className="torrent-progress" aria-hidden="true">
          <span style={{ width: `${Math.min(100, snapshot.progress)}%` }} />
        </div>

        <div className="torrent-stats">
          <span>
            <strong>{snapshot.progress}%</strong> descargado
          </span>
          <span>↓ {formatSpeed(snapshot.downloadSpeed)}</span>
          <span>↑ {formatSpeed(snapshot.uploadSpeed)}</span>
          <span>{snapshot.peers} pares</span>
          {snapshot.timeRemaining > 0 && snapshot.progress < 100 && (
            <span>quedan {formatRemaining(snapshot.timeRemaining)}</span>
          )}
        </div>

        {snapshot.error && (
          <div className="alert error">
            <Icon name="info" size={14} />
            <span>{snapshot.error}</span>
          </div>
        )}

        {canPlay && main && (
          <button type="button" className="btn btn-primary torrent-main-play" onClick={() => onPlay(snapshot, main, details)}>
            <Icon name="play" size={16} />
            Reproducir mientras descarga
          </button>
        )}

        {videos.length === 0 && snapshot.files.length > 0 && (
          <p className="hint">Este torrent no contiene archivos de vídeo reconocibles.</p>
        )}

        {snapshot.files.length > 0 && (
          <details className="torrent-files-wrap">
            <summary>
              {snapshot.files.length} {snapshot.files.length === 1 ? 'archivo' : 'archivos'}
              {snapshot.files.length > 0 ? ` · ${formatBytes(snapshot.files.reduce((sum, file) => sum + file.length, 0))}` : ''}
            </summary>
            <div className="torrent-files">
              {snapshot.files.map((file) => {
                const playable = file.kind === 'video' && snapshot.ready
                const content = (
                  <>
                    <span className={`torrent-file-icon ${file.kind}`}>
                      <Icon
                        name={
                          file.kind === 'video'
                            ? 'play'
                            : file.kind === 'subtitle'
                              ? 'list'
                              : file.kind === 'image'
                                ? 'image'
                                : file.kind === 'nfo'
                                  ? 'info'
                                  : 'folder'
                        }
                        size={14}
                      />
                    </span>
                    <span className="torrent-file-name" title={file.name}>
                      {baseName(file.name)}
                    </span>
                    <span className="torrent-file-size">{formatBytes(file.length)}</span>
                    {playable && <span className="torrent-file-play">Reproducir</span>}
                  </>
                )

                return playable ? (
                  <button
                    type="button"
                    key={`${snapshot.id}-${file.index}`}
                    className="torrent-file is-playable"
                    onClick={() => onPlay(snapshot, file, details)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={`torrent-file ${file.kind}`} key={`${snapshot.id}-${file.index}`}>
                    {content}
                  </div>
                )
              })}
            </div>
          </details>
        )}

        {!snapshot.ready && !snapshot.error && (
          <p className="hint">
            Recibiendo metadatos del torrent… Si el enlace no tiene trackers y no hay pares, puede tardar o no llegar
            nunca.
          </p>
        )}
      </div>
    </article>
  )
}

export function TorrentsPage({ onPlayTorrent }: TorrentsPageProps) {
  const [items, setItems] = useState<TorrentSnapshot[]>([])
  const [magnet, setMagnet] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    let alive = true
    void window.nova.torrents
      .list()
      .then((list) => {
        if (alive) setItems(list)
      })
      .catch(() => undefined)

    const offUpdate = window.nova.torrents.onUpdate((snapshot) => {
      setItems((prev) => {
        const index = prev.findIndex((item) => item.id === snapshot.id)
        if (index < 0) return [snapshot, ...prev]
        const next = [...prev]
        next[index] = snapshot
        return next
      })
    })

    const offError = window.nova.torrents.onError((message) => {
      setNotice({ type: 'error', text: message })
    })

    return () => {
      alive = false
      offUpdate()
      offError()
    }
  }, [])

  const add = useCallback(
    async (input: { magnet?: string; path?: string }) => {
      if (busy) return
      const value = (input.magnet ?? input.path ?? '').trim()
      if (!value) {
        setNotice({ type: 'error', text: 'Pega un enlace magnet o abre un archivo .torrent.' })
        return
      }
      setBusy(true)
      setNotice({ type: 'info', text: 'Añadiendo torrent y buscando metadatos…' })
      try {
        const result = await window.nova.torrents.add(input.path ? { path: value } : { magnet: value })
        if (!result.ok) {
          setNotice({ type: 'error', text: result.message ?? 'No se pudo añadir el torrent.' })
          return
        }
        setMagnet('')
        setNotice(
          result.duplicate
            ? { type: 'info', text: result.message ?? 'Ese torrent ya está en la lista.' }
            : { type: 'ok', text: 'Torrent añadido. Pulsa Reproducir en cuanto aparezcan los archivos.' },
        )
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Error inesperado.' })
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  const openFile = async () => {
    const picked = await window.nova.torrents.openFile()
    if (picked) await add({ path: picked })
  }

  const clearCache = async () => {
    if (clearing) return
    if (!window.confirm('¿Borrar los archivos descargados de todos los torrents? Se detendrán los que estén activos.')) {
      return
    }
    setClearing(true)
    const result = await window.nova.torrents.clearCache()
    setClearing(false)
    setItems([])
    setNotice({ type: 'ok', text: `Caché borrada (${formatBytes(result.bytes)} liberados).` })
  }

  const remove = (snapshot: TorrentSnapshot) => {
    if (snapshot.ready && snapshot.progress < 100) {
      if (!window.confirm('Este torrent se está usando. ¿Quitarlo de todos modos?')) return
    }
    void window.nova.torrents.remove(snapshot.id)
    setItems((prev) => prev.filter((item) => item.id !== snapshot.id))
  }

  return (
    <div className="page torrents">
      <section className="torrent-add">
        <div className="card-head">
          <span className="card-icon">
            <Icon name="magnet" size={17} />
          </span>
          <div>
            <h3>Reproducir un enlace magnet</h3>
            <p>Pega el enlace que te han pasado o abre un archivo .torrent. Se reproduce mientras se descarga.</p>
          </div>
        </div>

        <div className="torrent-input-row">
          <input
            className="torrent-input"
            value={magnet}
            onChange={(event) => setMagnet(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add({ magnet })
            }}
            placeholder="magnet:?xt=urn:btih:…"
            spellCheck={false}
            disabled={busy}
          />
          <button type="button" className="btn btn-primary" onClick={() => void add({ magnet })} disabled={busy}>
            {busy ? <span className="spinner small" /> : <Icon name="plus" size={16} />}
            Añadir
          </button>
          <button type="button" className="btn" onClick={() => void openFile()} disabled={busy}>
            <Icon name="folder" size={16} />
            Archivo .torrent
          </button>
        </div>

        <div className="torrent-hints">
          <span>
            <Icon name="info" size={14} /> El vídeo se sirve desde tu equipo con búsqueda en el tiempo: puedes empezar
            a verlo sin esperar a que termine la descarga.
          </span>
          <span>
            <Icon name="wifi" size={14} /> Si no aparecen pares, revisa el firewall y que el enlace incluya trackers.
          </span>
        </div>

        {notice && (
          <div className={`alert ${notice.type === 'error' ? 'error' : notice.type === 'ok' ? 'ok' : ''}`}>
            <Icon name={notice.type === 'error' ? 'info' : notice.type === 'ok' ? 'check' : 'download'} size={15} />
            <span>{notice.text}</span>
          </div>
        )}
      </section>

      <div className="section-head">
        <div>
          <h3>Torrents activos</h3>
          <p className="muted">{items.length === 0 ? 'Ninguno por ahora' : `${items.length} en la lista`}</p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void clearCache()} disabled={clearing}>
            {clearing ? <span className="spinner small" /> : <Icon name="trash" size={14} />}
            Borrar caché
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="magnet"
          title="No hay ningún torrent cargado"
          description="Añade un enlace magnet arriba o abre un archivo .torrent. En cuanto lleguen los metadatos verás el póster, la sinopsis (si el torrent incluye .nfo) y podrás reproducir el vídeo."
        />
      ) : (
        <div className="torrent-list">
          {items.map((snapshot) => (
            <TorrentCard
              key={snapshot.id}
              snapshot={snapshot}
              onPlay={onPlayTorrent}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      <p className="hint legal">
        Reproduce solo contenido que tengas derecho a usar. Al usar BitTorrent tu dirección IP es visible para los
        demás pares del torrent. Los archivos se guardan temporalmente en la carpeta temporal de NovaTV hasta que
        pulses «Borrar caché».
      </p>
    </div>
  )
}
