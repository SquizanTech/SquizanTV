# NovaTV

Reproductor IPTV de escritorio para Windows, inspirado en IPTVnator. Listas M3U/M3U8, Xtream Codes, EPG XMLTV, favoritos, historial y reproductor HLS + MPEG-TS, todo en local.

![NovaTV](build/icon.png)

## Características

- **Listas M3U/M3U8** desde URL o archivo local, con detección de grupos y logos (`tvg-logo`, `group-title`, `tvg-id`).
- **Xtream Codes**: login con servidor/usuario/contraseña, canales en directo, películas, series con temporadas y episodios.
- **EPG XMLTV**: descarga automática (incluye `.xml.gz` descomprimido en el proceso principal), "ahora/siguiente", línea de tiempo de 12 horas y guía por canal.
- **Torrents**: reproduce enlaces magnet y archivos `.torrent` mientras se descargan, con arranque en segundos, descarga secuencial por bloques (estilo Stremio/WebTorrent) y búsqueda en el tiempo (seek).
- **Descubrir con addons de Stremio (0.4.0)**: instala addons por URL o manifest (`stremio://…`), activa o desactiva cada uno y navega por sus catálogos con géneros, búsqueda y fichas completas. Las fuentes de addons como Torrentio se reproducen con el motor de torrents interno, sin salir de Nova.
- **Rediseño minimalista (0.4.0)**: interfaz oscura premium en negro (`#0D0D0D`), tarjetas `#1A1A1A`, acento rojo `#E50914` y detalles dorados `#FFB800`; navegación más limpia y foco en el contenido.
- **Fichas de película desde el propio torrent**: detecta póster, fanart y logo (`.jpg`, `.png`…) y lee la sinopsis, año, género, nota y duración del `.nfo` de Kodi (UTF-8 o Windows-1252).
- **Subtítulos estilo VLC**: menú CC con las pistas incluidas en el vídeo (HLS), los archivos `.srt`/`.vtt`/`.ass` que vengan dentro del torrent (se convierten SRT/ASS → cues WebVTT al vuelo) y "Añadir archivo de subtítulos…" del disco. Atajos: `C` cambia de pista.
- **Pistas de audio**: selector en HLS (multi-audio) y nativo cuando el motor lo expone; para MKV con doble audio usa el botón de VLC.
- **Reproductor externo**: si un MKV/H.265 no se abre en Chromium, un botón lo envía a VLC (o mpv) instalado en el equipo.
- **Sonido garantizado (0.3.2)**: política de autoplay con sonido, AceStream (MPEG-TS sin extensión) enrutado al motor correcto, cambio automático de pista de audio cuando la televisión separa el audio (EXT-X-MEDIA) y aviso con botón "Abrir en VLC" cuando el canal trae Dolby AC-3, que Chromium no decodifica.
- **Magnetos con sonido (0.3.3)**: si el vídeo del torrent trae Dolby (E-AC-3/AC-3), DTS u otro audio que Chromium no decodifica, Nova lo convierte a AAC en caliente con su ffmpeg integrado (vídeo copiado sin recodificar) y lo reproduce con el motor MPEG-TS: suena sin salir de la app. Los ficheros de torrent se analizan con ffmpeg para elegir reproducción directa o conversión.
- **Reproductor** con `hls.js` (HLS) y `mpegts.js` (MPEG-TS), fallback automático `.m3u8` → `.ts`, pantalla completa, volumen y atajos.
- **Favoritos, historial y búsqueda** global en todas las vistas.
- **Multi-lista**: varias listas a la vez, activación y actualización sin reiniciar.
- **Instalador NSIS** con accesos directos y **actualizaciones** vía `electron-updater`.
- Interfaz en español, tema oscuro/claro y datos 100 % locales (`%APPDATA%\NovaTV`).

## Requisitos

- Windows 10/11 x64
- Node.js 20+ (solo para desarrollo)
- Una lista M3U o cuenta Xtream propia

## Desarrollo

```powershell
npm install
npm run dev
```

