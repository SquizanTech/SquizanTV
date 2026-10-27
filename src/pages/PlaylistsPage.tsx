import { useState } from 'react'
import type { Playlist } from '../types'
import { useDb } from '../store'
import { parseM3U } from '../lib/m3u'
import { fetchXtream } from '../lib/xtream'
import { hostOf } from '../lib/util'
import { Icon } from '../components/Icons'
import { EmptyState } from '../components/EmptyState'

interface PlaylistsPageProps {
  onAdd: () => void
}

export function PlaylistsPage({ onAdd }: PlaylistsPageProps) {
  const { db, addPlaylist, updatePlaylist, removePlaylist, setActivePlaylist } = useDb()
  const [editingEpg, setEditingEpg] = useState<string | null>(null)
  const [epgDraft, setEpgDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ id: string; type: 'ok' | 'error'; text: string } | null>(null)

  const refresh = async (playlist: Playlist) => {
    setBusyId(playlist.id)
    setNotice(null)
    try {
      if (playlist.type === 'xtream' && playlist.xtream) {
        const result = await fetchXtream(playlist.xtream)
        updatePlaylist(playlist.id, { channels: result.channels, epgUrl: result.epgUrl })
        setNotice({ id: playlist.id, type: 'ok', text: `${result.channels.length} elementos actualizados.` })
      } else if (playlist.source && /^https?:\/\//i.test(playlist.source)) {
        const response = await window.nova.net.fetch({ url: playlist.source, timeout: 45000 })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const parsed = parseM3U(response.text)
        if (parsed.channels.length === 0) throw new Error('La lista no contiene canales validos.')
        updatePlaylist(playlist.id, {
          channels: parsed.channels,
          epgUrl: parsed.epgUrl || playlist.epgUrl,
        })
        setNotice({ id: playlist.id, type: 'ok', text: `${parsed.channels.length} canales actualizados.` })
      } else {
        const picked = await window.nova.dialog.openPlaylist()
        if (!picked) return
        const parsed = parseM3U(picked.content)
        if (parsed.channels.length === 0) throw new Error('El archivo no contiene canales validos.')
        updatePlaylist(playlist.id, {
          channels: parsed.channels,
          source: picked.path,
          name: playlist.name,
          epgUrl: parsed.epgUrl || playlist.epgUrl,
        })
        setNotice({ id: playlist.id, type: 'ok', text: `${parsed.channels.length} canales actualizados.` })
      }
    } catch (cause) {
      setNotice({
        id: playlist.id,
        type: 'error',
        text: cause instanceof Error ? cause.message : 'No se pudo actualizar.',
      })
    } finally {
      setBusyId(null)
    }
  }

  const duplicate = (playlist: Playlist) => {
    const copy: Playlist = {
      ...playlist,
      id: `${playlist.id}-copy-${Date.now().toString(36)}`,
      name: `${playlist.name} (copia)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    addPlaylist(copy)
  }

  return (
    <div className="page">
      <div className="section-head">
        <div>
          <h3>Tus listas</h3>
          <p className="muted">
            {db.playlists.length} {db.playlists.length === 1 ? 'lista configurada' : 'listas configuradas'}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          <Icon name="plus" size={16} /> Añadir lista
        </button>
      </div>

      {db.playlists.length === 0 ? (
        <EmptyState
          icon="list"
          title="No hay listas todavía"
          description="Carga un M3U desde URL o archivo, o conecta tu cuenta Xtream Codes."
          action={
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              <Icon name="plus" size={16} /> Añadir la primera
            </button>
          }
        />
      ) : (
        <div className="playlist-grid">
          {db.playlists.map((playlist) => {
            const active = db.activePlaylist === playlist.id
            const counts = {
              live: playlist.channels.filter((channel) => channel.kind === 'live').length,
              movies: playlist.channels.filter((channel) => channel.kind === 'movie').length,
              series: playlist.channels.filter((channel) => channel.kind === 'series').length,
            }
            return (
              <article className={`playlist-card ${active ? 'active' : ''}`} key={playlist.id}>
                <div className="playlist-card-head">
                  <span className="playlist-type">
                    <Icon name={playlist.type === 'xtream' ? 'wifi' : 'list'} size={15} />
                    {playlist.type === 'xtream' ? 'Xtream Codes' : 'M3U'}
                  </span>
                  {active && <span className="badge">Activa</span>}
                </div>

                <h4 title={playlist.name}>{playlist.name}</h4>
                <span className="playlist-source" title={playlist.source}>
                  {playlist.source && /^https?:\/\//i.test(playlist.source) ? hostOf(playlist.source) : playlist.source || 'Archivo local'}
                </span>

                <div className="playlist-counts">
                  <span><strong>{counts.live}</strong> directos</span>
                  <span><strong>{counts.movies}</strong> pelis</span>
                  <span><strong>{counts.series}</strong> series</span>
                </div>

                <div className="playlist-epg">
                  <span>
                    <Icon name="calendar" size={14} /> EPG:{' '}
                    {playlist.epgUrl ? 'configurado' : 'no configurado'}
                  </span>
                  {editingEpg === playlist.id ? (
                    <div className="epg-edit">
                      <input
                        value={epgDraft}
                        onChange={(event) => setEpgDraft(event.target.value)}
                        placeholder="https://.../epg.xml"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="Guardar"
                        onClick={() => {
                          updatePlaylist(playlist.id, { epgUrl: epgDraft.trim() || undefined })
                          setEditingEpg(null)
                        }}
                      >
                        <Icon name="check" size={15} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setEditingEpg(playlist.id)
                        setEpgDraft(playlist.epgUrl ?? '')
                      }}
                    >
                      Editar
                    </button>
                  )}
                </div>

                {notice?.id === playlist.id && (
                  <div className={`alert ${notice.type === 'ok' ? 'ok' : 'error'}`}>
                    <Icon name={notice.type === 'ok' ? 'check' : 'info'} size={14} />
                    <span>{notice.text}</span>
                  </div>
                )}

                <div className="playlist-actions">
                  {!active && (
                    <button type="button" className="btn btn-sm" onClick={() => setActivePlaylist(playlist.id)}>
                      <Icon name="check" size={14} /> Activar
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => refresh(playlist)}
                    disabled={busyId === playlist.id}
                  >
                    {busyId === playlist.id ? <span className="spinner small" /> : <Icon name="refresh" size={14} />}
                    Actualizar
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => duplicate(playlist)} title="Duplicar">
                    <Icon name="layers" size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Eliminar lista"
                    onClick={() => {
                      if (window.confirm(`¿Eliminar la lista "${playlist.name}"? Esta acción no se puede deshacer.`)) {
                        removePlaylist(playlist.id)
                      }
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
