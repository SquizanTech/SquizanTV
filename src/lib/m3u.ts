import type { Channel, ChannelKind } from '../types'
import { hashString, isTransportStream } from './util'

export interface M3uParseResult {
  channels: Channel[]
  /** Primera fuente de EPG, por compatibilidad. */
  epgUrl?: string
  /** Todas las fuentes declaradas en el encabezado `url-tvg`. */
  epgUrls: string[]
  /** Segundos entre actualizaciones que pide la lista (`refresh`). */
  epgRefresh?: number
}

/**
 * Separa y limpia las URLs de EPG. El encabezado `#EXTM3U url-tvg="a,b,c"`
 * admite varias fuentes separadas por comas, y algunos proveedores usan
 * `x-tvg-url`, `tvg-url` o `x-tvg`.
 */
export function parseEpgUrls(value: string | undefined, target: string[] = []): string[] {
  if (!value) return target
  for (const part of value.split(/[,\n]/)) {
    const url = canonicalEpgUrl(part.trim())
    if (!/^https?:\/\//i.test(url)) continue
    if (!target.includes(url)) target.push(url)
  }
  return target
}

/**
 * `raw.githubusercontent.com/usuario/repo/refs/heads/rama/...` y
 * `.../usuario/repo/rama/...` son el mismo archivo. Se unifican para no
 * descargar dos veces una guía de 35 MB.
 */
function canonicalEpgUrl(url: string): string {
  return url.replace(/^(https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)refs\/heads\//i, '$1')
}

/** Fuentes de EPG de una lista ya guardada (incluye listas antiguas). */
export function playlistEpgUrls(playlist: { epgUrls?: string[]; epgUrl?: string }): string[] {
  const urls = parseEpgUrls(undefined, [])
  for (const url of playlist.epgUrls ?? []) parseEpgUrls(url, urls)
  parseEpgUrls(playlist.epgUrl, urls)
  return urls
}

function parseAttributes(meta: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z0-9_-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(meta)) !== null) {
    attrs[match[1].toLowerCase()] = match[2]
  }
  return attrs
}

const MOVIE_WORDS = /(\bvod\b|\bmovies?\b|\bpel[ií]culas?\b|\bcine\b|\bcinema\b|\bfilms?\b|\bestrenos\b)/i
const SERIES_WORDS = /(\bseries?\b|\bserie\b|\bnovelas?\b|\btelenovelas?\b|\bepisodios?\b|\btemporadas?\b)/i

export function inferKind(url: string, group = '', name = ''): ChannelKind {
  const lowerUrl = url.toLowerCase()
  if (/\/(movie|movies|vod|peliculas?|films?)\//.test(lowerUrl)) return 'movie'
  if (/\/(series|serie|episode|episodes)\//.test(lowerUrl)) return 'series'
  const haystack = `${group} ${name}`
  if (MOVIE_WORDS.test(haystack)) return 'movie'
  if (SERIES_WORDS.test(haystack)) return 'series'
  return 'live'
}

function toKind(value: string | undefined, fallback: ChannelKind): ChannelKind {
  if (value === 'live' || value === 'movie' || value === 'series') return value
  return fallback
}

/**
 * Parser tolerante de listas M3U/M3U8. Acepta atributos sin comillas y
 * etiquetas #EXTGRP, y descarta entradas que no apunten a HTTP(S).
 */
export function parseM3U(text: string, hintedKind?: ChannelKind): M3uParseResult {
  const lines = text.split(/\r?\n/)
  const channels: Channel[] = []
  let pending: { name: string; attrs: Record<string, string>; group?: string } | null = null
  const epgUrls: string[] = []
  let epgRefresh: number | undefined

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttributes(line)
      for (const key of ['url-tvg', 'x-tvg-url', 'tvg-url', 'x-tvg']) parseEpgUrls(attrs[key], epgUrls)
      const refresh = Number(attrs['refresh'])
      if (Number.isFinite(refresh) && refresh > 0) epgRefresh = refresh
      continue
    }

    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',')
      const meta = comma >= 0 ? line.slice(0, comma) : line
      const rawName = comma >= 0 ? line.slice(comma + 1).trim() : ''
      const attrs = parseAttributes(meta)
      const name = rawName || attrs['tvg-name'] || attrs['tvg-id'] || 'Sin nombre'
      pending = { name, attrs, group: attrs['group-title'] }
      continue
    }

    if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice(8).trim()
      continue
    }

    if (line.startsWith('#')) continue

    if (!pending) continue
    if (!/^https?:\/\//i.test(line)) {
      pending = null
      continue
    }

    const url = line
    const group = pending.group
    const kind = toKind(pending.attrs['nova-kind'], hintedKind ?? inferKind(url, group, pending.name))
    const duration = Number(pending.attrs['duration'])

    channels.push({
      id: hashString(`${url}|${pending.name}`),
      name: pending.name,
      url,
      fallbackUrl: isTransportStream(url) ? url : undefined,
      logo: pending.attrs['tvg-logo'] || pending.attrs['logo'] || undefined,
      group: group || 'General',
      tvgId: pending.attrs['tvg-id'] || undefined,
      kind,
      seriesName: pending.attrs['series-name'] || undefined,
      season: pending.attrs['season'] ? Number(pending.attrs['season']) : undefined,
      episode: pending.attrs['episode'] ? Number(pending.attrs['episode']) : undefined,
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      addedAt: Date.now(),
    })
    pending = null
  }

  return { channels, epgUrl: epgUrls[0], epgUrls, epgRefresh }
}

export function buildM3U(channels: Channel[]): string {
  const lines = ['#EXTM3U']
  for (const channel of channels) {
    const attrs = [
      channel.tvgId ? `tvg-id="${channel.tvgId}"` : '',
      channel.logo ? `tvg-logo="${channel.logo}"` : '',
      channel.group ? `group-title="${channel.group}"` : '',
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`#EXTINF:-1 ${attrs},${channel.name}`)
    lines.push(channel.url)
  }
  return lines.join('\n')
}