`npm run dev` levanta Vite en `127.0.0.1:5173` y Electron apuntando a ese servidor.

También puedes abrir la interfaz sin Electron (útil para maquetar):

```powershell
npm run build
npx vite preview --port 4173
```

En ese modo se usa `src/lib/mockBridge.ts` (localStorage + fetch del navegador) en lugar del puente IPC.

## Compilar el instalador

```powershell
npm run dist
```

Genera en `release/`:

- `NovaTV-Setup-0.4.0.exe` - instalador NSIS (elige carpeta, crea accesos directos).
- `NovaTV-Setup-0.4.0.exe.blockmap` y `latest.yml` - necesarios para actualizaciones.
- `win-unpacked/` — versión sin instalar para probar.

Versión portable (un solo `.exe`):

```powershell
npm run dist:portable
```

### Icono

`scripts/make-icon.ps1` genera `build/icon.png`. Sustitúyelo por tu logo si quieres (512×512 PNG).

## Actualizaciones

NovaTV usa `electron-updater` con proveedor **generic**:

1. Compila con `npm run dist`.
2. Sube a tu servidor la carpeta `release/` (o al menos el `.exe`, el `.blockmap` y `latest.yml`).
3. Indica la URL base en **Ajustes → Actualizaciones** (o cambia `publish.url` en `electron-builder.yml`).
4. Al pulsar "Buscar actualizaciones", la app compara versiones, descarga y ofrece "Instalar y reiniciar".

Para publicar una versión nueva: sube `version` en `package.json`, vuelve a compilar y reemplaza los archivos del servidor. No cambies el `appId` ni el nombre del artefacto.

> Las actualizaciones solo funcionan en la app instalada (no en `npm run dev`).

## Addons de Stremio

En **Descubrir** puedes instalar addons de catálogo y metadatos del ecosistema Stremio:

1. Pulsa **Addons** y pega la URL del manifest (`https://…/manifest.json`), la raíz del addon o un enlace `stremio://…`.
2. Activa o desactiva cada addon con el interruptor, o quítalo con la papelera.
3. Elige addon, catálogo, género y busca dentro del catálogo. Al abrir una ficha se cargan sinopsis, reparto y temporadas/episodios.
4. Las fuentes se piden a todos los addons activos que ofrezcan `stream`. Un enlace magnet se añade al motor de torrents; una URL directa/HLS se abre en el reproductor; los enlaces externos se abren en el navegador.

Recomendados desde la propia app: **Cinemeta** (catálogos de IMDb) y **Torrentio** (fuentes magnet). Nova no incluye ni aloja addons: cada usuario decide cuáles instala y es responsable del uso que haga de ellos.

## Torrents (magnet y `.torrent`)

En la sección **Torrents** puedes pegar un enlace `magnet:` o abrir un archivo `.torrent`.

Cómo funciona:

1. El proceso principal usa `webtorrent` (DHT + trackers TCP/UDP) para conectar con los pares. La DHT se arranca al abrir la sección para que el primer magnet no espere.
2. Al recibir los metadatos, muestra la lista de archivos, elige el vídeo más grande y prepara sus primeros 3 MB con prioridad alta (primer fotograma en ~1 s con pares disponibles).
3. Al pulsar «Reproducir», levanta un servidor HTTP en `127.0.0.1` con soporte de `Range`. Las peticiones abiertas se sirven en bloques de 16 MB y los rangos con sufijo (`bytes=-N`) se atienden aparte, de modo que WebTorrent descarga en orden lo que estás viendo y no todo el archivo a la vez.
4. Los datos se guardan en `%TEMP%\NovaTV\torrents` hasta que pulses «Borrar caché».

Metadatos de la ficha:

- Busca imágenes por nombre (`poster`, `cover`, `folder`, `fanart`, `backdrop`, `clearlogo`, `logo`…) y las sirve por el mismo servidor local.
- Lee el `.nfo`/`movie.nfo` del torrent (también `windows-1252`) y muestra título, sinopsis, año, géneros, nota y duración.
- Si no hay `.nfo`, deduce título y año del nombre del release.
- En el reproductor, el logo aparece arriba y la sinopsis en un panel con el botón de información.

