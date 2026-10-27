import { useMemo } from 'react'
import type { Channel, Playlist } from '../types'
import { useDb } from '../store'
import { ChannelRow } from '../components/Cards'
import { VirtualGrid } from '../components/VirtualGrid'
import { EmptyState } from '../components/EmptyState'

interface FavoritesPageProps {
  query: string
  onPlay: (channel: Channel, list: Channel[], playlist: Playlist) => void
}

interface Resolved {
  playlist: Playlist
  channel: Channel
}

export function FavoritesPage({ query, onPlay }: FavoritesPageProps) {
  const { db, toggleFavorite } = useDb()

  const items = useMemo<Resolved[]>(() => {
    const resolved: Resolved[] = []
    for (const key of db.favorites) {
      const separator = key.indexOf('::')
      if (separator < 0) continue
      const playlistId = key.slice(0, separator)
      const channelId = key.slice(separator + 2)
      const playlist = db.playlists.find((entry) => entry.id === playlistId)
      const channel = playlist?.channels.find((entry) => entry.id === channelId)
      if (playlist && channel) resolved.push({ playlist, channel })
    }
    const needle = query.trim().toLowerCase()
    return needle
      ? resolved.filter(({ channel }) => channel.name.toLowerCase().includes(needle))
      : resolved
  }, [db.favorites, db.playlists, query])

  if (items.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon="heart"
          title={db.favorites.length === 0 ? 'Todavía no tienes favoritos' : 'Sin resultados'}
          description={
            db.favorites.length === 0
              ? 'Pulsa el corazón en cualquier canal, película o serie para guardarlo aquí.'
              : 'Prueba con otro nombre.'
          }
        />
      </div>
    )
  }

  const list = items.map((item) => item.channel)

  return (
    <div className="page page-fixed">
      <div className="list-head">
        <span>
          <strong>{items.length.toLocaleString('es-ES')}</strong> favoritos
        </span>
      </div>
      <VirtualGrid
        items={items}
        minColumnWidth={286}
        rowHeight={82}
        gap={12}
        renderItem={({ playlist, channel }) => (
          <ChannelRow
            key={`${playlist.id}-${channel.id}`}
            channel={channel}
            subtitle={`${channel.group ?? ''} · ${playlist.name}`}
            favorite
            onToggleFavorite={() => toggleFavorite(playlist.id, channel.id)}
            onPlay={() => onPlay(channel, list, playlist)}
          />
        )}
      />
    </div>
  )
}
