import { useEffect, useMemo, useState } from 'react'
import type { Channel, Playlist } from '../types'
import { fetchSeriesEpisodes, type SeriesEpisode } from '../lib/xtream'
import { hashString, initials } from '../lib/util'
import { Icon } from './Icons'

interface SeriesDetailProps {
  series: Channel
  playlist: Playlist
  onClose: () => void
  onPlay: (channel: Channel, list: Channel[]) => void
}

export function SeriesDetail({ series, playlist, onClose, onPlay }: SeriesDetailProps) {
  const [episodes, setEpisodes] = useState<SeriesEpisode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [season, setSeason] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!playlist.xtream || series.seriesId == null) {
        setError('Esta serie no pertenece a una lista Xtream Codes.')
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const list = await fetchSeriesEpisodes(playlist.xtream, series.seriesId)
        if (!alive) return
        if (list.length === 0) setError('El servidor no devolvio episodios para esta serie.')
        setEpisodes(list)
        setSeason(list[0]?.season ?? null)
      } catch (cause) {
        if (!alive) return
        setError(cause instanceof Error ? cause.message : 'No se pudieron cargar los episodios.')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [playlist.xtream, series.seriesId])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const channels = useMemo<Channel[]>(
    () =>
      episodes.map((episode) => ({
        id: hashString(`ep|${series.seriesId}|${episode.id}`),
        name: `${series.name} · T${episode.season}E${String(episode.episode).padStart(2, '0')}${episode.title ? ` · ${episode.title}` : ''}`,
        url: episode.url,
        logo: episode.logo || series.logo,
        group: series.name,
        kind: 'movie',
        seriesName: series.name,
        season: episode.season,
        episode: episode.episode,
        addedAt: Date.now(),
      })),
    [episodes, series],
  )

  const seasons = useMemo(
    () => Array.from(new Set(episodes.map((episode) => episode.season))).sort((a, b) => a - b),
    [episodes],
  )

  const visible = episodes.filter((episode) => episode.season === season)
  const visibleChannels = channels.filter((channel) => channel.season === season)

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal series-modal">
        <div className="series-hero">
          <div className="series-art">
            {series.logo ? (
              <img src={series.logo} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span>{initials(series.name)}</span>
            )}
          </div>
          <div className="series-info">
            <span className="eyebrow">{series.group ?? 'Serie'}</span>
            <h2>{series.name}</h2>
            <p>
              {episodes.length > 0
                ? `${episodes.length} episodios · ${seasons.length} ${seasons.length === 1 ? 'temporada' : 'temporadas'}`
                : 'Serie'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="x" size={19} />
          </button>
        </div>

        {seasons.length > 1 && (
          <div className="season-tabs">
            {seasons.map((value) => (
              <button
                key={value}
                type="button"
                className={season === value ? 'active' : ''}
                onClick={() => setSeason(value)}
              >
                T{value}
              </button>
            ))}
          </div>
        )}

        <div className="modal-body series-body">
          {loading && (
            <div className="progress-box">
              <span className="spinner small" />
              <span>Cargando episodios...</span>
            </div>
          )}

          {error && (
            <div className="alert error">
              <Icon name="info" size={16} />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && visible.length === 0 && (
            <p className="hint">Esta temporada no tiene episodios disponibles.</p>
          )}

          <div className="episode-list">
            {visible.map((episode, index) => (
              <button
                key={episode.id}
                type="button"
                className="episode"
                onClick={() => {
                  const channel = visibleChannels[index]
                  if (channel) onPlay(channel, visibleChannels)
                }}
              >
                <span className="episode-num">{String(episode.episode).padStart(2, '0')}</span>
                <span className="episode-meta">
                  <strong>{episode.title || `Episodio ${episode.episode}`}</strong>
                  {episode.plot && <em>{episode.plot}</em>}
                </span>
                <span className="episode-play">
                  <Icon name="play" size={15} />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
