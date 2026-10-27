import { useMemo } from 'react'
import type { Channel, Playlist } from '../types'
import { useDb } from '../store'
import { ChannelRow } from '../components/Cards'
import { VirtualGrid } from '../components/VirtualGrid'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icons'

interface HistoryPageProps {
  query: string
  onPlay: (channel: Channel, list: Channel[], playlist: Playlist) => void
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'ahora mismo'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  return `hace ${days} d`
}

export function HistoryPage({ query, onPlay }: HistoryPageProps) {
  const { db, toggleFavorite, isFavorite, clearHistory } = useDb()

  const items = useMemo(() => {
    const resolved: Array<{ playlist: Playlist; channel: Channel; at: number }> = []
    for (const entry of db.history) {
      const playlist = db.playlists.find((item) => item.id === entry.playlistId)
      const channel = playlist?.channels.find((item) => item.id === entry.channelId)
      if (playlist && channel) resolved.push({ playlist, channel, at: entry.at })
    }
    const needle = query.trim().toLowerCase()
    return needle ? resolved.filter(({ channel }) => channel.name.toLowerCase().includes(needle)) : resolved
  }, [db.history, db.playlists, query])

  if (db.history.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon="history"
          title="Aún no has visto nada"
          description="Lo último que reproduzcas aparecerá aquí para volver en un clic."
        />
      </div>
    )
  }

  const list = items.map((item) => item.channel)

  return (
    <div className="page page-fixed">
      <div className="list-head">
        <span>
          <strong>{items.length.toLocaleString('es-ES')}</strong> elementos recientes
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={clearHistory}>
          <Icon name="trash" size={14} /> Vaciar historial
        </button>
      </div>
      <VirtualGrid
        items={items}
        minColumnWidth={286}
        rowHeight={82}
        gap={12}
        empty={<EmptyState icon="search" title="Sin resultados" description="Prueba con otro nombre." />}
        renderItem={({ playlist, channel, at }) => (
          <ChannelRow
            key={`${playlist.id}-${channel.id}`}
            channel={channel}
            subtitle={`${timeAgo(at)} · ${playlist.name}`}
            favorite={isFavorite(playlist.id, channel.id)}
            onToggleFavorite={() => toggleFavorite(playlist.id, channel.id)}
            onPlay={() => onPlay(channel, list, playlist)}
          />
        )}
      />
    </div>
  )
}
