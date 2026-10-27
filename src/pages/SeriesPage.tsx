import { useMemo, useState } from 'react'
import type { Channel, Playlist } from '../types'
import { useDb } from '../store'
import { PosterCard } from '../components/Cards'
import { VirtualGrid } from '../components/VirtualGrid'
import { EmptyState } from '../components/EmptyState'
import { SeriesDetail } from '../components/SeriesDetail'

interface SeriesPageProps {
  playlist: Playlist | null
  query: string
  onPlay: (channel: Channel, list: Channel[]) => void
}

export function SeriesPage({ playlist, query, onPlay }: SeriesPageProps) {
  const { isFavorite, toggleFavorite } = useDb()
  const [selected, setSelected] = useState<Channel | null>(null)
  const [group, setGroup] = useState('all')

  const series = useMemo(
    () => (playlist?.channels ?? []).filter((channel) => channel.kind === 'series'),
    [playlist],
  )

  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of series) {
      const key = item.group ?? 'Series'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30)
  }, [series])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return series.filter((item) => {
      if (group !== 'all' && (item.group ?? 'Series') !== group) return false
      if (!needle) return true
      return item.name.toLowerCase().includes(needle) || (item.group ?? '').toLowerCase().includes(needle)
    })
  }, [series, group, query])

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState icon="layers" title="Sin lista cargada" description="Añade una lista para ver tus series." />
      </div>
    )
  }

  return (
    <div className="page page-fixed">
      <div className="chips">
        <button type="button" className={`chip ${group === 'all' ? 'active' : ''}`} onClick={() => setGroup('all')}>
          Todas <em>{series.length.toLocaleString('es-ES')}</em>
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
          <strong>{filtered.length.toLocaleString('es-ES')}</strong> series
        </span>
        <span className="list-hint">Abre una serie para elegir temporada y episodio</span>
      </div>

      <VirtualGrid
        items={filtered}
        minColumnWidth={168}
        rowHeight={296}
        gap={16}
        empty={
          <EmptyState
            icon="layers"
            title={series.length === 0 ? 'Tu proveedor no ofrece series' : 'Sin resultados'}
            description={
              series.length === 0
                ? 'Solo aparecerán si la lista incluye series Xtream.'
                : 'Prueba con otro título o cambia de categoría.'
            }
          />
        }
        renderItem={(item) => (
          <PosterCard
            key={item.id}
            channel={item}
            subtitle={item.group}
            favorite={isFavorite(playlist.id, item.id)}
            onToggleFavorite={() => toggleFavorite(playlist.id, item.id)}
            onPlay={() => setSelected(item)}
          />
        )}
      />

      {selected && (
        <SeriesDetail
          series={selected}
          playlist={playlist}
          onClose={() => setSelected(null)}
          onPlay={(channel, list) => {
            setSelected(null)
            onPlay(channel, list)
          }}
        />
      )}
    </div>
  )
}
