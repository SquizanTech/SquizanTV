import { useMemo, useState } from 'react'
import type { Channel, Playlist } from '../types'
import { useDb } from '../store'
import { PosterCard } from '../components/Cards'
import { VirtualGrid } from '../components/VirtualGrid'
import { EmptyState } from '../components/EmptyState'

interface MoviesPageProps {
  playlist: Playlist | null
  query: string
  onPlay: (channel: Channel, list: Channel[]) => void
}

export function MoviesPage({ playlist, query, onPlay }: MoviesPageProps) {
  const { isFavorite, toggleFavorite } = useDb()
  const [group, setGroup] = useState('all')

  const movies = useMemo(
    () => (playlist?.channels ?? []).filter((channel) => channel.kind === 'movie'),
    [playlist],
  )

  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const movie of movies) {
      const key = movie.group ?? 'Películas'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30)
  }, [movies])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return movies.filter((movie) => {
      if (group !== 'all' && (movie.group ?? 'Películas') !== group) return false
      if (!needle) return true
      return movie.name.toLowerCase().includes(needle) || (movie.group ?? '').toLowerCase().includes(needle)
    })
  }, [movies, group, query])

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState icon="film" title="Sin lista cargada" description="Añade una lista para ver tu videoteca." />
      </div>
    )
  }

  return (
    <div className="page page-fixed">
      <div className="chips">
        <button type="button" className={`chip ${group === 'all' ? 'active' : ''}`} onClick={() => setGroup('all')}>
          Todas <em>{movies.length.toLocaleString('es-ES')}</em>
        </button>
        {groups.map(([name, count]) => (
          <button
            type="button"
            key={name}
            className={`chip ${group === name ? 'active' : ''}`}
            onClick={() => setGroup(name)}
            title={name}
          >
            {name} <em>{count}</em>
          </button>
        ))}
      </div>

      <div className="list-head">
        <span>
          <strong>{filtered.length.toLocaleString('es-ES')}</strong> películas
        </span>
      </div>

      <VirtualGrid
        items={filtered}
        minColumnWidth={168}
        rowHeight={296}
        gap={16}
        empty={
          <EmptyState
            icon="film"
            title={movies.length === 0 ? 'Tu proveedor no ofrece películas' : 'Sin resultados'}
            description={
              movies.length === 0
                ? 'Solo aparecerán si la lista incluye contenido VOD.'
                : 'Prueba con otro título o cambia de categoría.'
            }
          />
        }
        renderItem={(movie) => (
          <PosterCard
            key={movie.id}
            channel={movie}
            subtitle={movie.group}
            favorite={isFavorite(playlist.id, movie.id)}
            onToggleFavorite={() => toggleFavorite(playlist.id, movie.id)}
            onPlay={() => onPlay(movie, filtered)}
          />
        )}
      />
    </div>
  )
}
