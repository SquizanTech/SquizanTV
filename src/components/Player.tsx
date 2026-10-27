import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import type { Channel, EpgData, Playlist, SubtitleFile, TorrentDetails } from '../types'
import { baseName, isAceStream, isHls, isTransportStream, formatTime } from '../lib/util'
import { epgIdFor, programAt, nextPrograms } from '../lib/xmltv'
import { useDb } from '../store'
import { Icon } from './Icons'

interface PlayerProps {
  channel: Channel
  playlist: Playlist
  list: Channel[]
  epg: EpgData | null
  onClose: () => void
  onSelect: (channel: Channel) => void
  /** Fuente efímera (torrents): no guarda historial ni favoritos. */
  transient?: boolean
  statusText?: string
  details?: TorrentDetails
}

type Status = 'loading' | 'playing' | 'paused' | 'error'

interface CustomSubtitle {
  id: string
  label: string
  lang?: string
  cues: ParsedCue[]
}

interface ParsedCue {
  start: number
  end: number
  text: string
}

/** h:mm:ss.cc (ASS) / hh:mm:ss,mmm (SRT) / mm:ss.mmm → segundos. */
function vttSeconds(raw: string): number {
  const value = raw.trim()
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value)
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
  const short = /^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value)
  if (short) return Number(short[1]) * 60 + Number(short[2]) + Number(short[3].padEnd(3, '0')) / 1000
  return 0
}

/** Parse SRT / ASS / VTT a cues instanciables con VTTCue. */
function parseCues(raw: string, fileName: string): ParsedCue[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  // ASS / SSA
  if (/\[Script Info\]/i.test(text) && /Dialogue:/i.test(text)) {
    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const dialogue = /^Dialogue:\s*[^,]*,([^,]+),([^,]+),(?:[^,]*,){6}([\s\S]*)$/gm
    const cues: ParsedCue[] = []
    let match = dialogue.exec(text)
    const seen = new Set<string>()
    while (match) {
      const body = match[3]
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N|\\n|\\r/gi, '\n')
        .trim()
      const key = `${match[1]}|${match[2]}|${body}`
      if (body && !seen.has(key)) {
        seen.add(key)
        cues.push({ start: vttSeconds(match[1]), end: vttSeconds(match[2]), text: body })
      }
      match = dialogue.exec(text)
    }
    if (cues.length) return cues
  }

  // VTT o SRT (bloques separados por línea en blanco, tiempo con --> )
  const blocks = text.split(/\n{2,}/)
  const cues: ParsedCue[] = []
  const timing = /^(\S+)\s*-->\s*(\S+)\s*.*$/gm
  for (const block of blocks) {
    const clean = block.trim()
    if (!clean || /^\s*WEBVTT/i.test(clean) || /^(NOTE|STYLE|REGION)\b/.test(clean)) continue
    const lines = clean.split('\n')
    const timeLine = lines.find((line) => line.includes('-->'))
    if (!timeLine) continue
    timing.lastIndex = 0
    const m = timing.exec(timeLine)
    if (!m) continue
    const start = vttSeconds(m[1])
    const end = vttSeconds(m[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    let bodyLines = lines.filter((line) => line !== timeLine)
    // SRT: descarta el número de cue que encabeza el bloque
    if (/^\d+$/.test(bodyLines[0]?.trim() ?? '')) bodyLines = bodyLines.slice(1)
    const body = bodyLines.join('\n').trim()
    if (body) cues.push({ start, end, text: body })
  }
  if (cues.length) return cues
  throw new Error(`No se pudo leer ${fileName} como subtítulo.`)
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const base = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  return hours > 0 ? `${hours}:${base}` : base
}

/** Contenedores que Chromium puede abrir tal cual. */
const DIRECT_CONTAINERS = new Set([
  'matroska',
  'webm',
  'mov',
  'mp4',
  'm4v',
  'm4a',
  'mj2',
  '3gp',
  '3g2',
  'ogg',
  'wav',
  'flac',
  'adts',
  'mp3',
  'aac',
])

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'mp2', 'opus', 'flac', 'vorbis'])

/** H.264 de 8 bits y 4:2:0: el único que se puede copiar a MPEG-TS sin riesgo. */
function isCopyableVideo(codec?: string, pixFmt?: string): boolean {
  if (codec !== 'h264') return false
  return ['yuv420p', 'yuvj420p', 'nv12'].includes((pixFmt ?? '').toLowerCase())
}

function isDirectVideo(codec?: string, pixFmt?: string): boolean {
  const fmt = (pixFmt ?? '').toLowerCase()
  const eightBit = ['yuv420p', 'yuvj420p', 'nv12'].includes(fmt)
  if (codec === 'h264' || codec === 'hevc') return eightBit
  return ['vp8', 'vp9', 'av1'].includes(codec ?? '')
}

interface SubOption {
  id: string
  label: string
  hint?: string
}

interface AudioOption {
  id: string
  label: string
  lang?: string
}

