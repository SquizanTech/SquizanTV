import { Icon } from './Icons'
import type { PageId, Playlist } from '../types'

interface SidebarProps {
  page: PageId
  onNavigate: (page: PageId) => void
  playlist: Playlist | null
  counts: { live: number; movies: number; series: number; favorites: number }
}

const nav: Array<{ id: PageId; label: string; icon: string; countKey?: 'live' | 'movies' | 'series' | 'favorites' }> = [
  { id: 'home', label: 'Inicio', icon: 'home' },
  { id: 'live', label: 'En directo', icon: 'tv', countKey: 'live' },
  { id: 'movies', label: 'Películas', icon: 'film', countKey: 'movies' },
  { id: 'series', label: 'Series', icon: 'layers', countKey: 'series' },
  { id: 'epg', label: 'Guía EPG', icon: 'calendar' },
  { id: 'torrents', label: 'Torrents', icon: 'magnet' },
  { id: 'favorites', label: 'Favoritos', icon: 'heart', countKey: 'favorites' },
  { id: 'history', label: 'Historial', icon: 'history' },
]

export function Sidebar({ page, onNavigate, playlist, counts }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <span className="brand-glow" />
          <Icon name="play" size={18} strokeWidth={2.4} />
        </div>
        <div className="brand-text">
          <strong>NovaTV</strong>
          <span>IPTV Player</span>
        </div>
      </div>

      <button type="button" className="playlist-chip" onClick={() => onNavigate('playlists')}>
        <span className="playlist-chip-icon">
          <Icon name="list" size={16} />
        </span>
        <span className="playlist-chip-text">
          <span className="playlist-chip-label">Lista activa</span>
          <strong title={playlist?.name}>{playlist?.name ?? 'Sin lista'}</strong>
        </span>
        <Icon name="down" size={15} />
      </button>

      <nav className="nav">
        <span className="nav-heading">Biblioteca</span>
        {nav.map((item) => {
          const count = item.countKey ? counts[item.countKey] : undefined
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {count !== undefined && count > 0 && <em>{count.toLocaleString('es-ES')}</em>}
            </button>
          )
        })}
      </nav>

      <nav className="nav nav-bottom">
        <span className="nav-heading">Sistema</span>
        <button
          type="button"
          className={`nav-item ${page === 'playlists' ? 'active' : ''}`}
          onClick={() => onNavigate('playlists')}
        >
          <Icon name="list" size={18} />
          <span>Mis listas</span>
        </button>
        <button
          type="button"
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <Icon name="settings" size={18} />
          <span>Ajustes</span>
        </button>
      </nav>

      <div className="sidebar-foot">
        <span className="status-dot" />
        <span>Reproductor listo</span>
      </div>
    </aside>
  )
}
