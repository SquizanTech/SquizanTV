import type { TorrentFileInfo } from '../types'

export interface TorrentArtwork {
  poster: TorrentFileInfo | null
  backdrop: TorrentFileInfo | null
  logo: TorrentFileInfo | null
  nfo: TorrentFileInfo | null
}

export interface TorrentMeta {
  title: string
  year: string
  plot: string
  genre: string
  rating: string
  runtime: string
}

const POSTER_PATTERNS = [/^poster$/i, /^cover$/i, /^folder$/i, /^caratula$/i, /^portada$/i, /poster/i, /cover/i]
const BACKDROP_PATTERNS = [/^fanart$/i, /^backdrop$/i, /^background$/i, /^banner$/i, /^thumb$/i, /fanart/i, /backdrop/i]
const LOGO_PATTERNS = [/^clearlogo$/i, /^logo$/i, /clearlogo/i, /logo/i]

function fileBase(name: string): string {
  const parts = name.split(/[\\/]/)
  return parts[parts.length - 1] ?? name
}

function fileStem(name: string): string {
  return fileBase(name).replace(/\.[^.]+$/, '')
}

function scoreFor(name: string, patterns: RegExp[]): number {
  const stem = fileStem(name)
  let score = 0
  patterns.forEach((pattern, index) => {
    if (pattern.test(stem)) score = Math.max(score, 100 - index * 5)
  })
  if (/\b(small|thumb|preview)\b/i.test(stem)) score -= 15
  return score
}

function bestImage(files: TorrentFileInfo[], patterns: RegExp[]): TorrentFileInfo | null {
  let best: TorrentFileInfo | null = null
  let bestScore = 0
  for (const file of files) {
    if (file.kind !== 'image') continue
    const score = scoreFor(file.name, patterns)
    if (score > bestScore) {
      bestScore = score
      best = file
    }
  }
  return best
}

function bestNfo(files: TorrentFileInfo[]): TorrentFileInfo | null {
  const candidates = files.filter((file) => file.kind === 'nfo' && file.length < 1024 * 1024)
  if (candidates.length === 0) return null
  const rank = (file: TorrentFileInfo): number => {
    const stem = fileStem(file.name).toLowerCase()
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (stem === 'movie' || stem === 'tvshow' || stem === 'episodedetails') return 100
    if (ext === 'nfo') return 80
    if (/info|sinopsis|readme/.test(stem)) return 40
    return 10
  }
  return [...candidates].sort((a, b) => rank(b) - rank(a) || a.length - b.length)[0] ?? null
}

export function pickArtwork(files: TorrentFileInfo[]): TorrentArtwork {
  return {
    poster: bestImage(files, POSTER_PATTERNS),
    backdrop: bestImage(files, BACKDROP_PATTERNS),
    logo: bestImage(files, LOGO_PATTERNS),
    nfo: bestNfo(files),
  }
}

/** Convierte el nombre de un release en un titulo legible. */
export function cleanReleaseName(name: string): { title: string; year: string } {
  const base = fileBase(name)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*)\)/g, (match) => (/^(19|20)\d{2}$/.test(match.slice(1, -1)) ? match : ' '))
    .replace(
      /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|blu ray|bdrip|brrip|webrip|web dl|webdl|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc|aac|ac3|eac3|dts|ddp?5 1|5 1|10bit|8bit|proper|repack|extended|unrated|dual|latino|castellano|vos|vose|subs?)\b/gi,
      ' ',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .trim()

  const year = /\b(19\d{2}|20\d{2})\b/.exec(base)?.[1] ?? ''
  const title = base.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return { title: title || base || name, year }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
}

export function formatRuntime(minutes: string): string {
  const total = Number(minutes)
  if (!Number.isFinite(total) || total <= 0) return ''
  const hours = Math.floor(total / 60)
  const rest = Math.round(total % 60)
  return hours > 0 ? `${hours} h ${rest.toString().padStart(2, '0')} min` : `${rest} min`
}

/** Lee un .nfo estilo Kodi (XML) y devuelve los campos utiles. */
export function parseNfo(text: string): Partial<TorrentMeta> {
  if (!text) return {}
  const clean = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')

  const pick = (...tags: string[]): string => {
    for (const tag of tags) {
      const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(clean)
      if (match) {
        const value = decodeEntities(match[1])
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (value) return value
      }
    }
    return ''
  }

  const genres = [...clean.matchAll(/<genre(?:\s[^>]*)?>([\s\S]*?)<\/genre>/gi)]
    .map((match) => decodeEntities(match[1]).replace(/<[^>]+>/g, ' ').trim())
    .filter(Boolean)

  const plot = pick('plot', 'outline', 'overview', 'summary')
  if (!plot && !/<(movie|tvshow|episodedetails|musicvideo)\b/i.test(clean)) return {}

  return {
    title: pick('title', 'showtitle', 'originaltitle'),
    year: pick('year', 'premiered', 'releasedate').slice(0, 4),
    plot,
    genre: genres.join(', '),
    rating: pick('rating', 'votes').slice(0, 12),
    runtime: formatRuntime(pick('runtime')),
  }
}
