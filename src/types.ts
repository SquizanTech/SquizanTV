export type ChannelKind = 'live' | 'movie' | 'series'

export interface Channel {
  id: string
  name: string
  url: string
  fallbackUrl?: string
  logo?: string
  group?: string
  tvgId?: string
  kind: ChannelKind
  seriesName?: string
  seriesId?: string | number
  season?: number
  episode?: number
  cover?: string
  duration?: number
  addedAt: number
  /** Pistas de subtítulo disponibles (torrents). */
  subtitleTracks?: TorrentSubtitleTrack[]
}

export interface TorrentSubtitleTrack {
  index: number
  name: string
  language: string
  url: string
}

export interface SubtitleFile {
  /** URL del servidor de torrents o null si es un archivo local abierto a mano. */
  url: string | null
  name: string
  language: string
}

export interface XtreamCreds {
  server: string
  username: string
  password: string
}

export interface Playlist {
  id: string
  name: string
  type: 'm3u' | 'xtream'
  source?: string
  xtream?: XtreamCreds
  /** Primera fuente de EPG (compatibilidad con versiones anteriores). */
  epgUrl?: string
  /** Fuentes de EPG declaradas por la lista (`url-tvg`). */
  epgUrls?: string[]
  /** Segundos entre actualizaciones (`refresh` del encabezado M3U). */
  epgRefresh?: number
  channels: Channel[]
  createdAt: number
  updatedAt: number
}

export interface HistoryEntry {
  key: string
  channelId: string
  playlistId: string
  at: number
}

export interface AppSettings {
  theme: 'dark' | 'light'
  volume: number
  updateFeed: string
  epgAutoRefresh: boolean
}

export interface DB {
  version: 1
  playlists: Playlist[]
  favorites: string[]
  history: HistoryEntry[]
  settings: AppSettings
  activePlaylist: string | null
  addons: StremioAddon[]
}

/* ---------- Addons de Stremio (catálogos) ---------- */

export interface StremioCatalogExtra {
  name: string
  options?: string[]
  isRequired?: boolean
}

export interface StremioCatalog {
  type: string
  id: string
  name: string
  extra?: StremioCatalogExtra[]
}

export interface StremioAddon {
  /** id del manifest, p. ej. com.linvo.cinemeta */
  manifestId: string
  /** URL de transporte normalizada, con barra final */
  url: string
  name: string
  description: string
  version: string
  logo: string
  types: string[]
  catalogs: StremioCatalog[]
  resources: string[]
  idPrefixes: string[]
  enabled: boolean
  addedAt: number
}

export interface CatalogMeta {
  id: string
  type: string
  name: string
  poster?: string
  posterShape?: 'poster' | 'square' | 'landscape'
  background?: string
  logo?: string
  description?: string
  releaseInfo?: string
  imdbRating?: string
  genres?: string[]
  runtime?: string
  cast?: string[]
  videos?: Array<{ id: string; title?: string; season?: number; episode?: number; released?: string }>
}

export interface AddonStream {
  name?: string
  title?: string
  description?: string
  url?: string
  infoHash?: string
  fileIdx?: number
  sources?: string[]
  externalUrl?: string
  behaviorHints?: { notWebReady?: boolean; bingeGroup?: string; filename?: string }
}

export interface EpgProgramme {
  channel: string
  start: number
  stop: number
  title: string
  desc?: string
  category?: string
}

export interface EpgData {
  channels: Record<string, string>
  programmes: EpgProgramme[]
  byChannel: Record<string, EpgProgramme[]>
  fetchedAt: number
  source: string
}

export interface AddTorrentResult {
  ok: boolean
  id?: string
  message?: string
  duplicate?: boolean
}

export interface TorrentFileInfo {
  index: number
  name: string
  length: number
  progress: number
  kind: 'video' | 'subtitle' | 'image' | 'nfo' | 'other'
}

export interface TorrentDetails {
  title: string
  originalTitle: string
  plot: string
  year: string
  genre: string
  rating: string
  runtime: string
  posterUrl: string
  backdropUrl: string
  logoUrl: string
  subtitles: SubtitleFile[]
}

export interface TorrentSnapshot {
  id: string
  name: string
  infoHash: string
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  timeRemaining: number
  ready: boolean
  streamBase: string
  error: string
  files: TorrentFileInfo[]
  createdAt: number
}

export type PageId =
  | 'home'
  | 'live'
  | 'movies'
  | 'series'
  | 'discover'
  | 'epg'
  | 'torrents'
  | 'favorites'
  | 'history'
  | 'playlists'
  | 'settings'
