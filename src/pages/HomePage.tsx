import { useMemo } from 'react'
import type { Channel, EpgData, PageId, Playlist } from '../types'
import { useDb } from '../store'
import { epgIdFor, programAt } from '../lib/xmltv'
import { ChannelRow } from '../components/Cards'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icons'

interface HomePageProps {
  playlist: Playlist | null
  epg: EpgData | null
  onAdd: () => void
  onNavigate: (page: PageId) => void
  onPlay: (channel: Channel, list: Channel[]) => void
}

export function HomePage({ playlist, epg, onAdd, onNavigate, onPlay }: HomePageProps) {
  const { db, isFavorite, toggleFavorite } = useDb()

  const counts = useMemo(() => {
    const channels = playlist?.channels ?? []
    return {
      live: channels.filter((item) => item.kind === 'live').length,
      movies: channels.filter((item) => item.kind === 'movie').length,
      series: channels.filter((item) => item.kind === 'series').length,
      favorites: db.favorites.filter((key) => key.startsWith(`${playlist?.id}::`)).length,
    }
  }, [playlist, db.favorites])

  const history = useMemo(() => {
    if (!playlist) return []
    return db.history
      .filter((item) => item.playlistId === playlist.id)
      .map((item) => playlist.channels.find((channel) => channel.id === item.channelId))
      .filter((channel): channel is Channel => Boolean(channel))
      .slice(0, 6)
  }, [db.history, playlist])

  const liveNow = useMemo(() => {
    if (!playlist) return []
    const live = playlist.channels.filter((channel) => channel.kind === 'live')
    const withEpg = live.filter((channel) => programAt(epg?.byChannel[epgIdFor(channel.tvgId, epg, channel.name) ?? ''] ?? [], Date.now()))
    return (withEpg.length > 0 ? withEpg : live).slice(0, 8)
  }, [playlist, epg])

  const nowFor = (channel: Channel) =>
    programAt(epg?.byChannel[epgIdFor(channel.tvgId, epg, channel.name) ?? ''] ?? [], Date.now())?.title

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot-live" /> Reproducción lista
          </span>
          <h2>
            Tu televisión,
            <br />
            <span>como debe verse.</span>
          </h2>
          <p>
            Listas M3U, Xtream Codes, guía de programación y reproductor HLS/MPEG-TS en un solo lugar.
            Todo queda en tu equipo.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn btn-primary" onClick={() => onNavigate(playlist ? 'live' : 'playlists')}>
              <Icon name={playlist ? 'play' : 'plus'} size={16} />
              {playlist ? 'Ver en directo' : 'Añadir mi primera lista'}
            </button>
            {playlist && (
              <button type="button" className="btn btn-ghost" onClick={() => onNavigate('epg')}>
                <Icon name="calendar" size={16} /> Abrir guía EPG
              </button>
            )}
          </div>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <span className="stat-icon"><Icon name="tv" size={17} /></span>
            <strong>{counts.live.toLocaleString('es-ES')}</strong>
            <span>Canales en directo</span>
          </div>
          <div className="stat">
            <span className="stat-icon"><Icon name="film" size={17} /></span>
            <strong>{counts.movies.toLocaleString('es-ES')}</strong>
            <span>Películas</span>
          </div>
          <div className="stat">
            <span className="stat-icon"><Icon name="layers" size={17} /></span>
            <strong>{counts.series.toLocaleString('es-ES')}</strong>
            <span>Series</span>
          </div>
          <div className="stat">
            <span className="stat-icon"><Icon name="heart" size={17} /></span>
            <strong>{counts.favorites.toLocaleString('es-ES')}</strong>
            <span>Favoritos</span>
          </div>
        </div>
      </section>

      {!playlist && (
        <section className="onboarding">
          <div className="onboarding-head">
            <h3>Empieza en tres pasos</h3>
            <p>Sin cuentas, sin nube y sin suscripciones: tu contenido se queda en tu PC.</p>
          </div>
          <div className="onboarding-steps">
            <div className="step">
              <span className="step-num">1</span>
              <strong>Añade una lista</strong>
              <p>Pega la URL de tu M3U o entra con tu cuenta Xtream Codes.</p>
            </div>
            <div className="step">
              <span className="step-num">2</span>
              <strong>Activa el EPG</strong>
              <p>La guía se descarga sola desde la lista o desde tu proveedor.</p>
            </div>
            <div className="step">
              <span className="step-num">3</span>
              <strong>Disfruta</strong>
              <p>Reproduce en directo o a la carta con HLS y MPEG-TS.</p>
            </div>
          </div>
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" size={16} /> Añadir lista ahora
          </button>
        </section>
      )}

      {playlist && history.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h3>Continuar viendo</h3>
            <button type="button" className="link-btn" onClick={() => onNavigate('history')}>
              Ver historial <Icon name="right" size={14} />
            </button>
          </div>
          <div className="grid-rows">
            {history.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                onPlay={() => onPlay(channel, history)}
                favorite={isFavorite(playlist.id, channel.id)}
                onToggleFavorite={() => toggleFavorite(playlist.id, channel.id)}
              />
            ))}
          </div>
        </section>
      )}

      {playlist && liveNow.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h3>Ahora en directo</h3>
            <button type="button" className="link-btn" onClick={() => onNavigate('live')}>
              Ver todos <Icon name="right" size={14} />
            </button>
          </div>
          <div className="grid-rows">
            {liveNow.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                now={nowFor(channel)}
                onPlay={() => onPlay(channel, liveNow)}
                favorite={isFavorite(playlist.id, channel.id)}
                onToggleFavorite={() => toggleFavorite(playlist.id, channel.id)}
              />
            ))}
          </div>
        </section>
      )}

      {playlist && counts.live === 0 && counts.movies === 0 && counts.series === 0 && (
        <EmptyState
          icon="info"
          title="La lista está vacía"
          description="Vuelve a cargarla o revisa que el proveedor siga activo."
          action={
            <button type="button" className="btn" onClick={() => onNavigate('playlists')}>
              <Icon name="refresh" size={16} /> Gestionar listas
            </button>
          }
        />
      )}
    </div>
  )
}
