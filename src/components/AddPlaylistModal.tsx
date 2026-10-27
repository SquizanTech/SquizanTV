import { useEffect, useState } from 'react'
import type { Channel, Playlist } from '../types'
import { parseM3U } from '../lib/m3u'
import { fetchXtream, normalizeServer } from '../lib/xtream'
import { hostOf, uid, sanitizeName } from '../lib/util'
import { Icon } from './Icons'

interface AddPlaylistModalProps {
  onClose: () => void
  onAdded: (playlist: Playlist) => void
}

type Mode = 'm3u' | 'xtream'

function nameFromUrl(url: string): string {
  const host = hostOf(url)
  if (!host) return 'Mi lista'
  const path = url.split('?')[0].split('/').filter(Boolean).pop()
  const base = path && path.length > 2 && !path.includes('.php') ? path.replace(/\.(m3u8?|txt)$/i, '') : host
  return base || host
}

export function AddPlaylistModal({ onClose, onAdded }: AddPlaylistModalProps) {
  const [mode, setMode] = useState<Mode>('m3u')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [epgUrl, setEpgUrl] = useState('')
  const [file, setFile] = useState<{ path: string; name: string; content: string } | null>(null)
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [busy, onClose])

  const pickFile = async () => {
    const picked = await window.nova.dialog.openPlaylist()
    if (!picked) return
    setFile(picked)
    if (!name) setName(picked.name.replace(/\.(m3u8?|txt)$/i, ''))
    setError('')
  }

  const submit = async () => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      let playlist: Playlist

      if (mode === 'm3u') {
        let text = ''
        let source = ''
        if (file) {
          text = file.content
          source = file.path
          setProgress('Leyendo archivo...')
        } else {
          const cleanUrl = url.trim()
          if (!cleanUrl) throw new Error('Pega la URL de la lista o carga un archivo .m3u.')
          if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('La URL debe empezar por http:// o https://')
          setProgress('Descargando lista M3U...')
          const response = await window.nova.net.fetch({ url: cleanUrl, timeout: 45000 })
          if (!response.ok) {
            throw new Error(`No se pudo descargar la lista (HTTP ${response.status}).`)
          }
          text = response.text
          source = cleanUrl
        }

        setProgress('Analizando canales...')
        const parsed = parseM3U(text)
        if (parsed.channels.length === 0) {
          throw new Error('La lista no contiene canales validos. Revisa que sea un M3U con enlaces http.')
        }

        playlist = {
          id: uid(),
          name: sanitizeName(name) || (file ? file.name : nameFromUrl(source)),
          type: 'm3u',
          source,
          epgUrl: epgUrl.trim() || parsed.epgUrl,
          channels: parsed.channels,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        setProgress(`${parsed.channels.length} canales cargados`)
      } else {
        if (!server.trim() || !username.trim() || !password.trim()) {
          throw new Error('Completa servidor, usuario y contrasena.')
        }
        const creds = {
          server: normalizeServer(server),
          username: username.trim(),
          password: password.trim(),
        }
        const result = await fetchXtream(creds, setProgress)
        const channels: Channel[] = result.channels
        if (channels.length === 0) {
          throw new Error('La cuenta es valida pero no devolvio canales.')
        }
        playlist = {
          id: uid(),
          name: sanitizeName(name) || `Xtream ${hostOf(creds.server) || 'IPTV'}`,
          type: 'xtream',
          source: creds.server,
          xtream: creds,
          epgUrl: result.epgUrl,
          channels,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        setProgress(`${channels.length} elementos cargados`)
      }

      onAdded(playlist)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ocurrio un error inesperado.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal add-modal">
        <div className="modal-head">
          <div>
            <h2>Añadir lista</h2>
            <p>M3U/M3U8, archivo local o Xtream Codes</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy}>
            <Icon name="x" size={19} />
          </button>
        </div>

        <div className="tabs">
          <button
            type="button"
            className={mode === 'm3u' ? 'active' : ''}
            onClick={() => setMode('m3u')}
            disabled={busy}
          >
            <Icon name="list" size={16} /> Lista M3U
          </button>
          <button
            type="button"
            className={mode === 'xtream' ? 'active' : ''}
            onClick={() => setMode('xtream')}
            disabled={busy}
          >
            <Icon name="wifi" size={16} /> Xtream Codes
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>Nombre de la lista</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={mode === 'm3u' ? 'Mi lista IPTV' : 'Mi proveedor'}
              disabled={busy}
            />
          </label>

          {mode === 'm3u' ? (
            <>
              <label className="field">
                <span>URL de la lista</span>
                <input
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value)
                    if (file) setFile(null)
                  }}
                  placeholder="https://ejemplo.com/lista.m3u"
                  disabled={busy || Boolean(file)}
                  spellCheck={false}
                />
              </label>

              <div className="or-row">
                <span>o</span>
              </div>

              <button type="button" className={`file-picker ${file ? 'has-file' : ''}`} onClick={pickFile} disabled={busy}>
                <Icon name={file ? 'check' : 'upload'} size={18} />
                <span>{file ? file.name : 'Cargar un archivo .m3u desde el PC'}</span>
                {file && (
                  <em
                    onClick={(event) => {
                      event.stopPropagation()
                      setFile(null)
                    }}
                  >
                    quitar
                  </em>
                )}
              </button>

              <label className="field">
                <span>URL del EPG (opcional)</span>
                <input
                  value={epgUrl}
                  onChange={(event) => setEpgUrl(event.target.value)}
                  placeholder="https://ejemplo.com/epg.xml"
                  disabled={busy}
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Servidor</span>
                <input
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  placeholder="http://mi-proveedor.com:8080"
                  disabled={busy}
                  spellCheck={false}
                />
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Usuario</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="usuario"
                    disabled={busy}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>Contraseña</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••"
                    disabled={busy}
                  />
                </label>
              </div>
              <p className="hint">
                El EPG se descarga automaticamente del servidor Xtream (<code>xmltv.php</code>).
              </p>
            </>
          )}

          {busy && (
            <div className="progress-box">
              <span className="spinner small" />
              <span>{progress || 'Procesando...'}</span>
            </div>
          )}

          {error && (
            <div className="alert error">
              <Icon name="info" size={16} />
              <span>{error}</span>
            </div>
          )}

          <p className="hint legal">
            NovaTV no incluye ni distribuye contenido. Usa solo listas y cuentas que tengas derecho a utilizar.
          </p>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner small" /> : <Icon name="plus" size={16} />}
            Cargar lista
          </button>
        </div>
      </div>
    </div>
  )
}
