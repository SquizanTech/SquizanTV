import { useEffect, useMemo, useState } from 'react'
import type { Channel, EpgData, Playlist } from '../types'
import { epgIdFor } from '../lib/xmltv'
import { playlistEpgUrls } from '../lib/m3u'
import { formatTime } from '../lib/util'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icons'

interface EpgPageProps {
  playlist: Playlist | null
  epg: EpgData | null
  loading: boolean
  error: string
  query: string
  onReload: () => void
  onPlay: (channel: Channel, list: Channel[]) => void
}

const WINDOW_HOURS = 12
const PX_PER_MIN = 3.1
const NAME_WIDTH = 196

export function EpgPage({ playlist, epg, loading, error, query, onReload, onPlay }: EpgPageProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  const windowStart = useMemo(() => {
    const date = new Date(now)
    date.setMinutes(Math.floor(date.getMinutes() / 30) * 30, 0, 0)
    return date.getTime() - 60 * 60000
  }, [now])

  const timelineWidth = WINDOW_HOURS * 60 * PX_PER_MIN
  const windowEnd = windowStart + WINDOW_HOURS * 3600000

  const channels = useMemo(() => {
    if (!playlist || !epg) return []
    const needle = query.trim().toLowerCase()
    return playlist.channels
      .filter((channel) => channel.kind === 'live' && epgIdFor(channel.tvgId, epg, channel.name))
      .filter((channel) => {
        if (!needle) return true
        return channel.name.toLowerCase().includes(needle) || (channel.group ?? '').toLowerCase().includes(needle)
      })
  }, [playlist, epg, query])

  const visible = channels.slice(0, 220)
  const nowLeft = ((now - windowStart) / 60000) * PX_PER_MIN

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState icon="calendar" title="Sin lista cargada" description="Añade una lista con EPG para ver la guía." />
      </div>
    )
  }

  if (playlistEpgUrls(playlist).length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon="calendar"
          title="Esta lista no tiene EPG"
          description="La lista no declara ninguna guía en su encabezado. Puedes añadir la URL del XMLTV en Mis listas, o usar una cuenta Xtream Codes (incluye xmltv.php automáticamente)."
        />
      </div>
    )
  }

  if (loading && !epg) {
    return (
      <div className="page">
        <div className="epg-loading">
          <span className="spinner" />
          <h3>Descargando la guía de programación...</h3>
          <p>Puede tardar un poco según el tamaño del XMLTV.</p>
        </div>
      </div>
    )
  }

  if (error && !epg) {
    return (
      <div className="page">
        <EmptyState
          icon="info"
          title="No se pudo cargar el EPG"
          description={error}
          action={
            <button type="button" className="btn btn-primary" onClick={onReload}>
              <Icon name="refresh" size={16} /> Reintentar
            </button>
          }
        />
      </div>
    )
  }

  if (!epg) {
    return (
      <div className="page">
        <EmptyState
          icon="calendar"
          title="Guía no disponible"
          description="Pulsa actualizar para descargar la programación."
          action={
            <button type="button" className="btn" onClick={onReload}>
              <Icon name="refresh" size={16} /> Cargar guía
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="page page-fixed">
      <div className="epg-toolbar">
        <span className="epg-meta">
          <Icon name="calendar" size={15} />
          {channels.length.toLocaleString('es-ES')} canales con guía · actualizado{' '}
          {formatTime(epg.fetchedAt)}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onReload} disabled={loading}>
          {loading ? <span className="spinner small" /> : <Icon name="refresh" size={15} />}
          Actualizar
        </button>
      </div>

      {channels.length === 0 ? (
        <EmptyState
          icon="search"
          title="Sin coincidencias"
          description="Ningún canal de la lista coincide con la guía: ni por tvg-id ni por nombre."
        />
      ) : (
        <div className="epg-scroll">
          <div className="epg-content" style={{ width: NAME_WIDTH + timelineWidth }}>
            <div className="epg-header">
              <div className="epg-corner">Canal</div>
              <div className="epg-ruler" style={{ width: timelineWidth }}>
                {Array.from({ length: WINDOW_HOURS }).map((_, index) => (
                  <div
                    key={index}
                    className="epg-hour"
                    style={{ left: index * 60 * PX_PER_MIN, width: 60 * PX_PER_MIN }}
                  >
                    {formatTime(windowStart + index * 3600000)}
                  </div>
                ))}
                {nowLeft >= 0 && nowLeft <= timelineWidth && <div className="epg-now" style={{ left: nowLeft }} />}
              </div>
            </div>

            {visible.map((channel) => {
              const id = epgIdFor(channel.tvgId, epg, channel.name)
              const programmes = id ? epg.byChannel[id] ?? [] : []
              return (
                <div className="epg-row" key={channel.id}>
                  <div className="epg-channel" style={{ width: NAME_WIDTH }}>
                    <div className="epg-channel-logo">
                      {channel.logo ? (
                        <img src={channel.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <Icon name="tv" size={16} />
                      )}
                    </div>
                    <span title={channel.name}>{channel.name}</span>
                  </div>
                  <div className="epg-track" style={{ width: timelineWidth }}>
                    {programmes
                      .filter((item) => item.stop > windowStart && item.start < windowEnd)
                      .map((item) => {
                        const left = Math.max(0, ((item.start - windowStart) / 60000) * PX_PER_MIN)
                        const width =
                          (Math.min(item.stop, windowEnd) - Math.max(item.start, windowStart)) / 60000 * PX_PER_MIN
                        if (width < 4) return null
                        const isNow = item.start <= now && item.stop > now
                        return (
                          <button
                            type="button"
                            key={`${item.start}-${item.title}`}
                            className={`epg-program ${isNow ? 'is-now' : ''}`}
                            style={{ left, width }}
                            onClick={() => onPlay(channel, channels)}
                            title={`${item.title} · ${formatTime(item.start)} - ${formatTime(item.stop)}`}
                          >
                            <span className="epg-program-title">{item.title}</span>
                            {width > 110 && (
                              <span className="epg-program-time">
                                {formatTime(item.start)} - {formatTime(item.stop)}
                              </span>
                            )}
                          </button>
                        )
                      })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {channels.length > visible.length && (
        <p className="list-hint epg-limit">
          Mostrando los primeros {visible.length} canales. Usa el buscador para encontrar otro.
        </p>
      )}
    </div>
  )
}
