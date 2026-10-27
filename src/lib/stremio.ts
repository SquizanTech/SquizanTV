import type {
  AddonStream,
  CatalogMeta,
  StremioAddon,
  StremioCatalog,
  StremioCatalogExtra,
  TorrentFileInfo,
} from '../types'

/**
 * Cliente del protocolo de addons de Stremio (manifest, catálogo, meta y
 * streams). Todas las peticiones pasan por `window.nova.net.fetch`, que las
 * hace en el proceso principal: sin CORS y siguiendo redirecciones (Cinemeta
 * redirige a cinemeta-catalogs.strem.io).
 */

export interface ResolvedStream {
  addon: StremioAddon
  stream: AddonStream
  /** Clave estable para listas de React y estados de carga. */
  key: string
}

export interface CatalogPage {
  metas: CatalogMeta[]
  hasMore: boolean
}

const TIMEOUT = 25000

function arrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

async function getJson(url: string): Promise<unknown> {
  const response = await window.nova.net.fetch({
    url,
    timeout: TIMEOUT,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`El addon respondió HTTP ${response.status || '?'}. Comprueba la dirección.`)
  }
  if (!response.text.trim()) throw new Error('El addon devolvió una respuesta vacía.')
  try {
    return JSON.parse(response.text) as unknown
  } catch {
    throw new Error('El addon no devolvió JSON válido. ¿Seguro que es un addon de Stremio?')
  }
}

/**
 * Acepta una URL de addon en cualquiera de sus formas habituales:
 * `https://host/manifest.json`, `https://host`, `stremio://host/manifest.json`
 * o enlaces de instalación web con `?addon=<url>`.
 */
