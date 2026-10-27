import { useEffect, useState } from 'react'
import { useDb } from '../store'
import { Icon } from '../components/Icons'

export function SettingsPage() {
  const { db, updateSettings, resetAll } = useDb()
  const [version, setVersion] = useState('0.1.0')
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<{ type: 'info' | 'ok' | 'error'; text: string } | null>(null)
  const [downloaded, setDownloaded] = useState<string | null>(null)
  const [feed, setFeed] = useState(db.settings.updateFeed)

  useEffect(() => {
    void window.nova.app.version().then(setVersion)
  }, [])

  useEffect(() => {
    setFeed(db.settings.updateFeed)
  }, [db.settings.updateFeed])

  useEffect(() => {
    const off = window.nova.updates.onEvent((payload) => {
      const type = String(payload.type ?? '')
      if (type === 'checking') setStatus({ type: 'info', text: 'Buscando actualizaciones...' })
      if (type === 'available') setStatus({ type: 'info', text: `Descargando la versión ${payload.version}...` })
      if (type === 'none') setStatus({ type: 'ok', text: 'Ya tienes la última versión instalada.' })
      if (type === 'progress') setStatus({ type: 'info', text: `Descargando actualización: ${payload.percent}%` })
      if (type === 'downloaded') {
        setDownloaded(String(payload.version ?? ''))
        setStatus({ type: 'ok', text: `Versión ${payload.version} lista para instalar.` })
      }
      if (type === 'error') setStatus({ type: 'error', text: String(payload.message ?? 'Error de actualización.') })
    })
    return off
  }, [])

  const checkUpdates = async () => {
    setChecking(true)
    setStatus({ type: 'info', text: 'Buscando actualizaciones...' })
    const result = await window.nova.updates.check(feed)
    setChecking(false)
    if (!result.ok) {
      setStatus({ type: 'error', text: result.message ?? 'No se pudo comprobar la actualización.' })
    }
  }

  return (
    <div className="page settings">
      <section className="card">
        <div className="card-head">
          <span className="card-icon"><Icon name="settings" size={17} /></span>
          <div>
            <h3>Apariencia</h3>
            <p>Elige el tema de la interfaz.</p>
          </div>
        </div>
        <div className="segmented">
          <button
            type="button"
            className={db.settings.theme === 'dark' ? 'active' : ''}
            onClick={() => updateSettings({ theme: 'dark' })}
          >
            Oscuro
          </button>
          <button
            type="button"
            className={db.settings.theme === 'light' ? 'active' : ''}
            onClick={() => updateSettings({ theme: 'light' })}
          >
            Claro
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-icon"><Icon name="calendar" size={17} /></span>
          <div>
            <h3>Guía de programación (EPG)</h3>
            <p>Descarga el XMLTV al abrir la app y al cambiar de lista.</p>
          </div>
        </div>
        <button
          type="button"
          className={`switch ${db.settings.epgAutoRefresh ? 'on' : ''}`}
          onClick={() => updateSettings({ epgAutoRefresh: !db.settings.epgAutoRefresh })}
          aria-pressed={db.settings.epgAutoRefresh}
        >
          <span className="switch-track"><span className="switch-thumb" /></span>
          {db.settings.epgAutoRefresh ? 'Actualización automática activada' : 'Actualización manual'}
        </button>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-icon"><Icon name="download" size={17} /></span>
          <div>
            <h3>Actualizaciones</h3>
            <p>NovaTV se actualiza desde tu propio servidor de releases.</p>
          </div>
        </div>

        <label className="field">
          <span>Servidor de actualizaciones (URL base)</span>
          <input
            value={feed}
            onChange={(event) => setFeed(event.target.value)}
            onBlur={() => updateSettings({ updateFeed: feed.trim() })}
            placeholder="https://tudominio.com/novatv/updates"
            spellCheck={false}
          />
        </label>
        <p className="hint">
          Sube ahí el instalador y el archivo <code>latest.yml</code> que genera <code>npm run dist</code>. Sin URL,
          se usará la configurada al compilar.
        </p>

        <div className="inline-actions">
          <button type="button" className="btn" onClick={checkUpdates} disabled={checking}>
            {checking ? <span className="spinner small" /> : <Icon name="refresh" size={15} />}
            Buscar actualizaciones
          </button>
          {downloaded && (
            <button type="button" className="btn btn-primary" onClick={() => window.nova.updates.install()}>
              <Icon name="download" size={15} /> Instalar {downloaded} y reiniciar
            </button>
          )}
        </div>

        {status && (
          <div className={`alert ${status.type === 'error' ? 'error' : status.type === 'ok' ? 'ok' : ''}`}>
            <Icon name={status.type === 'error' ? 'info' : status.type === 'ok' ? 'check' : 'download'} size={15} />
            <span>{status.text}</span>
          </div>
        )}
        {!window.nova ? null : (
          <p className="hint">Versión instalada: {version}. En modo desarrollo las actualizaciones están desactivadas.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-icon"><Icon name="folder" size={17} /></span>
          <div>
            <h3>Datos y privacidad</h3>
            <p>Listas, credenciales, favoritos e historial se guardan solo en este equipo.</p>
          </div>
        </div>
        <div className="inline-actions">
          <button type="button" className="btn" onClick={() => window.nova.app.openDataFolder()}>
            <Icon name="folder" size={15} /> Abrir carpeta de datos
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm('¿Borrar todas las listas, favoritos e historial? Esta acción no se puede deshacer.')) {
                resetAll()
              }
            }}
          >
            <Icon name="trash" size={15} /> Restablecer NovaTV
          </button>
        </div>
      </section>

      <section className="card about">
        <div className="about-mark">
          <Icon name="play" size={18} strokeWidth={2.4} />
        </div>
        <div>
          <h3>NovaTV <span className="badge">v{version}</span></h3>
          <p>
            Reproductor IPTV para Windows con M3U, Xtream Codes, EPG y soporte HLS / MPEG-TS. Construido con
            Electron, React y software libre.
          </p>
          <p className="hint">
            NovaTV no incluye contenido ni listas. Solo reproduce las fuentes que tú configures.
          </p>
        </div>
      </section>
    </div>
  )
}
