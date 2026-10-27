import { Icon } from './Icons'
import type { PageId } from '../types'

interface TopbarProps {
  page: PageId
  query: string
  onQuery: (value: string) => void
  onAdd: () => void
  showSearch?: boolean
  showAdd?: boolean
}

const titles: Record<PageId, string> = {
  home: 'Inicio',
  live: 'En directo',
  movies: 'Películas',
  series: 'Series',
  discover: 'Descubrir',
  epg: 'Guía de programación',
  torrents: 'Torrents',
  favorites: 'Favoritos',
  history: 'Historial',
  playlists: 'Mis listas',
  settings: 'Ajustes',
}

export function Topbar({ page, query, onQuery, onAdd, showSearch = true, showAdd = true }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{titles[page]}</h1>
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
        {showAdd && (
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" size={16} />
            <span>Añadir lista</span>
          </button>
        )}
      </div>
    </header>
  )
}