export function normalizeAddonUrl(input: string): string | null {
  let value = input.trim()
  if (!value) return null

  // Enlaces de instalación: ...?addon=https%3A%2F%2F... (también dentro del hash).
  const match = /[?&#]addon=([^&]+)/i.exec(value)
  if (match) {
    try {
      const inner = decodeURIComponent(match[1])
      if (inner && inner !== value) {
        const normalized = normalizeAddonUrl(inner)
        if (normalized) return normalized
      }
    } catch {
      /* sigue con la URL original */
    }
  }

  if (/^stremio:\/\//i.test(value)) value = `https://${value.slice('stremio://'.length)}`
  if (!/^https?:\/\//i.test(value)) value = `https://${value.replace(/^\/+/, '')}`

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null

  let pathname = parsed.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/manifest\.json$/i, '')
  pathname = pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathname}/`
}

function normalizeResources(raw: unknown): { names: string[]; prefixes: string[] } {
  const names = new Set<string>()
  const prefixes = new Set<string>()
  if (!Array.isArray(raw)) return { names: [], prefixes: [] }

  for (const entry of raw) {
    if (typeof entry === 'string') {
      names.add(entry)
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { name?: unknown; idPrefixes?: unknown }
    if (typeof item.name === 'string' && item.name.trim()) names.add(item.name.trim())
    for (const prefix of arrayOf(item.idPrefixes)) prefixes.add(prefix)
  }
  return { names: Array.from(names), prefixes: Array.from(prefixes) }
}

function normalizeCatalogs(raw: unknown): StremioCatalog[] {
  if (!Array.isArray(raw)) return []
  const catalogs: StremioCatalog[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const type = text(item.type).trim()
    const id = text(item.id).trim()
    if (!type || !id) continue

    const extra: StremioCatalogExtra[] = []
    const addExtra = (name: string, options?: string[], isRequired = false): void => {
      if (!name) return
      const existing = extra.find((value) => value.name === name)
      if (existing) {
        if (options?.length && !existing.options?.length) existing.options = options
        if (isRequired) existing.isRequired = true
        return
      }
      extra.push({
        name,
        ...(options?.length ? { options } : {}),
        ...(isRequired ? { isRequired: true } : {}),
      })
    }

    if (Array.isArray(item.extra)) {
      for (const extraEntry of item.extra) {
        if (!extraEntry || typeof extraEntry !== 'object') continue
        const value = extraEntry as Record<string, unknown>
        addExtra(text(value.name), arrayOf(value.options), Boolean(value.isRequired))
      }
    }
    // Formato antiguo de manifest.
    for (const name of arrayOf(item.extraSupported)) addExtra(name)
    for (const name of arrayOf(item.extraRequired)) addExtra(name, undefined, true)
    // Algunos addons antiguos solo declaran los géneros en `genres`.
    const genres = arrayOf(item.genres)
    if (genres.length) addExtra('genre', genres)

    catalogs.push({
      type,
      id,
      name: text(item.name).trim() || id,
      ...(extra.length ? { extra } : {}),
    })
  }

  return catalogs
}

export async function fetchManifest(baseUrl: string): Promise<StremioAddon> {
  const url = normalizeAddonUrl(baseUrl)
  if (!url) throw new Error('La dirección del addon no es válida.')

  const raw = await getJson(`${url}manifest.json`)
  if (!raw || typeof raw !== 'object') throw new Error('El manifest del addon no es válido.')
  const manifest = raw as Record<string, unknown>

  const resources = normalizeResources(manifest.resources)
  const prefixes = new Set([...resources.prefixes, ...arrayOf(manifest.idPrefixes)])
  const catalogs = normalizeCatalogs(manifest.catalogs)
  const types = arrayOf(manifest.types)
  if (!types.length) {
    for (const catalog of catalogs) if (!types.includes(catalog.type)) types.push(catalog.type)
  }

  if (!resources.names.length && !catalogs.length) {
    throw new Error('Ese addon no ofrece catálogos ni metadatos compatibles.')
  }

  return {
    manifestId: text(manifest.id).trim() || url,
    url,
    name: text(manifest.name).trim() || new URL(url).host,
    description: text(manifest.description).trim(),
    version: text(manifest.version).trim(),
    logo: text(manifest.logo).trim(),
    types,
    catalogs,
    resources: resources.names,
    idPrefixes: Array.from(prefixes),
    enabled: true,
    addedAt: Date.now(),
  }
}

export function addonSupports(
  addon: StremioAddon,
  resource: string,
  type?: string,
  id?: string,
): boolean {
  if (!addon.enabled) return false
  if (!addon.resources.includes(resource)) return false
  if (type && addon.types.length > 0 && !addon.types.includes(type) && !addon.catalogs.some((c) => c.type === type)) {
    return false
  }
  if (id && addon.idPrefixes.length > 0 && !addon.idPrefixes.some((prefix) => id.startsWith(prefix))) {
    return false
  }
  return true
}

export async function fetchCatalog(
  addon: StremioAddon,
  catalog: StremioCatalog,
  options: { genre?: string; search?: string; skip?: number } = {},
): Promise<CatalogPage> {
  const extras: string[] = []
  if (options.genre) extras.push(`genre=${encodeURIComponent(options.genre)}`)
  if (options.search?.trim()) extras.push(`search=${encodeURIComponent(options.search.trim())}`)
  if (options.skip && options.skip > 0) extras.push(`skip=${options.skip}`)

  const suffix = extras.length ? `/${extras.join('&')}` : ''
  const url = `${addon.url}catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}${suffix}.json`
  const raw = await getJson(url)
  const data = (raw ?? {}) as { metas?: unknown }
  const metas: CatalogMeta[] = []

  if (Array.isArray(data.metas)) {
    for (const entry of data.metas) {
      const meta = normalizeMeta(entry, catalog.type)
      if (meta) metas.push(meta)
    }
  }

  return { metas, hasMore: metas.length > 0 }
}

export async function fetchMeta(addon: StremioAddon, type: string, id: string): Promise<CatalogMeta> {
  const url = `${addon.url}meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`
  const raw = await getJson(url)
  const data = (raw ?? {}) as { meta?: unknown }
  const meta = normalizeMeta(data.meta, type)
  if (!meta) throw new Error('El addon no devolvió información de ese título.')
  return meta
}

function normalizeMeta(raw: unknown, fallbackType: string): CatalogMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = text(item.id).trim()
  const name = text(item.name).trim()
  if (!id || !name) return null

  const videos: CatalogMeta['videos'] = []
  if (Array.isArray(item.videos)) {
    for (const entry of item.videos) {
      if (!entry || typeof entry !== 'object') continue
      const video = entry as Record<string, unknown>
      const videoId = text(video.id).trim()
      if (!videoId) continue
      videos.push({
        id: videoId,
        title: text(video.title) || text(video.name) || undefined,
        season: typeof video.season === 'number' ? video.season : undefined,
        episode: typeof video.episode === 'number' ? video.episode : undefined,
        released: text(video.released) || undefined,
      })
    }
  }

  return {
    id,
    type: text(item.type).trim() || fallbackType,
    name,
    poster: text(item.poster) || undefined,
    posterShape:
      item.posterShape === 'square' || item.posterShape === 'landscape' ? item.posterShape : 'poster',
    background: text(item.background) || undefined,
    logo: text(item.logo) || undefined,
    description: text(item.description) || undefined,
    releaseInfo: text(item.releaseInfo) || undefined,
    imdbRating: text(item.imdbRating) || undefined,
    genres: arrayOf(item.genres),
    runtime: text(item.runtime) || undefined,
    cast: arrayOf(item.cast),
    videos: videos.length ? videos : undefined,
  }
}

/** Pide los streams a todos los addons activos que declaren el recurso. */
export async function fetchStreams(
  addons: StremioAddon[],
  type: string,
  id: string,
): Promise<ResolvedStream[]> {
  const candidates = addons.filter((addon) => addonSupports(addon, 'stream', type, id))
  const results = await Promise.allSettled(
    candidates.map(async (addon) => {
      const url = `${addon.url}stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`
      const raw = await getJson(url)
      const data = (raw ?? {}) as { streams?: unknown }
      const streams: AddonStream[] = []
      if (Array.isArray(data.streams)) {
        for (const entry of data.streams) {
          if (!entry || typeof entry !== 'object') continue
          const stream = entry as AddonStream
          if (!stream.url && !stream.infoHash && !stream.externalUrl) continue
          streams.push(stream)
        }
      }
      return streams.map((stream, index) => ({ addon, stream, key: `${addon.url}|${index}` }))
    }),
  )

  const resolved: ResolvedStream[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') resolved.push(...result.value)
  }
  return resolved
}

export function magnetForStream(stream: AddonStream): string | null {
  if (!stream.infoHash) return null
  const hash = stream.infoHash.trim().toLowerCase()
  if (!/^[a-z0-9]{32,40}$/.test(hash)) return null

  const filename = stream.behaviorHints?.filename || stream.title?.split('\n')[0] || stream.name || 'NovaTV'
  const params = [`xt=urn:btih:${hash}`, `dn=${encodeURIComponent(filename.slice(0, 120))}`]
  for (const source of stream.sources ?? []) {
    if (/^tracker:/i.test(source)) {
      const tracker = source.slice('tracker:'.length).trim()
      if (tracker) params.push(`tr=${encodeURIComponent(tracker)}`)
    }
  }
  return `magnet:?${params.join('&')}`
}

/** Elige el fichero de vídeo que indica el addon (`fileIdx`/nombre) o el mayor. */
export function pickStreamFile(
  files: TorrentFileInfo[],
  fileIdx?: number,
  filename?: string,
): TorrentFileInfo | null {
  const videos = files.filter((file) => file.kind === 'video')
  if (!videos.length) return null

  if (typeof fileIdx === 'number' && Number.isFinite(fileIdx)) {
    const exact = files.find((file) => file.index === fileIdx)
    if (exact?.kind === 'video') return exact
  }

  const wanted = (filename ?? '').split(/[\\/]/).pop()?.toLowerCase().trim()
  if (wanted) {
    const byName = videos.find((file) => {
      const current = file.name.split(/[\\/]/).pop()?.toLowerCase() ?? ''
      return current === wanted || current.includes(wanted) || wanted.includes(current)
    })
    if (byName) return byName
  }

  return videos.reduce((best, file) => (file.length > best.length ? file : best), videos[0])
}

/** Atajo para añadir un addon desde una URL pegada por el usuario. */
export async function installAddon(input: string): Promise<StremioAddon> {
  const normalized = normalizeAddonUrl(input)
  if (!normalized) throw new Error('Pega la dirección de un addon de Stremio (https://…).')
  return fetchManifest(normalized)
}
