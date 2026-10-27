/* Prueba E2E local: siembra un torrent propio y verifica streaming por rangos. */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { randomBytes } = require('node:crypto')
const WebTorrent = require('webtorrent')
const createTorrent = require('create-torrent')
const { Server: TrackerServer } = require('bittorrent-tracker')
const { TorrentService } = require('./.torrent-service.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-torrent-test-'))
const seedDir = path.join(root, 'seed')
const contentDir = path.join(seedDir, 'SquizanTest')
const leechDir = path.join(root, 'leech')
fs.mkdirSync(contentDir, { recursive: true })
fs.mkdirSync(leechDir, { recursive: true })

const size = 20 * 1024 * 1024
const payload = randomBytes(size)
const filePath = path.join(contentDir, 'sample.mp4')
fs.writeFileSync(filePath, payload)

const posterPayload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
fs.writeFileSync(path.join(contentDir, 'poster.jpg'), posterPayload)

const nfoText =
  '<?xml version="1.0" encoding="windows-1252"?>\n' +
  '<movie><title>Prueba NovaTV</title><year>2026</year><genre>Acción</genre>' +
  '<rating>8.1</rating><runtime>118</runtime>' +
  '<plot>Sinopsis de prueba con acción y ñ.</plot></movie>'
fs.writeFileSync(path.join(contentDir, 'movie.nfo'), Buffer.from(nfoText, 'latin1'))

const announcePort = 0
const tracker = new TrackerServer({ http: true, udp: false, ws: false, stats: false })
let seeder
let service
let failures = 0

function check(label, condition, extra) {
  if (condition) console.log('OK  ', label, extra ?? '')
  else {
    failures++
    console.log('FAIL', label, extra ?? '')
  }
}