export function Player({
  channel,
  playlist,
  list,
  epg,
  onClose,
  onSelect,
  transient = false,
  statusText,
  details,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const statusRef = useRef<Status>('loading')
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [idle, setIdle] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [externalPlayer, setExternalPlayer] = useState('')
  const [menu, setMenu] = useState<null | 'sub' | 'audio'>(null)
  const [subLoading, setSubLoading] = useState(false)
  /** Desfase cuando el vídeo se sirve como MPEG-TS convertido y se salta en el tiempo. */
  const seekOffsetRef = useRef(0)
  const transcodeRef = useRef<{ full: boolean } | null>(null)
  const seekRestartRef = useRef<((seconds: number) => void) | null>(null)
  const mpegRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null)
  /** false solo cuando el usuario pausa a propósito. */
  const playIntentRef = useRef(true)
  const isVod = channel.kind !== 'live'
  const [subError, setSubError] = useState('')
  const [customSubs, setCustomSubs] = useState<CustomSubtitle[]>([])
  const [activeSub, setActiveSub] = useState('off')
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [audioIssue, setAudioIssue] = useState('')
  const [loadNote, setLoadNote] = useState('')
  const [listTick, setListTick] = useState(0)

  const { db, updateSettings, toggleFavorite, isFavorite, pushHistory } = useDb()

  const favorite = isFavorite(playlist.id, channel.id)

  const epgId = epgIdFor(channel.tvgId, epg)
  const programmes = epgId ? epg?.byChannel[epgId] : undefined
  const now = programAt(programmes, Date.now())
  const upcoming = nextPrograms(programmes, Date.now(), 4).filter((item) => item.start > Date.now())

  const playableList = useMemo(
    () => list.filter((item) => item.kind === channel.kind && item.url),
    [list, channel.kind],
  )
  const index = playableList.findIndex((item) => item.id === channel.id)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  // VLC (o mpv) instalado: disponible para todos los canales, es la vía de
  // escape cuando el reproductor interno no puede con un códec o pista.
  useEffect(() => {
    let alive = true
    void window.nova.app
      .externalPlayer()
      .then((playerPath) => {
        if (!alive) return
        const name = playerPath ? (playerPath.split(/[\\/]/).pop() ?? '') : ''
        setExternalPlayer(name.replace(/\.exe$/i, ''))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const titleText = details?.title?.trim() || channel.name

  const openExternal = async () => {
    const result = await window.nova.app.openExternalPlayer(channel.url)
    if (!result.ok) setError(result.message ?? 'No se pudo abrir el reproductor externo.')
  }

  const goRelative = useCallback(
    (delta: number) => {
      if (index < 0) return
      const next = playableList[index + delta]
      if (next) onSelect(next)
    },
    [index, playableList, onSelect],
  )

  useEffect(() => {
    if (!transient) pushHistory(playlist.id, channel)
    setStatus('loading')
    setError('')
    setActiveSub('off')
    setMenu(null)
    setSubError('')
    setAudioBlocked(false)
    setAudioIssue('')
    setLoadNote('')
  }, [channel.id, playlist.id, channel, pushHistory, transient])

  /* ---------- Pistas ---------- */

  const torrentSubs = details?.subtitles ?? []
  const activeCustom = customSubs.find((entry) => entry.id === activeSub) ?? null

  const activateEmbedded = (trackIndex: number) => {
    const video = videoRef.current
    if (!video) return
    const tracks = video.textTracks
    for (let i = 0; i < tracks.length; i += 1) {
      if (tracks[i].kind !== 'subtitles') continue
      tracks[i].mode = i === trackIndex ? 'showing' : 'disabled'
    }
    setActiveSub(trackIndex >= 0 ? `emb:${trackIndex}` : 'off')
    setMenu(null)
  }

  const applySubChoice = async (id: string) => {
    const video = videoRef.current
    if (!video) return
    setSubError('')

    if (id === 'off') {
      activateEmbedded(-1)
      for (let i = 0; i < video.textTracks.length; i += 1) {
        const track = video.textTracks[i]
        if (track.kind === 'subtitles') track.mode = 'disabled'
      }
      return
    }

    if (id.startsWith('emb:')) {
      activateEmbedded(Number(id.slice(4)))
      return
    }

    const custom = customSubs.find((entry) => entry.id === id)
    if (!custom) return
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const track = video.textTracks[i]
      if (track.kind === 'subtitles') track.mode = 'disabled'
    }
    setActiveSub(custom.id)
    setMenu(null)
  }

  // Apaga pistas embebidas cuando cambia la selección o el vídeo.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const track = video.textTracks[i]
      if (track.kind !== 'subtitles') continue
      const match = activeSub === `emb:${i}`
      if (track.mode === 'showing' && !match) track.mode = 'disabled'
      if (track.mode === 'disabled' && match) track.mode = 'showing'
    }
  }, [activeSub, attempt, channel.id])

  /* El <track> montado por React introduce los cues de forma poco fiable en
     Chromium (el track carga pero no parsea según el momento de inserción).
     En su lugar cargamos el subtítulo a mano: addTextTrack + VTTCue. */

  const engineTracks = useRef<TextTrack[]>([])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeCustom) {
      for (const track of engineTracks.current) if (track.mode !== 'disabled') track.mode = 'disabled'
      return
    }
    for (const track of engineTracks.current) track.mode = 'disabled'
    const track = video.addTextTrack('subtitles', activeCustom.label, activeCustom.lang ?? 'es')
    track.mode = 'showing'
    for (const cue of activeCustom.cues) {
      try {
        track.addCue(new VTTCue(cue.start, cue.end, cue.text))
      } catch {
        /* cue inválido: se salta */
      }
    }
    engineTracks.current = [...engineTracks.current, track]
    setListTick((tick) => tick + 1)
  }, [activeCustom])

  const addSubtitleFile = async (source: SubtitleFile) => {
    if (subLoading) return
    setSubLoading(true)
    setSubError('')
    try {
      let text = ''
      if (source.url) {
        const res = await fetch(source.url)
        if (!res.ok) throw new Error(`Descarga fallida (${res.status}).`)
        text = await res.text()
      } else {
        const picked = await window.nova.media.openSubtitle()
        if (!picked) {
          setSubLoading(false)
          return
        }
        source = { ...source, name: picked.name, url: null }
        text = picked.data
      }
      const cues = parseCues(text, source.name)
      const existing = customSubs.find((item) => item.label === source.name)
      const entry: CustomSubtitle = {
        id: existing ? existing.id : `cus:${Date.now()}-${customSubs.length}`,
        label: source.name,
        lang: source.language,
        cues,
      }
      setCustomSubs((prev) => {
        if (existing) return prev
        return [...prev, entry]
      })
      setActiveSub(entry.id)
      setMenu(null)
    } catch (fault) {
      setSubError(fault instanceof Error ? fault.message : 'No se pudo añadir el subtítulo.')
    } finally {
      setSubLoading(false)
    }
  }

  /** Pistas de audio visibles según el motor activo. */
  const audioOptions = useMemo((): AudioOption[] => {
    void listTick
    const hls = hlsRef.current
    if (hls && hls.audioTracks.length > 0) {
      return hls.audioTracks.map((track) => ({
        id: `hls:${track.id}`,
        label: track.name || track.lang || `Pista ${track.id + 1}`,
        lang: track.lang ?? '',
      }))
    }
    const video = videoRef.current as (HTMLVideoElement & { audioTracks?: unknown }) | null
    const native = video && typeof (video as { audioTracks?: AudioTrackListLike }).audioTracks !== 'undefined'
      ? ((video as { audioTracks: AudioTrackListLike }).audioTracks)
      : null
    if (native && native.length > 0) {
      const options: AudioOption[] = []
      for (let i = 0; i < native.length; i += 1) {
        const track = native[i]
        options.push({ id: `nat:${i}`, label: (track as { label?: string; language?: string }).label || `Pista ${i + 1}` })
      }
      return options
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTick])

  interface AudioTrackListLike {
    length: number
    [index: number]: { enabled?: boolean; label?: string; language?: string }
  }

  const selectAudio = (id: string) => {
    const hls = hlsRef.current
    if (id.startsWith('hls:')) {
      const target = Number(id.slice(4))
      if (Number.isFinite(target) && hls) hls.audioTrack = target
      setMenu(null)
      setListTick((tick) => tick + 1)
      return
    }
    if (id.startsWith('nat:')) {
      const video = videoRef.current as (HTMLVideoElement & { audioTracks?: AudioTrackListLike }) | null
      if (video?.audioTracks) {
        for (let i = 0; i < video.audioTracks.length; i += 1) {
          const track = video.audioTracks[i] as { enabled?: boolean }
          if (typeof track.enabled === 'boolean') track.enabled = id === `nat:${i}`
        }
        setMenu(null)
        setListTick((tick) => tick + 1)
      }
    }
  }

  const currentAudio = audioOptions.find((option) => {
    const hls = hlsRef.current
    if (option.id.startsWith('hls:')) return hls && hls.audioTrack === Number(option.id.slice(4))
    return false
  })

  const subOptions = useMemo((): SubOption[] => {
    void listTick
    const video = videoRef.current
    const engine = engineTracks.current
    const options: SubOption[] = [{ id: 'off', label: 'Sin subtítulos' }]
    if (video) {
      for (let i = 0; i < video.textTracks.length; i += 1) {
        const track = video.textTracks[i]
        if (track.kind !== 'subtitles') continue
        if (engine.includes(track)) continue
        options.push({
          id: `emb:${i}`,
          label: track.label || track.language || `Pista ${i + 1}`,
          hint: 'incluida',
        })
      }
    }
    for (const custom of customSubs) options.push({ id: custom.id, label: custom.label })
    return options
  }, [customSubs, listTick])

  /* ---------- Auto-ocultar controles ---------- */

  const idleTimer = useRef<number | null>(null)

  const wakeShell = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (statusRef.current === 'playing') setIdle(true)
    }, 2800)
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    shell.addEventListener('pointermove', wakeShell)
    shell.addEventListener('pointerdown', wakeShell)
    wakeShell()
    return () => {
      shell.removeEventListener('pointermove', wakeShell)
      shell.removeEventListener('pointerdown', wakeShell)
      if (idleTimer.current) window.clearTimeout(idleTimer.current)
    }
  }, [wakeShell, attempt, channel.id])

  useEffect(() => {
    const shell = shellRef.current
    if (!idle || menu || showInfo || status !== 'playing') {
      if (shell) shell.classList.remove('is-idle')
      return
    }
    if (shell) shell.classList.add('is-idle')
  }, [idle, menu, showInfo, status])

  /* ---------- Motor de reproducción ---------- */

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false
    let hls: Hls | null = null
    let mpeg: ReturnType<typeof mpegts.createPlayer> | null = null
    let fallbackUsed = false
    let fullRetryStarted = false

    seekOffsetRef.current = 0
    transcodeRef.current = null
    seekRestartRef.current = null
    mpegRef.current = null
    playIntentRef.current = true
    setCurrentTime(0)
    setError('')
    setDuration(channel.duration && channel.duration > 0 ? channel.duration : 0)

    const cleanupEngines = () => {
      try {
        hls?.destroy()
      } catch {
        /* noop */
      }
      try {
        mpeg?.destroy()
      } catch {
        /* noop */
      }
      hls = null
      mpeg = null
      hlsRef.current = null
      mpegRef.current = null
    }

    const fail = (message: string) => {
      if (disposed) return
      setStatus('error')
      setError(message)
    }

    const attemptPlay = () => {
      if (disposed) return
      void video
        .play()
        .then(() => setStatus('playing'))
        .catch((fault: DOMException) => {
          if (disposed) return
          // Solo silenciamos si Chromium bloquea el autoplay con sonido. Si el
          // fallo es porque el nuevo flujo aún no tiene datos (AbortError al
          // saltar en el tiempo), esperamos a `canplay` sin quitar el sonido.
          if (fault?.name !== 'NotAllowedError') {
            setStatus('loading')
            return
          }
          video.muted = true
          setAudioBlocked(true)
          setMuted(true)
          void video
            .play()
            .then(() => setStatus('playing'))
            .catch(() => setStatus('paused'))
        })
    }

    const startDirect = (url: string) => {
      video.src = url
      video.load()
      attemptPlay()
    }

    const startTs = (url: string, allowFallback: boolean, skipProbe = false) => {
      const features = (mpegts as unknown as { getFeatureList: () => { mseLivePlayback: boolean } }).getFeatureList()
      if (!features?.mseLivePlayback) {
        startDirect(url)
        return
      }
      const live = !isVod
      try {
        mpeg = mpegts.createPlayer(
          { type: 'mpegts', isLive: live, url },
          {
            enableWorker: true,
            // En una película conviene cargar sin perseguir latencia, pero con
            // un límite de búfer: así se descargan unos segundos por delante y
            // no la película completa.
            isLive: live,
            lazyLoad: true,
            lazyLoadMaxDuration: live ? undefined : 60,
            lazyLoadRecoverDuration: live ? undefined : 15,
            liveBufferLatencyChasing: live,
            accurateSeek: !live,
            autoCleanupSourceBuffer: true,
            fixAudioTimestampGap: !live,
          },
        )
        mpegRef.current = mpeg
        mpeg.attachMediaElement(video)
        // Algunos canales (AceStream sobre todo) traen audio AC-3/E-AC-3, que
        // Chromium no decodifica: mpegts lo salta y el vídeo queda mudo.
        mpeg.on(mpegts.Events.MEDIA_INFO, (info: { audioCodec?: string | null }) => {
          const codec = String(info?.audioCodec ?? '').toLowerCase()
          if (codec.includes('ac3') || codec.includes('dolby') || codec.includes('a52')) {
            setAudioIssue('La pista de audio es Dolby (AC-3), que el reproductor interno no decodifica.')
          }
        })
        mpeg.on(mpegts.Events.ERROR, () => {
          if (allowFallback && tryFallback()) return
          if (retryFullTranscode()) return
          fail('No se pudo reproducir este archivo. SquizanTV intentó convertirlo, pero el formato sigue sin ser compatible.')
        })
        mpeg.load()
        attemptPlay()
        // Sondeo previo del códec en el proceso principal (fallback del aviso).
        // En flujos ya convertidos no hace falta (y no debe haber un segundo
        // consumidor del flujo en vivo).
        if (!skipProbe) {
          void window.nova.media
            .probeTs(url)
            .then((probe) => {
              if (disposed) return
              if (probe?.ok && probe.audio === 'ac3') {
                setAudioIssue('La pista de audio es Dolby (AC-3), que el reproductor interno no decodifica.')
              }
            })
            .catch(() => undefined)
        }
      } catch {
        if (!tryFallback()) fail('No se pudo inicializar el reproductor MPEG-TS.')
      }
    }

    const startHls = (url: string, allowFallback: boolean) => {
      if (!Hls.isSupported()) {
        startDirect(url)
        return
      }
      let audioRetries = 0
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        manifestLoadingTimeOut: 15000,
      })
      hlsRef.current = hls
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setListTick((tick) => tick + 1)
        attemptPlay()
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const detail = String(data.details ?? '')
        // Muchas televisiones separan el audio en pistas (EXT-X-MEDIA). Si la
        // pista elegida falla, pruebo la siguiente automáticamente.
        if (
          !data.fatal &&
          (detail === 'audioTrackLoadError' || detail === 'audioTrackSwitchError' || detail === 'audioParsingError') &&
          hls && hls.audioTracks.length > 1 &&
          audioRetries < hls.audioTracks.length
        ) {
          audioRetries += 1
          hls.audioTrack = (hls.audioTrack + 1) % hls.audioTracks.length
          setListTick((tick) => tick + 1)
          return
        }
        if (detail === 'bufferAddCodecError') {
          if (allowFallback && tryFallback()) return
          fail('El códec del stream no es compatible con el reproductor interno.')
          return
        }
        if (!data.fatal) return
        if (allowFallback && tryFallback()) return
        fail(`Error de streaming (${detail || 'desconocido'}).`)
      })
      hls.loadSource(url)
      hls.attachMedia(video)
    }

    function tryFallback(): boolean {
      if (fallbackUsed || !channel.fallbackUrl) return false
      fallbackUsed = true
      cleanupEngines()
      const fallbackUrl = channel.fallbackUrl
      if (isTransportStream(fallbackUrl)) startTs(fallbackUrl, false)
      else if (isHls(fallbackUrl)) startHls(fallbackUrl, false)
      else startDirect(fallbackUrl)
      return true
    }

    /**
     * Último recurso para películas: si el motor actual falla (MKV con un
     * códec exótico, HEVC sin soporte del equipo, H.264 de 10 bits…), se
     * recodifica el vídeo completo a H.264/AAC y se reintenta en el mismo
     * segundo. Así el reproductor interno abre prácticamente cualquier MKV.
     */
    function retryFullTranscode(): boolean {
      if (!isVod || fullRetryStarted) return false
      if (transcodeRef.current?.full) return false
      fullRetryStarted = true
      const at = seekOffsetRef.current + (videoRef.current?.currentTime ?? 0)
      cleanupEngines()
      setStatus('loading')
      setLoadNote('Convirtiendo el vídeo a un formato compatible…')
      void (async () => {
        try {
          const trans = await window.nova.media.transcodeStream(channel.url, true, at)
          if (disposed) return
          if (!trans?.ok || !trans.url) {
            fail(trans?.reason || 'No se pudo convertir este archivo para el reproductor interno.')
            return
          }
          seekOffsetRef.current = at
          transcodeRef.current = { full: true }
          setLoadNote('')
          startTs(trans.url, false, true)
        } catch (error) {
          if (!disposed) fail(error instanceof Error ? error.message : 'No se pudo convertir este archivo.')
        }
      })()
      return true
    }

    /**
     * Salto en el tiempo para los vídeos que van convertidos a MPEG-TS en vivo.
     * El flujo convertido no admite `currentTime`, así que se levanta una nueva
     * conversión con `-ss` y se reengancha el reproductor en ese minuto.
     */
    const restartTranscodeAt = async (seconds: number) => {
      const info = transcodeRef.current
      if (disposed || !info) return
      setStatus('loading')
      setLoadNote(`Saltando a ${clock(seconds)}…`)
      setCurrentTime(seconds)
      try {
        const trans = await window.nova.media.transcodeStream(channel.url, info.full, seconds)
        if (disposed) return
        if (!trans?.ok || !trans.url) {
          fail(trans?.reason || 'No se pudo saltar a ese punto del vídeo.')
          return
        }
        cleanupEngines()
        seekOffsetRef.current = seconds
        transcodeRef.current = { full: info.full }
        setLoadNote('')
        startTs(trans.url, false, true)
      } catch (error) {
        if (!disposed) fail(error instanceof Error ? error.message : 'No se pudo saltar a ese punto del vídeo.')
      }
    }
    seekRestartRef.current = (seconds) => {
      void restartTranscodeAt(seconds)
    }

    const onPlaying = () => {
      playIntentRef.current = true
      setStatus('playing')
      setLoadNote('')
    }
    const onPause = () => {
      if (statusRef.current === 'loading') return
      setStatus((prev) => (prev === 'error' ? prev : 'paused'))
    }
    const onWaiting = () => setStatus('loading')
    const onCanPlay = () => {
      if (!playIntentRef.current || disposed) return
      if (!video.paused) return
      void video.play().then(() => setStatus('playing')).catch(() => undefined)
    }
    const onTime = () => setCurrentTime(seekOffsetRef.current + video.currentTime)
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
      setStatus('playing')
    }
    const onVideoError = () => {
      if (video.error && tryFallback()) return
      if (video.error && retryFullTranscode()) return
      if (video.error) fail('El reproductor no pudo abrir este archivo. Puede estar dañado o usar un formato que Chromium no admite.')
    }
    const onVolume = () => {
      setVolume(video.volume)
      setMuted(video.muted)
      if (!video.muted) {
        setAudioBlocked(false)
      }
    }
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement))

    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('error', onVideoError)
    video.addEventListener('volumechange', onVolume)
    document.addEventListener('fullscreenchange', onFsChange)

    video.volume = Math.min(1, Math.max(0, db.settings.volume || 1))
    video.muted = false

    if (!channel.url) {
      fail('Este elemento no tiene una URL de reproduccion.')
    } else if (isHls(channel.url)) {
      startHls(channel.url, true)
    } else if (isTransportStream(channel.url)) {
      startTs(channel.url, true)
    } else if (isAceStream(channel.url)) {
      // AceEngine sirve MPEG-TS sin extension (getstream?id=…): VLC lo abre,
      // el <video> nativo no. Directo al motor TS, sin sondeo previo.
      startTs(channel.url, false)
    } else if (/\.(mp3|aac|m4a|ogg|oga|opus|flac|wav)(\?|$)/i.test(channel.url)) {
      // Radios y audio directo: los soporta el elemento nativo.
      startDirect(channel.url)
    } else {
      // Extension no reconocible (radios sin sufijo, ficheros de torrent):
      // sondeo el contenido y elijo el motor adecuado.
      void (async () => {
        const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(channel.url)
        if (local) {
          // Torrent o fichero servido en local: ffmpeg mira contenedor y códecs.
          try {
            const probe = await window.nova.media.probeStream(channel.url)
            if (disposed) return
            if (probe?.ok) {
              if (probe.duration && probe.duration > 0) setDuration(probe.duration)
              if (probe.container === 'mpegts') {
                startTs(channel.url, false)
                return
              }
              const audioOk = DIRECT_AUDIO.has(probe.audio ?? '')
              const containerOk = DIRECT_CONTAINERS.has(probe.container ?? '')
              // En MKV no me fío de HEVC: según el equipo Chromium puede no
              // decodificarlo. Se convierte a H.264 y funciona en todos.
              const videoOk =
                isDirectVideo(probe.video, probe.videoPixFmt) &&
                !(probe.container === 'matroska' && probe.video === 'hevc')
              if (audioOk && videoOk && containerOk) {
                startDirect(channel.url)
                return
              }
              // Solo se copia el vídeo cuando es H.264 de 8 bits. HEVC, AV1,
              // VP9, Hi10P y códecs antiguos se recodifican a H.264.
              const copyVideo = isCopyableVideo(probe.video, probe.videoPixFmt)
              const full = !copyVideo
              setLoadNote(
                full
                  ? 'Convirtiendo el vídeo a un formato compatible…'
                  : 'Convirtiendo el audio (Dolby/DTS) a AAC…',
              )
              const trans = await window.nova.media.transcodeStream(channel.url, full)
              if (disposed) return
              if (trans?.ok && trans.url) {
                transcodeRef.current = { full }
                startTs(trans.url, false, true)
                return
              }
              // Si falló la conversión de solo audio, al menos intento el
              // archivo original (puede verse sin sonido).
              if (!full && containerOk && videoOk) {
                setAudioIssue(
                  `El audio de este fichero (${probe.audio || 'desconocido'}) no lo decodifica el reproductor interno.`,
                )
                startDirect(channel.url)
                return
              }
              fail(trans?.reason || 'No se pudo convertir este archivo para el reproductor interno.')
              return
            }
          } catch {
            /* reproducción directa como último recurso */
          }
          if (!disposed) startDirect(channel.url)
          return
        }
        try {
          const probe = await window.nova.media.probeTs(channel.url)
          if (disposed) return
          if (probe?.ok && probe.ts) {
            startTs(channel.url, false)
            return
          }
        } catch {
          /* sigo */
        }
        if (!disposed) startDirect(channel.url)
      })()
    }

    return () => {
      disposed = true
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('error', onVideoError)
      video.removeEventListener('volumechange', onVolume)
      document.removeEventListener('fullscreenchange', onFsChange)
      cleanupEngines()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, channel.url, channel.fallbackUrl, attempt])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Escape') {
        if (menu) setMenu(null)
        else onClose()
      } else if (event.key === 'ArrowRight') {
        if (isVod) {
          event.preventDefault()
          seekBy(10)
        } else goRelative(1)
      } else if (event.key === 'ArrowLeft') {
        if (isVod) {
          event.preventDefault()
          seekBy(-10)
        } else goRelative(-1)
      } else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
      else if (event.key === ' ') {
        event.preventDefault()
        togglePlay()
      } else if (event.key === 'c') {
        const video = videoRef.current
        if (!video) return
        const tracks: { index: number; track: TextTrack }[] = []
        for (let i = 0; i < video.textTracks.length; i += 1) {
          const track = video.textTracks[i]
          if (track.kind === 'subtitles' && !engineTracks.current.includes(track)) tracks.push({ index: i, track })
        }
        const current = tracks.findIndex((entry) => entry.track.mode === 'showing')
        const nextIndex = current < 0 ? 0 : current >= tracks.length - 1 ? -1 : current + 1
        const next = nextIndex >= 0 ? tracks[nextIndex] : null
        tracks.forEach((entry) => {
          entry.track.mode = entry.track === next?.track ? 'showing' : 'disabled'
        })
        setActiveSub(next ? `emb:${next.index}` : 'off')
      } else if (event.key.toLowerCase() === 'm') {
        const video = videoRef.current
        if (video) video.muted = !video.muted
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      playIntentRef.current = true
      void video.play()
    } else {
      playIntentRef.current = false
      video.pause()
    }
  }

  /** Tiempo absoluto del vídeo (incluye el desfase de una conversión reiniciada). */
  const absoluteTime = () => seekOffsetRef.current + (videoRef.current?.currentTime ?? 0)

  /** Salta a un segundo concreto. En MPEG-TS convertido reinicia ffmpeg en ese punto. */
  const seekTo = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    playIntentRef.current = true
    const limit = duration > 0 ? duration : channel.duration && channel.duration > 0 ? channel.duration : 0
    const target = Math.max(0, limit > 0 ? Math.min(seconds, limit) : seconds)
    if (transcodeRef.current && seekRestartRef.current) {
      setCurrentTime(target)
      seekRestartRef.current(target)
      return
    }
    try {
      video.currentTime = target
      setCurrentTime(target)
    } catch {
      /* el motor todavía no admite saltos */
    }
  }

  const seekBy = (delta: number) => seekTo(absoluteTime() + delta)

  const toggleFullscreen = async () => {
    if (!shellRef.current) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await shellRef.current.requestFullscreen().catch(() => undefined)
  }

  const commitVolume = (value: number) => {
    setVolume(value)
    const video = videoRef.current
    if (video) {
      video.volume = value
      video.muted = value === 0
    }
    updateSettings({ volume: value })
  }

  const unmuteNow = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = false
    setAudioBlocked(false)
    void video.play().catch(() => undefined)
  }

  const progressMax = duration > 0 ? duration : 100
  const progressValue = duration > 0 ? Math.min(currentTime, duration) : 0

  const hasSubSources = subOptions.length > 1 || torrentSubs.length > 0
  const activeSubLabel =
    activeSub === 'off' ? '' : subOptions.find((option) => option.id === activeSub)?.label ?? ''
  const activeAudioLabel = currentAudio?.label ?? ''

  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div
        className={`player-shell ${idle && status === 'playing' ? 'is-idle' : ''}`}
        ref={shellRef}
      >
        {details?.backdropUrl && (status === 'loading' || status === 'error') && (
          <div
            className="player-backdrop"
            style={{ backgroundImage: `url("${details.backdropUrl}")` }}
            aria-hidden="true"
          />
        )}
        <video ref={videoRef} className="player-video" playsInline />

        {status === 'loading' && (
          <div className="player-loader">
            <span className="spinner" />
            <p>Conectando con {titleText}...</p>
            {loadNote && <small>{loadNote}</small>}
          </div>
        )}

        {status === 'error' && (
          <div className="player-error">
            <Icon name="wifi" size={42} />
            <h3>No se pudo reproducir</h3>
            <p>{error}</p>
            {transient && (
              <p className="player-error-hint">
                SquizanTV ya intenta convertir el vídeo y el audio a un formato compatible. Si aun así falla, el
                archivo puede estar dañado o usar un códec que la conversión interna no admite.
                {externalPlayer ? ` Prueba con ${externalPlayer}.` : ' Instala VLC para abrirlo sin problemas.'}
              </p>
            )}
            <div className="player-error-actions">
              <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
                <Icon name="refresh" size={16} /> Reintentar
              </button>
              {transient && externalPlayer && (
                <button type="button" className="btn" onClick={() => void openExternal()}>
                  <Icon name="external" size={16} /> Abrir en {externalPlayer}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(channel.url)
                }}
              >
                Copiar URL
              </button>
            </div>
          </div>
        )}

        {audioBlocked && (
          <button type="button" className="player-unmute" onClick={unmuteNow}>
            <Icon name="mute" size={15} />
            Activar sonido
          </button>
        )}

        {audioIssue && status !== 'error' && (
          <div className="player-audio-issue" role="status">
            <Icon name="audio" size={16} />
            <p>{audioIssue}</p>
            {externalPlayer && (
              <button type="button" onClick={() => void openExternal()}>
                <Icon name="external" size={14} /> Abrir en {externalPlayer}
              </button>
            )}
            <button type="button" className="dismiss" title="Cerrar aviso" onClick={() => setAudioIssue('')}>
              <Icon name="x" size={13} />
            </button>
          </div>
        )}

        <div className="player-top">
          <button type="button" className="icon-btn" onClick={onClose} title="Cerrar (Esc)">
            <Icon name="x" size={20} />
          </button>
          <div className="player-heading">
            {details?.logoUrl ? (
              <img className="player-logo" src={details.logoUrl} alt={titleText} />
            ) : (
              <strong>{titleText}</strong>
            )}
            <span>
              {[statusText ?? channel.group ?? playlist.name, details?.year, details?.genre]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="player-top-actions">
            {details?.plot && (
              <button
                type="button"
                className={`icon-btn ${showInfo ? 'is-active' : ''}`}
                title="Sinopsis"
                onClick={() => setShowInfo((value) => !value)}
              >
                <Icon name="info" size={18} />
              </button>
            )}
            {transient && externalPlayer && (
              <button
                type="button"
                className="icon-btn"
                title={`Abrir en ${externalPlayer}`}
                onClick={() => void openExternal()}
              >
                <Icon name="external" size={18} />
                <span className="player-external-label">{externalPlayer}</span>
              </button>
            )}
            {!transient && (
              <button
                type="button"
                className={`icon-btn ${favorite ? 'is-fav' : ''}`}
                title="Favorito"
                onClick={() => toggleFavorite(playlist.id, channel.id)}
              >
                <Icon name="heart" size={18} />
              </button>
            )}
          </div>
        </div>

        {showInfo && details && (
          <aside className="player-info">
            <header>
              <h3>{details.title}</h3>
              <button type="button" className="icon-btn" title="Cerrar sinopsis" onClick={() => setShowInfo(false)}>
                <Icon name="x" size={16} />
              </button>
            </header>
            {(details.year || details.genre || details.runtime || details.rating) && (
              <div className="player-info-chips">
                {details.year && <span>{details.year}</span>}
                {details.runtime && <span>{details.runtime}</span>}
                {details.rating && <span>★ {details.rating}</span>}
                {details.genre && <span>{details.genre}</span>}
              </div>
            )}
            {details.plot ? (
              <p>{details.plot}</p>
            ) : (
              <p className="muted">El torrent no incluye sinopsis.</p>
            )}
          </aside>
        )}

        {menu && (
          <div className="player-menu" role="menu">
            <header>
              <h4>{menu === 'sub' ? 'Subtítulos' : 'Pista de audio'}</h4>
              <button type="button" className="icon-btn" onClick={() => setMenu(null)}>
                <Icon name="x" size={14} />
              </button>
            </header>

            {menu === 'sub' && (
              <div className="player-menu-list">
                {subOptions.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`player-menu-item ${activeSub === option.id ? 'is-active' : ''}`}
                    onClick={() => void applySubChoice(option.id)}
                  >
                    <Icon name={activeSub === option.id ? 'check' : 'captions'} size={14} />
                    <span>{option.label}</span>
                    {option.hint && <em>{option.hint}</em>}
                  </button>
                ))}

                {torrentSubs.map((sub) => {
                  const label = sub.name
                  // Oculta la fila del torrent cuando el archivo ya está añadido:
                  // la entrada del menú con su estado activo ya la representa.
                  if (customSubs.some((entry) => entry.label === label)) return null
                  return (
                    <button
                      type="button"
                      key={`tor:${sub.url ?? 'local'}-${sub.name}`}
                      className="player-menu-item"
                      title={sub.name}
                      onClick={() => {
                        const existing = customSubs.find((entry) => entry.label === label)
                        if (existing) void applySubChoice(existing.id)
                        else void addSubtitleFile({ url: sub.url, name: sub.name, language: sub.language })
                      }}
                    >
                      <Icon name="captions" size={14} />
                      <span>{sub.name}</span>
                      {sub.language || sub.url ? <em>{sub.language || 'torrent'}</em> : null}
                    </button>
                  )
                })}

                <button
                  type="button"
                  className={`player-menu-item ${subLoading ? 'is-loading' : ''}`}
                  onClick={() => void addSubtitleFile({ url: null, name: '', language: '' })}
                >
                  <Icon name={subLoading ? 'download' : 'plus'} size={14} />
                  <span>{subLoading ? 'Cargando…' : 'Añadir archivo de subtítulos…'}</span>
                </button>

                {subError && <p className="player-menu-error">{subError}</p>}
              </div>
            )}

            {menu === 'audio' && (
              <div className="player-menu-list">
                {audioOptions.length > 0 ? (
                  audioOptions.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className={`player-menu-item ${currentAudio?.id === option.id ? 'is-active' : ''}`}
                      onClick={() => selectAudio(option.id)}
                    >
                      <Icon name={currentAudio?.id === option.id ? 'check' : 'audio'} size={14} />
                      <span>{option.label}</span>
                      {option.lang && <em>{option.lang}</em>}
                    </button>
                  ))
                ) : (
                  <p className="player-menu-note">
                    El reproductor interno solo expone una pista de audio.
                    {transient && ' Para elegir entre varias pistas (p. ej. doble audio) usa el botón de VLC arriba.'}
                  </p>
                )}
              </div>
            )}

            {(activeSubLabel || activeAudioLabel) && (
              <footer>
                {menu === 'sub' && activeSubLabel && <span>Activado: {activeSubLabel}</span>}
                {menu === 'audio' && activeAudioLabel && <span>Reproduciendo: {activeAudioLabel}</span>}
              </footer>
            )}
          </div>
        )}

        <div className="player-bottom">
          <div className={`player-timeline ${isVod ? 'is-vod' : ''}`}>
            {isVod && (
              <input
                type="range"
                min={0}
                max={progressMax}
                step={0.5}
                value={progressValue}
                disabled={duration <= 0}
                aria-label="Posición de la película"
                onChange={(event) => seekTo(Number(event.target.value))}
              />
            )}
            {isVod && duration <= 0 && <span className="player-time-unknown">Preparando la duración…</span>}
            {!isVod && (
              <span className="player-live">
                <span className="dot-live" /> EN DIRECTO
              </span>
            )}
          </div>

          <div className="player-controls">
            <button type="button" className="icon-btn" onClick={togglePlay} title="Reproducir / Pausar">
              <Icon name={status === 'playing' ? 'pause' : 'play'} size={20} />
            </button>

            {isVod ? (
              <div className="player-seek-group" role="group" aria-label="Saltar en el tiempo">
                <button type="button" className="icon-btn player-seek" onClick={() => seekBy(-30)} title="Retroceder 30 segundos">
                  <Icon name="rewind" size={17} />
                  <span>30</span>
                </button>
                <button type="button" className="icon-btn player-seek" onClick={() => seekBy(-10)} title="Retroceder 10 segundos">
                  <Icon name="rewind" size={14} />
                  <span>10</span>
                </button>
                <button type="button" className="icon-btn player-seek" onClick={() => seekBy(10)} title="Avanzar 10 segundos">
                  <Icon name="forward" size={14} />
                  <span>10</span>
                </button>
                <button type="button" className="icon-btn player-seek" onClick={() => seekBy(30)} title="Avanzar 30 segundos">
                  <Icon name="forward" size={17} />
                  <span>30</span>
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="icon-btn" onClick={() => goRelative(-1)} title="Anterior">
                  <Icon name="left" size={20} />
                </button>
                <button type="button" className="icon-btn" onClick={() => goRelative(1)} title="Siguiente">
                  <Icon name="right" size={20} />
                </button>
              </>
            )}

            <div className="player-volume">
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  const video = videoRef.current
                  if (!video) return
                  video.muted = !video.muted
                }}
                title="Silenciar (M)"
              >
                <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={19} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={(event) => commitVolume(Number(event.target.value))}
                aria-label="Volumen"
              />
            </div>

            <span className="player-time">
              {duration > 0 ? `${clock(currentTime)} / ${clock(duration)}` : isVod ? clock(currentTime) : ''}
            </span>

            <div className="player-spacer" />

            {(hasSubSources || isVod) && (
              <button
                type="button"
                className={`icon-btn ${activeSub !== 'off' ? 'is-active' : ''}`}
                onClick={() => setMenu(menu === 'sub' ? null : 'sub')}
                title="Subtítulos (C)"
              >
                <Icon name="captions" size={18} />
                {activeSub !== 'off' && <span className="track-dot" />}
              </button>
            )}

            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                if (menu === 'audio') {
                  setMenu(null)
                } else {
                  setListTick((tick) => tick + 1)
                  setMenu('audio')
                }
              }}
              title="Pistas de audio"
            >
              <Icon name="audio" size={18} />
              {activeAudioLabel && <span className="track-dot" />}
            </button>

            <button type="button" className="icon-btn" onClick={toggleFullscreen} title="Pantalla completa (F)">
              <Icon name={fullscreen ? 'minimize' : 'maximize'} size={19} />
            </button>
          </div>

          {(now || upcoming.length > 0) && (
            <div className="player-epg">
              {now && (
                <div className="player-epg-now">
                  <span className="player-epg-label">Ahora</span>
                  <strong>{now.title}</strong>
                  <span>
                    {formatTime(now.start)} - {formatTime(now.stop)}
                  </span>
                </div>
              )}
              {upcoming.length > 0 && (
                <div className="player-epg-next">
                  {upcoming.slice(0, 2).map((item) => (
                    <div key={`${item.channel}-${item.start}`}>
                      <span>{formatTime(item.start)}</span>
                      <span>{item.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