Notas:

- Los addons se gestionan en **Descubrir**; Torrents sigue aceptando cualquier magnet o `.torrent` que aportes directamente.
- Si no aparecen pares, revisa el firewall de Windows (permite NovaTV en redes privadas) y que el enlace incluya trackers (`&tr=`).
- Al usar BitTorrent tu IP es visible para los demás pares. Para contenido privado, usa una VPN o comparte el archivo por otro medio.
- La compatibilidad de códecs depende de Chromium/Electron: MP4 (H.264/AAC) y WebM funcionan siempre; MKV con H.264 también (probado a 720p); H.265/AV1 puede no reproducirse. Si falla, el reproductor ofrece «Abrir en VLC» cuando detecta VLC o mpv instalado.

Prueba automatizada del servicio (sin interfaz):

```powershell
npm run test:torrent
```

Crea un torrent local con vídeo, póster y `.nfo` en windows-1252, lo siembra con un cliente y verifica detección de tipos, lectura de sinopsis, póster por HTTP, streaming por rangos (incluido el límite de 16 MB y el rango sufijo), `HEAD`, `416`, token inválido, duplicados y limpieza.

Comprobación con un torrent público real (necesita red; descarga unos pocos MB y compara los bytes con el ISO oficial):

```powershell
node scripts\real-torrent-check.cjs
```

## Estructura

```
electron/                 proceso principal + preload (IPC, red, actualizador)
electron/torrent-service.ts  cliente BitTorrent + servidor HTTP con rangos
electron/torrent.ts       puente IPC de torrents y diálogo .torrent
src/lib/                  parsers M3U, XMLTV, cliente Xtream, cliente Stremio, utilidades
src/components/           Sidebar, Topbar, reproductor, tarjetas, modales
src/pages/                Inicio, Directo, Descubrir, Películas, Series, EPG, Torrents...
src/store.tsx             estado global + persistencia (novatv.json)
src/styles.css            sistema visual completo
```

El proceso principal expone en `window.nova`:

- `db.read()` / `db.write(data)` — persistencia atómica en `%APPDATA%\NovaTV\novatv.json`
- `net.fetch(req)` — descargas sin CORS (listas, EPG, APIs Xtream), con descompresión gzip
- `dialog.openPlaylist()` — selector de archivos
- `updates.check(feed)` / `updates.install()` / `updates.onEvent(cb)`
- `torrents.add()` / `torrents.list()` / `torrents.remove()` / `torrents.clearCache()` / `torrents.openFile()`
- `torrents.readText(id, index)` — lee el `.nfo` del torrent para la sinopsis
- `torrents.onUpdate(cb)` / `torrents.onError(cb)` — progreso en vivo de los torrents
- `app.externalPlayer()` / `app.openExternalPlayer(url)` — detecta VLC/mpv y abre una fuente local de NovaTV

## Limitaciones conocidas

- **DRM**: no reproduce Widevine (Netflix, Disney+, etc.). Para HLS/TS normal no hay problema.
- **Firma de código**: el instalador no está firmado. Windows SmartScreen mostrará un aviso y, en equipos con **Smart App Control** activado, puede bloquear la ejecución. Soluciones: desactivar Smart App Control o firmar con un certificado de code signing.
- **MKV/AV1**: el códec depende de Chromium; si un archivo no se reproduce, usa una fuente HLS/TS o un reproductor externo.
- **Torrents**: necesitan pares accesibles. Si el firewall o la red bloquean UDP, la DHT no encuentra peers; usa enlaces con trackers y permite NovaTV en el firewall.
- Algunos proveedores limitan el número de conexiones simultáneas o bloquean el User-Agent.

## Legal

NovaTV no incluye, aloja ni distribuye listas, canales, torrents, addons ni contenido. Solo reproduce las fuentes que el usuario configure o instale. Usa únicamente listas, cuentas, addons y archivos sobre los que tengas derechos.
