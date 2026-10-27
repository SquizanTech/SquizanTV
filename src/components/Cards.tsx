import { useState } from 'react'
import type { Channel } from '../types'
import { initials } from '../lib/util'
import { Icon } from './Icons'

interface ChannelRowProps {
  channel: Channel
  subtitle?: string
  now?: string
  favorite?: boolean
  onPlay: () => void
  onToggleFavorite?: () => void
}

export function ChannelRow({ channel, subtitle, now, favorite, onPlay, onToggleFavorite }: ChannelRowProps) {
  const [failed, setFailed] = useState(false)

  return (
    <div
      className="ch-card"
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPlay()
        }
      }}
    >
      <div className="ch-logo">
        {channel.logo && !failed ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : (
          <span>{initials(channel.name)}</span>
        )}
      </div>
      <div className="ch-meta">
        <span className="ch-name" title={channel.name}>
          {channel.name}
        </span>
        <span className="ch-sub">
          {now ? (
            <>
              <span className="dot-live" /> {now}
            </>
          ) : (
            subtitle || channel.group || 'Sin categoria'
          )}
        </span>
      </div>
      <div className="ch-actions">
        {onToggleFavorite && (
          <button
            type="button"
            className={`icon-btn ${favorite ? 'is-fav' : ''}`}
            title={favorite ? 'Quitar de favoritos' : 'Anadir a favoritos'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite()
            }}
          >
            <Icon name="heart" size={16} />
          </button>
        )}
        <span className="ch-play">
          <Icon name="play" size={15} />
        </span>
      </div>
    </div>
  )
}

interface PosterCardProps {
  channel: Channel
  subtitle?: string
  onPlay: () => void
  onToggleFavorite?: () => void
  favorite?: boolean
}

export function PosterCard({ channel, subtitle, onPlay, onToggleFavorite, favorite }: PosterCardProps) {
  const [failed, setFailed] = useState(false)

  return (
    <div
      className="poster-card"
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPlay()
        }
      }}
    >
      <div className="poster-art">
        {channel.logo && !failed ? (
          <img src={channel.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        ) : (
          <span className="poster-initials">{initials(channel.name)}</span>
        )}
        <span className="poster-overlay">
          <span className="poster-play">
            <Icon name="play" size={18} />
          </span>
        </span>
        {onToggleFavorite && (
          <button
            type="button"
            className={`icon-btn poster-fav ${favorite ? 'is-fav' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite()
            }}
            title={favorite ? 'Quitar de favoritos' : 'Anadir a favoritos'}
          >
            <Icon name="heart" size={15} />
          </button>
        )}
      </div>
      <span className="poster-title" title={channel.name}>
        {channel.name}
      </span>
      <span className="poster-sub">{subtitle || channel.group || ''}</span>
    </div>
  )
}
