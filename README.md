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
SquizanTV-Setup-0.5.5.exe
```

También puedes usar la versión portable `SquizanTV-Portable-0.5.5.exe` si no quieres instalar nada.

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
3. Espera a que se lean los canales. El EPG se descarga solo si la lista lo incluye: se lee de su encabezado `#EXTM3U url-tvg="…"`, sin escribir ninguna URL a mano.
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
- Caché de guías EPG: `%APPDATA%\SquizanTV\http-cache`
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

- `SquizanTV-Setup-0.5.5.exe`: instalador NSIS.
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
3. El servidor HTTP local (`127.0.0.1`) sirve los archivos con soporte de `Range`. Las peticiones abiertas (`bytes=N-`) se entregan como un flujo continuo por ventanas de 2 MB: se mantienen unas pocas ventanas seleccionadas por delante y se sigue escribiendo en la misma conexión. Antes la respuesta terminaba en el primer bloque y ffmpeg veía un EOF, lo que cortaba la reproducción a los pocos segundos. Así el reproductor recibe primero lo que necesita para el primer fotograma, incluido el átomo `moov` de los MP4 que lo llevan al final, sin cortes.
4. La descarga es secuencial sobre la zona que se está viendo; no se descarga el archivo completo antes de empezar.
5. Antes de reproducir se sondea el archivo con ffmpeg (contenedor, códec de vídeo y formato de píxeles). Si Chromium puede abrirlo tal cual, se reproduce directamente.
6. Si el audio no es compatible (AC-3/E-AC-3/DTS/TrueHD) se convierte a AAC y el vídeo se **copia** sin recodificar, salvo que no sea H.264 de 8 bits.
7. HEVC/H.265, H.264 de 10 bits (Hi10P), AV1, VP9 y códecs antiguos se **recodifican a H.264 de 8 bits con AAC**, limitados a 1080p para no saturar la CPU. Así los MKV habituales se abren aunque el equipo no decodifique H.265.
8. Si el motor falla con un archivo concreto, el reproductor reintenta automáticamente con una conversión completa antes de mostrar un error.
9. Para saltar en el tiempo en una conversión, se reinicia ffmpeg con `-ss` en el minuto elegido y se reengancha el reproductor; en archivos compatibles el salto es nativo.
10. La conversión no usa `-re`: produce datos tan rápido como el reproductor los consume. mpegts.js mantiene unos 60 s de búfer por delante, así que el primer fotograma llega en menos de un segundo sin descargar la película entera de golpe.
11. Cuando mpegts.js llena su búfer corta la conexión y la reabre después con `Range: bytes=N-`. El servidor de conversión mantiene viva la sesión 90 s y conserva los últimos 24 MB del flujo, de modo que responde con el byte exacto que pide el reproductor y la película continúa sin errores ni avisos. Si aun así se corta, el reproductor levanta otra conversión en el segundo actual de forma silenciosa.

### Guía de programación (EPG)

SquizanTV lee la guía directamente de la lista, igual que hace IPTVnator, sin pedirte que pegues ninguna URL:

1. Al añadir una lista, se leen los atributos `url-tvg`, `x-tvg-url`, `tvg-url` o `x-tvg` del encabezado `#EXTM3U`. La URL detectada aparece ya rellenada en el formulario y se guarda con la lista.
2. Si el encabezado declara varias guías separadas por comas, se descargan todas en paralelo y se unen en una sola parrilla. Si dos rutas apuntan al mismo archivo (por ejemplo con y sin `refs/heads/`), se descarga una sola vez.
3. Los programas repetidos entre fuentes (mismo canal y misma hora) se descartan, y cada canal conserva todas las horas disponibles al fusionar.
4. El emparejamiento se hace primero por `tvg-id` y, si no coincide, por nombre de canal normalizado: se ignoran acentos, prefijos de país, marcas de calidad (`HD`, `1080p`, `[HD]`…) y sufijos como `TVE`.
5. El campo `refresh` del encabezado indica cada cuánto cambia la guía (normalmente 3600 s). La app la actualiza sola con ese intervalo mientras está abierta; el mínimo es de 15 minutos.
6. Las guías grandes se guardan en `%APPDATA%\SquizanTV\http-cache` y se reutilizan durante ese intervalo, de modo que abrir la app no vuelve a descargar 35 MB. **Actualizar** en la página del EPG fuerza una descarga nueva.
7. Si una de las fuentes falla, se usa el resto y se avisa cuál no respondió; si todas fallan, se mantiene la última guía cargada en memoria.

Las listas antiguas que guardaban todo el encabezado (`a.xml,b.xml`) como una sola URL se corrigen automáticamente al arrancar la app.

### Reproductor

- `hls.js` para HLS y `mpegts.js` para MPEG-TS, con fallback automático.
- MKV y MP4 se abren de forma nativa cuando el códec lo permite; si no, SquizanTV convierte en caliente con el ffmpeg integrado (vídeo a H.264 de 8 bits y audio a AAC) y lo sirve como MPEG-TS local.
- La barra inferior aparece al mover el ratón o pulsar cualquier tecla, y se queda visible mientras el vídeo está pausado; con el vídeo en marcha se oculta a los 3 segundos.
- Botones etiquetados **−1 min**, **−30 s**, **−10 s**, **+10 s**, **+30 s** y **+1 min**, con barra de progreso arrastrable y el tiempo exacto a la derecha.
- Clic en el vídeo o `Espacio` para pausar y reanudar. Con el vídeo pausado aparece un botón grande de reproducir en el centro.
- Botón **?** arriba a la derecha con la lista de botones, atajos y trucos del reproductor.
- Películas y episodios: barra de posición, tiempo transcurrido/total, saltos de ±10, ±30 y ±60 segundos.
- `←` / `→`: retroceder o avanzar 10 segundos en películas; cambiar de canal en directo.
- `Espacio`: reproducir o pausar. `F`: pantalla completa. `M`: silencio. `C`: siguiente pista de subtítulos.
- Mientras se convierte el vídeo o hay un búfer corto no se tapa la película con el cartel de «Conectando…»: solo se muestra al inicio y al saltar en el tiempo.
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
- **Códecs**: el reproductor interno abre MP4, MKV y WebM. H.264/AAC reproduce directo; AC-3/DTS, HEVC, Hi10P, AV1 y VP9 se convierten automáticamente a H.264/AAC. La conversión usa la CPU (no hay aceleración por GPU), así que un 4K puede tardar más en arrancar. VLC/mpv siguen disponibles como alternativa.
- **Torrents**: necesitan pares accesibles. Si el firewall bloquea UDP, la DHT no encuentra pares; usa enlaces con trackers y permite SquizanTV en redes privadas.
- Al usar BitTorrent tu IP es visible para los demás pares. Para contenido privado, usa una VPN.
- Algunos proveedores limitan conexiones simultáneas o bloquean el User-Agent.

### Legal

SquizanTV no incluye, aloja ni distribuye listas, canales, torrents, addons ni contenido. Solo reproduce las fuentes que el usuario configure o instale. Usa únicamente listas, cuentas, addons y archivos sobre los que tengas derechos.
