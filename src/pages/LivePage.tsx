import { useEffect, useMemo, useState } from 'react'
import type { Channel, EpgData, Playlist } from '../types'
import { useDb } from '../store'
import { epgIdFor, programAt } from '../lib/xmltv'
import { ChannelRow } from '../components/Cards'
import { VirtualGrid } from '../components/VirtualGrid'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icons'

interface LivePageProps {
  playlist: Playlist | null
  query: string
  epg: EpgData | null
  onPlay: (channel: Channel, list: Channel[]) => void
}

export function LivePage({ playlist, query, epg, onPlay }: LivePageProps) {
  const { isFavorite, toggleFavorite } = useDb()
  const [group, setGroup] = useState('all')

  const live = useMemo(
    () => (playlist?.channels ?? []).filter((channel) => channel.kind === 'live'),
    [playlist],
  )

  useEffect(() => {
    setGroup('all')
  }, [playlist?.id])

  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const channel of live) {
      const key = channel.group ?? 'General'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
  }, [live])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return live.filter((channel) => {
      if (group !== 'all' && (channel.group ?? 'General') !== group) return false
      if (!needle) return true
      return (
        channel.name.toLowerCase().includes(needle) ||
        (channel.group ?? '').toLowerCase().includes(needle)
      )
    })
  }, [live, group, query])

  const nowFor = (channel: Channel) =>
    programAt(epg?.byChannel[epgIdFor(channel.tvgId, epg) ?? ''] ?? [], Date.now())?.title

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState
          icon="tv"
          title="No hay ninguna lista cargada"
          description="Añade una lista M3U o una cuenta Xtream Codes para empezar a ver canales."
        />
      </div>
    )
  }

  return (
    <div className="page page-fixed">
      <div className="chips">
        <button type="button" className={`chip ${group === 'all' ? 'active' : ''}`} onClick={() => setGroup('all')}>
          Todos <em>{live.length.toLocaleString('es-ES')}</em>
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
          <strong>{filtered.length.toLocaleString('es-ES')}</strong> canales
          {group !== 'all' ? ` en ${group}` : ''}
          {query ? ` para “${query}”` : ''}
        </span>
        <span className="list-hint">
          <Icon name="info" size={14} /> Haz clic en un canal para reproducirlo
        </span>
      </div>

      <VirtualGrid
        items={filtered}
        minColumnWidth={286}
        rowHeight={82}
        gap={12}
        empty={
          <EmptyState
            icon="search"
            title="Sin resultados"
            description="Prueba con otro nombre o cambia de categoría."
          />
        }
        renderItem={(channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            now={nowFor(channel)}
            favorite={isFavorite(playlist.id, channel.id)}
            onToggleFavorite={() => toggleFavorite(playlist.id, channel.id)}
            onPlay={() => onPlay(channel, filtered)}
          />
        )}
      />
    </div>
  )
}
