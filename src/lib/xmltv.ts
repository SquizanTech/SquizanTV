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
    channels[id] = textOf(record['display-name']) || id
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

export function epgIdFor(tvgId: string | undefined, epg: EpgData | null): string | undefined {
  if (!epg || !tvgId) return undefined
  if (epg.byChannel[tvgId]) return tvgId
  const lower = tvgId.toLowerCase()
  const found = Object.keys(epg.byChannel).find((key) => key.toLowerCase() === lower)
  return found
}
