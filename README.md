# SquizanTV

Reproductor de escritorio para Windows con IPTV (M3U y Xtream Codes), EPG, películas y series, y reproducción de torrents mientras se descargan. Todo se ejecuta en tu equipo.

<p align="center">
  <img src="build/icon.png" width="140" alt="Logo de SquizanTV">
</p>

> El repositorio sigue llamándose **NovaTV** por historia del proyecto, pero el producto y la aplicación se llaman **SquizanTV**.

---

## Descargar e instalar (para usuarios)

### 1. Descarga el instalador

Entra en **[Releases](https://github.com/SquizanTech/NovaTV/releases)** y descarga el archivo más reciente:

```
SquizanTV-Setup-0.5.0.exe
```

También puedes usar la versión portable `SquizanTV-Portable-0.5.0.exe` si no quieres instalar nada.

### 2. Ejecuta el instalador

1. Doble clic en `SquizanTV-Setup-….exe`.
2. Elige la carpeta de instalación (o deja la que propone).
3. Pulsa **Instalar** y espera unos segundos.
4. Al terminar, SquizanTV se abre y crea los accesos directos en el escritorio y el menú Inicio.

> **Aviso de Windows:** el instalador no está firmado con un certificado de pago. Es normal que SmartScreen muestre “Windows protegió tu PC”. Pulsa **Más información → Ejecutar de todas formas**. Si tienes **Smart App Control** activado, Windows puede bloquear la app; desactívalo o usa la versión portable.

### 3. Primeros pasos

**Para ver la televisión:**

1. Abre **Mis listas → Añadir lista**.
2. Pega la URL de tu lista M3U/M3U8 o los datos de tu cuenta Xtream Codes (servidor, usuario y contraseña).
3. Espera a que se lean los canales. El EPG se descarga solo si la lista lo incluye.
4. Usa **Directo**, **Películas**, **Series**, **EPG**, **Favoritos** e **Historial** desde la barra lateral.

**Para reproducir un torrent:**

1. Ve a **Torrents**.
2. Pega un enlace `magnet:` o abre un archivo `.torrent`.
3. En cuanto aparezcan los archivos y haya un par disponible, pulsa **Reproducir mientras descarga**. No hace falta esperar a que termine la descarga.
4. En películas tienes barra de progreso, botones de **−30 s / −10 s / +10 s / +30 s**, subtítulos y pistas de audio.
5. Los datos temporales se guardan en `%TEMP%\SquizanTV\torrents`. Pulsa **Borrar caché** para liberar espacio.

**Para descubrir películas y series:**

1. Ve a **Descubrir → Addons**.
2. Instala **Cinemeta** para navegar por los catálogos de IMDb.
3. Abre una ficha para ver sinopsis, reparto y temporadas.

SquizanTV solo reproduce las fuentes que tú configures. No incluye listas, canales, torrents ni addons.

### Dónde se guardan tus datos

- Ajustes, listas, favoritos e historial: `%APPDATA%\SquizanTV\squizantv.json`
- Caché de torrents: `%TEMP%\SquizanTV\torrents`
- Si vienes de la versión anterior (NovaTV), la app copia automáticamente tus datos la primera vez que arranca.

---

## Documentación técnica

### Requisitos

- Windows 10/11 x64
- Node.js 20 o superior (solo para desarrollo)
- Una lista M3U, una cuenta Xtream propia o un enlace magnet

### Desarrollo

```powershell
npm install
npm run dev
```

`npm run dev` compila el proceso principal, levanta Vite en `127.0.0.1:5173` y abre Electron apuntando a ese servidor.

Para maquetar solo la interfaz, sin Electron:

```powershell
npm run build
npx vite preview --port 4173
```

En ese modo se usa `src/lib/mockBridge.ts` (localStorage + `fetch`) en lugar del puente IPC.

### Compilar el instalador

```powershell
npm run dist
```

Genera en `release/`:

- `SquizanTV-Setup-0.5.0.exe`: instalador NSIS.
- `latest.yml` y el `.blockmap`: necesarios para las actualizaciones.
- `win-unpacked/`: versión sin instalar para probar.

Versión portable en un solo archivo:

```powershell
npm run dist:portable
```

### Pruebas

```powershell
npm run typecheck
npm run test:torrent
```

`test:torrent` crea un torrent local con vídeo, póster y `.nfo`, lo siembra y comprueba tipos de archivo, lectura de sinopsis, póster por HTTP, streaming por rangos (incluidos los bloques de 2 MB, el rango sufijo, `HEAD` y `416`), duplicados y limpieza.

Prueba opcional con un torrent público real (necesita red):

```powershell
node scripts\real-torrent-check.cjs
```

### Arquitectura

```
electron/                    proceso principal + preload
  main.ts                    ventana, IPC, red, actualizador, migración de datos
  torrent-service.ts         cliente BitTorrent + servidor HTTP con rangos
  torrent.ts                 puente IPC de torrents y diálogo .torrent
  transcode.ts               sondeo con ffmpeg y conversión a MPEG-TS/AAC
  preload.ts                 API segura expuesta en window.nova
src/
  components/                Sidebar, Topbar, reproductor, tarjetas, modales
  pages/                     Inicio, Directo, Descubrir, Películas, Series, EPG, Torrents…
  lib/                       parsers M3U/XMLTV, Xtream, Stremio, utilidades
  store.tsx                  estado global y persistencia
  styles.css                 sistema visual completo
```

El renderer nunca accede a Node directamente: todo pasa por `window.nova` con `contextIsolation` y `sandbox` activos.

### Cómo funcionan los torrents

1. El proceso principal usa `webtorrent` con DHT y trackers TCP/UDP. La DHT se arranca al abrir la sección para que el primer magnet no espere.
2. Al recibir los metadatos se detecta el vídeo principal y se preparan sus primeros 2 MB con prioridad alta.
3. El servidor HTTP local (`127.0.0.1`) sirve los archivos con soporte de `Range`. Cada petición abierta se entrega en bloques de **2 MB** y la ventana solicitada se marca con prioridad alta dentro de WebTorrent. Así el reproductor recibe primero lo que necesita para el primer fotograma, incluido el átomo `moov` de los MP4 que lo llevan al final.
4. La descarga es secuencial sobre la zona que se está viendo; no se descarga el archivo completo antes de empezar.
5. Si el contenedor o el audio no son compatibles con Chromium (MKV con AC-3/DTS, AVI, etc.), se convierte a MPEG-TS con audio AAC usando el ffmpeg integrado. El vídeo se copia siempre que sea posible.
6. Para saltar en el tiempo en una conversión, se reinicia ffmpeg con `-ss` en el minuto elegido y se reengancha el reproductor; en archivos compatibles el salto es nativo.

### Reproductor

- `hls.js` para HLS y `mpegts.js` para MPEG-TS, con fallback automático.
- Películas y episodios: barra de posición, tiempo transcurrido/total, saltos de ±10 y ±30 segundos y atajos de teclado.
- `←` / `→`: retroceder o avanzar 10 segundos en películas; cambiar de canal en directo.
- `Espacio`: reproducir o pausar. `F`: pantalla completa. `M`: silencio. `C`: siguiente pista de subtítulos.
- Subtítulos incluidos en el vídeo, archivos `.srt`/`.vtt`/`.ass` del torrent y archivos locales.
- Selector de audio cuando el motor expone varias pistas.
- Reproductor externo (VLC o mpv) para formatos que Chromium no decodifica.

### Addons de Stremio

En **Descubrir → Addons** puedes instalar addons de catálogo y metadatos por URL o manifest (`stremio://…`).

- **Cinemeta** está recomendado desde la propia app para navegar por los catálogos de IMDb.
- SquizanTV no incluye, aloja ni promociona addons de fuentes. Cada usuario decide qué addons añadir y es responsable de su uso.
- Un enlace magnet que aporte un addon se reproduce con el motor de torrents interno; una URL directa o HLS se abre en el reproductor.

### Actualizaciones

SquizanTV usa `electron-updater` con proveedor genérico:

1. Compila con `npm run dist`.
2. Sube a tu servidor el instalador, el `.blockmap` y `latest.yml`.
3. Indica la URL base en **Ajustes → Actualizaciones** o cambia `publish.url` en `electron-builder.yml`.
4. La app compara versiones, descarga y ofrece **Instalar y reiniciar**.

Las actualizaciones solo funcionan en la app instalada, no en `npm run dev`.

### Datos y migración

- Base de datos: `%APPDATA%\SquizanTV\squizantv.json` (escritura atómica mediante archivo temporal).
- Al arrancar, si no existe esa base y sí `%APPDATA%\NovaTV\novatv.json`, se copia una vez para conservar listas, favoritos e historial.
- **Ajustes → Datos y privacidad** permite abrir la carpeta o restablecer la app.

### Limitaciones conocidas

- **DRM**: no reproduce Widevine (Netflix, Disney+, etc.).
- **Firma de código**: el instalador no está firmado; SmartScreen mostrará un aviso.
- **Códecs**: dependen de Chromium/Electron. MP4 H.264/AAC y WebM funcionan siempre; H.265/AV1 pueden fallar. En ese caso se ofrece VLC/mpv.
- **Torrents**: necesitan pares accesibles. Si el firewall bloquea UDP, la DHT no encuentra pares; usa enlaces con trackers y permite SquizanTV en redes privadas.
- Al usar BitTorrent tu IP es visible para los demás pares. Para contenido privado, usa una VPN.
- Algunos proveedores limitan conexiones simultáneas o bloquean el User-Agent.

### Legal

SquizanTV no incluye, aloja ni distribuye listas, canales, torrents, addons ni contenido. Solo reproduce las fuentes que el usuario configure o instale. Usa únicamente listas, cuentas, addons y archivos sobre los que tengas derechos.
