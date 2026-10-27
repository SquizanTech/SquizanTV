import { XMLParser } from 'fast-xml-parser'
import type { EpgData, EpgProgramme } from '../types'

function textOf(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return textOf(value[0])
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('#text' in record) return textOf(record['#text'])
  }
  return ''
}

/** Convierte "20260126120000 +0100" a epoch en milisegundos. */
export function parseXmltvDate(input: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec((input ?? '').trim())
  if (!match) return Number.NaN
  const [, y, mo, d, h, mi, se, tz] = match
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(se ?? '0'),
  )
  if (!tz) return utc
  const sign = tz.startsWith('-') ? -1 : 1
  const offsetMinutes = Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))
  return utc - sign * offsetMinutes * 60000
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
})

export function parseXmltv(text: string, source: string): EpgData {
  const parsed = parser.parse(text) as Record<string, unknown>
  const tv = (parsed.tv ?? {}) as Record<string, unknown>

  const channelNodes = Array.isArray(tv.channel) ? tv.channel : tv.channel ? [tv.channel] : []
  const channels: Record<string, string> = {}
  for (const node of channelNodes) {
    const record = node as Record<string, unknown>
    const id = String(record['@_id'] ?? '')
    if (!id) continue
    // Todas las variantes del nombre sirven para emparejar listas sin tvg-id.
    const names = (Array.isArray(record['display-name']) ? record['display-name'] : [record['display-name']])
      .map((value) => textOf(value))
      .filter(Boolean)
    channels[id] = names.length > 0 ? names.join(' | ') : id
  }

  const programmeNodes = Array.isArray(tv.programme) ? tv.programme : tv.programme ? [tv.programme] : []
  const programmes: EpgProgramme[] = []
  for (const node of programmeNodes) {
    const record = node as Record<string, unknown>
    const channel = String(record['@_channel'] ?? '')
    const start = parseXmltvDate(String(record['@_start'] ?? ''))
    if (!channel || !Number.isFinite(start)) continue
    let stop = parseXmltvDate(String(record['@_stop'] ?? ''))
    if (!Number.isFinite(stop)) stop = start + 30 * 60000
    programmes.push({
      channel,
      start,
      stop,
      title: textOf(record.title) || 'Sin título',
      desc: textOf(record.desc) || undefined,
      category: textOf(record.category) || undefined,
    })
  }

  programmes.sort((a, b) => a.start - b.start)
  const byChannel: Record<string, EpgProgramme[]> = {}
  for (const programme of programmes) {
    const list = (byChannel[programme.channel] ??= [])
    list.push(programme)
  }

  return {
    channels,
    programmes,
    byChannel,
    fetchedAt: Date.now(),
    source,
  }
}

export function programAt(programmes: EpgProgramme[] | undefined, ts: number): EpgProgramme | undefined {
  if (!programmes || programmes.length === 0) return undefined
  return programmes.find((programme) => programme.start <= ts && programme.stop > ts)
}

export function nextPrograms(
  programmes: EpgProgramme[] | undefined,
  ts: number,
  limit = 6,
): EpgProgramme[] {
  if (!programmes) return []
  return programmes.filter((programme) => programme.stop > ts).slice(0, limit)
}

export function epgIdFor(tvgId: string | undefined, epg: EpgData | null, name?: string): string | undefined {
  if (!epg) return undefined
  const index = epgIndex(epg)
  if (tvgId) {
    const exact = index.lower.get(tvgId.trim().toLowerCase())
    if (exact) return exact
  }
  // Muchas listas dejan el tvg-id vacío o con un nombre distinto al del XMLTV.
  // Se compara por nombre normalizado (sin calidad, acentos ni símbolos).
  for (const candidate of [tvgId, name]) {
    const key = normalizeChannelName(candidate)
    if (!key) continue
    const hit = index.names.get(key)
    if (hit) return hit
  }
  return undefined
}

interface EpgIndex {
  /** id del XMLTV en minúsculas -> id real */
  lower: Map<string, string>
  /** nombre normalizado -> id real */
  names: Map<string, string>
}

const indexCache = new WeakMap<EpgData, EpgIndex>()

/**
 * Palabras que solo indican calidad o códec y no forman parte del nombre del
 * canal. Así "La 1 HD" casa con "La 1" y "DAZN F1 1080p" con "DAZN F1 HD".
 */
const QUALITY_WORDS = new Set([
  'hd',
  'fhd',
  'uhd',
  'sd',
  '4k',
  '8k',
  '720',
  '720p',
  '1080',
  '1080p',
  '2160',
  '2160p',
  'h264',
  'h265',
  'hevc',
  'avc',
  'hevc10',
  'hi10p',
])

export function normalizeChannelName(input: string | undefined): string {
  if (!input) return ''
  let text = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  // Prefijos de país habituales: "DE | Rally TV", "ES: La 1".
  text = text.replace(/^\s*[a-z]{2,3}\s*[|:]\s*/, '')
  // Coletillas tipo "(720p)" o "[HD]".
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  text = text.replace(/[^a-z0-9]+/g, ' ')
  const tokens = text.split(' ').filter((token) => token && !QUALITY_WORDS.has(token))
  // "La 2 TVE" y "La 1 TVE" son la misma cadena que "La 2" / "La 1".
  if (tokens[0] === 'la' && /^\d+$/.test(tokens[1] ?? '')) {
    return tokens.filter((token, position) => position < 2 || token !== 'tve').join(' ')
  }
  return tokens.join(' ')
}

function epgIndex(epg: EpgData): EpgIndex {
  const cached = indexCache.get(epg)
  if (cached) return cached

  const lower = new Map<string, string>()
  const names = new Map<string, string>()
  const addName = (value: string | undefined, id: string) => {
    const key = normalizeChannelName(value)
    if (!key || names.has(key)) return
    names.set(key, id)
  }

  for (const id of Object.keys(epg.byChannel)) {
    lower.set(id.trim().toLowerCase(), id)
    addName(id, id)
    for (const alias of epg.channels[id]?.split('|') ?? []) addName(alias, id)
  }

  const index = { lower, names }
  indexCache.set(epg, index)
  return index
}

/**
 * Une varias fuentes XMLTV en una sola guía. Se descartan los programas
 * repetidos (misma cadena y misma hora), algo habitual cuando una lista
 * declara el mismo archivo con dos rutas distintas.
 */
export function mergeEpg(parts: EpgData[], source: string): EpgData {
  if (parts.length === 0) {
    return { channels: {}, programmes: [], byChannel: {}, fetchedAt: Date.now(), source }
  }
  if (parts.length === 1) return { ...parts[0], source }

  const channels: Record<string, string> = {}
  const byChannel: Record<string, EpgProgramme[]> = {}
  const programmes: EpgProgramme[] = []
  const seen = new Set<string>()

  for (const part of parts) {
    Object.assign(channels, part.channels)
    for (const [id, list] of Object.entries(part.byChannel)) {
      const target = (byChannel[id] ??= [])
      for (const item of list) {
        const key = `${item.channel}|${item.start}`
        if (seen.has(key)) continue
        seen.add(key)
        target.push(item)
        programmes.push(item)
      }
    }
  }

  for (const list of Object.values(byChannel)) list.sort((a, b) => a.start - b.start)
  programmes.sort((a, b) => a.start - b.start)

  return { channels, programmes, byChannel, fetchedAt: Date.now(), source }
}