async function main() {
  await new Promise((resolve, reject) => {
    tracker.once('error', reject)
    tracker.listen(announcePort, '127.0.0.1', resolve)
  })
  const port = tracker.http.address().port
  const announce = `http://127.0.0.1:${port}/announce`
  console.log('tracker en', announce)

  const torrentBuffer = await new Promise((resolve, reject) =>
    createTorrent(contentDir, { name: 'SquizanTest', announce: [announce], pieceLength: 32768 }, (err, buf) =>
      err ? reject(err) : resolve(buf),
    ),
  )

  seeder = new WebTorrent({ dht: false, tracker: true, utp: false, torrentPort: 43001 })
  const seeded = seeder.add(torrentBuffer, { path: seedDir })
  await new Promise((resolve, reject) => {
    seeded.once('ready', resolve)
    seeded.once('error', reject)
    setTimeout(() => reject(new Error('seeder timeout')), 20000)
  })
  console.log('seeder listo:', seeded.name, seeded.magnetURI.slice(0, 70) + '…')

  service = new TorrentService(leechDir, () => new WebTorrent({ dht: false, tracker: true, utp: false, torrentPort: 43002 }))

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servicio sin metadatos en 30 s')), 30000)
    service.on('update', (snap) => {
      if (snap.error) {
        clearTimeout(timer)
        reject(new Error(snap.error))
      }
      if (snap.ready && snap.files.length > 0) {
        clearTimeout(timer)
        resolve(snap)
      }
    })
  })

  const result = await service.add(seeded.magnetURI)
  check('add devuelve ok', result.ok === true, JSON.stringify(result))
  if (!result.ok) throw new Error(result.message)

  const duplicate = await service.add(seeded.magnetURI)
  check('magnet duplicado devuelve la misma sesión', duplicate.ok === true && duplicate.duplicate === true && duplicate.id === result.id, JSON.stringify(duplicate))
  check('no se duplica la lista', service.list().length === 1, String(service.list().length))

  const torrentFile = path.join(root, 'sample.torrent')
  fs.writeFileSync(torrentFile, torrentBuffer)
  const duplicateFile = await service.add(torrentFile)
  check(
    'archivo .torrent duplicado detectado',
    duplicateFile.ok === true && duplicateFile.duplicate === true && duplicateFile.id === result.id,
    JSON.stringify(duplicateFile),
  )

  const snapshot = await ready
  const video = snapshot.files.find((file) => /\.mp4$/i.test(file.name))
  const posterFile = snapshot.files.find((file) => /\.jpg$/i.test(file.name))
  const nfoFile = snapshot.files.find((file) => /\.nfo$/i.test(file.name))
  const videoUrl = snapshot.streamBase + (video ? video.index : 0)

  check('metadatos recibidos', snapshot.files.length === 3, snapshot.files.map((file) => file.name).join(', '))
  check('archivo detectado como vídeo', Boolean(video) && video.kind === 'video', video && video.name)
  check('tamaño correcto', Boolean(video) && video.length === size, video && String(video.length))
  check('póster detectado como imagen', Boolean(posterFile) && posterFile.kind === 'image', posterFile && posterFile.name)
  check('nfo detectado', Boolean(nfoFile) && nfoFile.kind === 'nfo', nfoFile && nfoFile.name)
  check('streamBase disponible', snapshot.streamBase.startsWith('http://127.0.0.1:'), snapshot.streamBase)
  if (!video || !posterFile || !nfoFile) throw new Error('faltan archivos en el torrent')

  const nfo = await service.readText(snapshot.id, nfoFile.index)
  check('sinopsis leída del .nfo', nfo.includes('Sinopsis de prueba con acción y ñ'), nfo.replace(/\s+/g, ' ').slice(0, 70))
  check('título leído del .nfo', nfo.includes('Prueba NovaTV'))

  const posterRes = await fetch(snapshot.streamBase + posterFile.index)
  const posterBuf = Buffer.from(await posterRes.arrayBuffer())
  check('póster servido por HTTP', posterRes.status === 200 && posterBuf.equals(posterPayload), `${posterBuf.length} bytes`)

  // Rango inicial
  const full = Buffer.from(payload)
  const first = await fetch(videoUrl, { headers: { Range: 'bytes=0-65535' } })
  const firstBuf = Buffer.from(await first.arrayBuffer())
  check('206 Partial Content', first.status === 206, String(first.status))
  check('Content-Range correcto', first.headers.get('content-range') === `bytes 0-65535/${size}`, first.headers.get('content-range'))
  check('bytes iniciales idénticos', firstBuf.equals(full.subarray(0, 65536)), `${firstBuf.length} bytes`)

  // Rango abierto: debe entregar un flujo continuo (antes se cortaba a los 2 MB)
  const open = await fetch(videoUrl, { headers: { Range: 'bytes=0-' } })
  const openBuf = Buffer.from(await open.arrayBuffer())
  check('rango abierto responde 206', open.status === 206, String(open.status))
  check(
    'rango abierto llega hasta el final',
    open.headers.get('content-range') === `bytes 0-${size - 1}/${size}`,
    open.headers.get('content-range'),
  )
  check('flujo continuo sin corte a los 2 MB', openBuf.length === size && openBuf.equals(full), `${openBuf.length} bytes`)

  // Rango sufijo (atomo moov al final de un MP4)
  const tail = await fetch(videoUrl, { headers: { Range: 'bytes=-1024' } })
  const tailBuf = Buffer.from(await tail.arrayBuffer())
  check('rango sufijo responde 206', tail.status === 206, String(tail.status))
  check(
    'Content-Range del sufijo',
    tail.headers.get('content-range') === `bytes ${size - 1024}-${size - 1}/${size}`,
    tail.headers.get('content-range'),
  )
  check('últimos bytes idénticos', tailBuf.equals(full.subarray(size - 1024)), `${tailBuf.length} bytes`)

  // Rango intermedio (simula un salto en el tiempo)
  const midStart = 10_000_000
  const midEnd = 10_010_000
  const mid = await fetch(videoUrl, { headers: { Range: `bytes=${midStart}-${midEnd}` } })
  const midBuf = Buffer.from(await mid.arrayBuffer())
  check('rango intermedio 206', mid.status === 206, String(mid.status))
  check('bytes intermedios idénticos', midBuf.equals(full.subarray(midStart, midEnd + 1)), `${midBuf.length} bytes`)

  // HEAD
  const head = await fetch(videoUrl, { method: 'HEAD' })
  check('HEAD responde 200', head.status === 200, String(head.status))
  check('Accept-Ranges presente', head.headers.get('accept-ranges') === 'bytes', head.headers.get('accept-ranges'))

  // Rango fuera de límites
  const bad = await fetch(videoUrl, { headers: { Range: `bytes=${size + 10}-${size + 20}` } })
  check('rango inválido responde 416', bad.status === 416, String(bad.status))

  // Token incorrecto
  const wrong = await fetch(snapshot.streamBase.replace(/\/s\/[a-f0-9]+/, '/s/deadbeef') + video.index)
  check('token incorrecto responde 404', wrong.status === 404, String(wrong.status))

  // Progreso tras la descarga
  await new Promise((r) => setTimeout(r, 1200))
  const latest = service.list().find((item) => item.id === snapshot.id)
  check('progreso avanza', latest && latest.progress > 0, `${latest && latest.progress}%`)
  check('lista contiene el torrent', service.list().length === 1)

  check('remove funciona', service.remove(snapshot.id) === true)
  check('lista vacía tras remove', service.list().length === 0)
}

main()
  .catch((error) => {
    failures++
    console.error('ERROR:', error.message)
  })
  .finally(async () => {
    try {
      service && service.dispose()
      seeder && seeder.destroy()
      tracker.close()
    } catch {
      /* noop */
    }
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(path.join(__dirname, '.torrent-service.cjs'), { force: true })
    console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`)
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500)
  })
