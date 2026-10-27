import { Icon } from './Icons'
import type { PageId } from '../types'

interface TopbarProps {
  page: PageId
  query: string
  onQuery: (value: string) => void
  onAdd: () => void
  playlistName?: string
  showSearch?: boolean
}

const titles: Record<PageId, { title: string; subtitle: string }> = {
  home: { title: 'Inicio', subtitle: 'Todo tu entretenimiento en un solo lugar' },
  live: { title: 'En directo', subtitle: 'Canales de television en vivo' },
  movies: { title: 'Películas', subtitle: 'Tu videoteca a la carta' },
  series: { title: 'Series', subtitle: 'Temporadas y episodios' },
  epg: { title: 'Guía de programación', subtitle: 'Que hay ahora y despues' },
  torrents: { title: 'Torrents', subtitle: 'Reproduce enlaces magnet y archivos .torrent' },
  favorites: { title: 'Favoritos', subtitle: 'Lo que no quieres perderte' },
  history: { title: 'Historial', subtitle: 'Vuelve a lo ultimo que viste' },
  playlists: { title: 'Mis listas', subtitle: 'Gestiona M3U y Xtream Codes' },
  settings: { title: 'Ajustes', subtitle: 'Apariencia, EPG y actualizaciones' },
}

export function Topbar({ page, query, onQuery, onAdd, playlistName, showSearch = true }: TopbarProps) {
  const info = titles[page]
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{info.title}</h1>
        <span>{info.subtitle}</span>
      </div>

      <div className="topbar-actions">
        {showSearch && (
          <label className="search">
            <Icon name="search" size={16} />
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder={page === 'epg' ? 'Buscar canal...' : 'Buscar en la lista...'}
              spellCheck={false}
            />
            {query && (
              <button type="button" className="search-clear" onClick={() => onQuery('')} title="Limpiar">
                <Icon name="x" size={13} />
              </button>
            )}
          </label>
        )}
        {playlistName && page !== 'playlists' && (
          <span className="topbar-playlist" title={playlistName}>
            <Icon name="wifi" size={14} />
            {playlistName}
          </span>
        )}
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          <Icon name="plus" size={16} />
          <span>Añadir lista</span>
        </button>
      </div>
    </header>
  )
}
