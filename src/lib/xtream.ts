import type { Channel, XtreamCreds } from '../types'
import { hashString } from './util'

interface RawCategory {
  category_id: string
  category_name: string
}

interface RawLive {
  num?: number
  name: string
  stream_id: number
  stream_icon?: string
  epg_channel_id?: string | null
  category_id?: string
}

interface RawVod {
  stream_id: number
  name: string
  stream_icon?: string
  category_id?: string
  container_extension?: string
  rating?: string
}

interface RawSeries {
  series_id: number
  name: string
  cover?: string
  category_id?: string
}

export interface SeriesEpisode {
  id: string
  title: string
  season: number
  episode: number
  url: string
  logo?: string
  plot?: string
}

export function normalizeServer(server: string): string {
  let value = server.trim()
  if (!value) return value
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  return value.replace(/\/+$/, '')
}

async function apiGet<T>(creds: XtreamCreds, action?: string, extra?: Record<string, string>): Promise<T> {
  const url = new URL(`${normalizeServer(creds.server)}/player_api.php`)
  url.searchParams.set('username', creds.username)
  url.searchParams.set('password', creds.password)
  if (action) url.searchParams.set('action', action)
  for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value)

  const response = await window.nova.net.fetch({ url: url.toString(), timeout: 25000 })
  if (!response.ok) {
    throw new Error(`El servidor respondio ${response.status}. Revisa la URL y las credenciales.`)
  }
  try {
    return JSON.parse(response.text) as T
  } catch {
    throw new Error('El servidor no devolvio JSON valido. Puede que la URL no sea Xtream Codes.')
  }
}

function categoryMap(categories: RawCategory[] | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  for (const category of categories ?? []) {
    map[String(category.category_id)] = category.category_name
  }
  return map
}

export interface XtreamResult {
  channels: Channel[]
  epgUrl: string
  accountStatus?: string
  expiresAt?: string
}

export async function fetchXtream(
  creds: XtreamCreds,
  onProgress?: (message: string) => void,
): Promise<XtreamResult> {
  const server = normalizeServer(creds.server)
  const user = encodeURIComponent(creds.username)
  const pass = encodeURIComponent(creds.password)
  const base = `${server}/live/${user}/${pass}`
  const now = Date.now()

  onProgress?.('Conectando con el servidor...')
  const info = await apiGet<{
    user_info?: { status?: string; exp_date?: string | null; auth?: number }
  }>(creds)

  if (info?.user_info && info.user_info.auth === 0) {
    throw new Error('Usuario o contrasena incorrectos.')
  }

  const channels: Channel[] = []

  onProgress?.('Descargando categorias...')
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    apiGet<RawCategory[]>(creds, 'get_live_categories').catch(() => []),
    apiGet<RawCategory[]>(creds, 'get_vod_categories').catch(() => []),
    apiGet<RawCategory[]>(creds, 'get_series_categories').catch(() => []),
  ])

  const liveMap = categoryMap(liveCats)
  const vodMap = categoryMap(vodCats)
  const seriesMap = categoryMap(seriesCats)

  onProgress?.('Descargando canales en directo...')
  const live = await apiGet<RawLive[]>(creds, 'get_live_streams').catch(() => [])
  for (const item of live ?? []) {
    const id = String(item.stream_id)
    channels.push({
      id: hashString(`live|${id}|${item.name}`),
      name: item.name,
      url: `${base}/${id}.m3u8`,
      fallbackUrl: `${base}/${id}.ts`,
      logo: item.stream_icon || undefined,
      group: liveMap[String(item.category_id)] ?? 'En directo',
      tvgId: item.epg_channel_id || undefined,
      kind: 'live',
      addedAt: now,
    })
  }

  onProgress?.('Descargando peliculas...')
  const vod = await apiGet<RawVod[]>(creds, 'get_vod_streams').catch(() => [])
  for (const item of vod ?? []) {
    const id = String(item.stream_id)
    const extension = item.container_extension || 'mp4'
    channels.push({
      id: hashString(`vod|${id}|${item.name}`),
      name: item.name,
      url: `${server}/movie/${user}/${pass}/${id}.${extension}`,
      logo: item.stream_icon || undefined,
      group: vodMap[String(item.category_id)] ?? 'Películas',
      kind: 'movie',
      addedAt: now,
    })
  }

  onProgress?.('Descargando series...')
  const series = await apiGet<RawSeries[]>(creds, 'get_series').catch(() => [])
  for (const item of series ?? []) {
    channels.push({
      id: hashString(`series|${item.series_id}|${item.name}`),
      name: item.name,
      url: '',
      logo: item.cover || undefined,
      cover: item.cover || undefined,
      group: seriesMap[String(item.category_id)] ?? 'Series',
      kind: 'series',
      seriesId: item.series_id,
      seriesName: item.name,
      addedAt: now,
    })
  }

  const epgUrl = `${server}/xmltv.php?username=${user}&password=${pass}`

  return {
    channels,
    epgUrl,
    accountStatus: info?.user_info?.status,
    expiresAt: info?.user_info?.exp_date ?? undefined,
  }
}

export async function fetchSeriesEpisodes(
  creds: XtreamCreds,
  seriesId: string | number,
): Promise<SeriesEpisode[]> {
  const server = normalizeServer(creds.server)
  const user = encodeURIComponent(creds.username)
  const pass = encodeURIComponent(creds.password)

  const data = await apiGet<{
    episodes?: Record<string, Array<Record<string, unknown>>>
    info?: Record<string, unknown>
  }>(creds, 'get_series_info', { series_id: String(seriesId) })

  const episodes: SeriesEpisode[] = []
  const grouped = data?.episodes ?? {}

  for (const [seasonKey, list] of Object.entries(grouped)) {
    for (const raw of list ?? []) {
      const id = String(raw.id ?? '')
      if (!id) continue
      const extension = String(raw.container_extension ?? 'mp4')
      const season = Number(raw.season ?? seasonKey) || 1
      const episode = Number(raw.episode_num ?? raw.episode ?? 0) || 0
      episodes.push({
        id,
        title: String(raw.title ?? `Episodio ${episode}`),
        season,
        episode,
        url: `${server}/series/${user}/${pass}/${id}.${extension}`,
        logo: typeof raw.info === 'object' && raw.info !== null ? String((raw.info as Record<string, unknown>).movie_image ?? '') || undefined : undefined,
        plot: typeof raw.info === 'object' && raw.info !== null ? String((raw.info as Record<string, unknown>).plot ?? '') || undefined : undefined,
      })
    }
  }

  episodes.sort((a, b) => (a.season === b.season ? a.episode - b.episode : a.season - b.season))
  return episodes
}
