/* Comprobacion real: Ubuntu por BitTorrent -> servidor local -> bytes identicos al espejo HTTP. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TorrentService } = require('./.torrent-service.cjs')

const TORRENT_URL = 'https://releases.ubuntu.com/26.10/ubuntu-26.10-desktop-amd64.iso.torrent'
const ISO_URL = 'https://releases.ubuntu.com/26.10/ubuntu-26.10-desktop-amd64.iso'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-'))
const torrentPath = path.join(dir, 'ubuntu.torrent')
const downloadDir = path.join(dir, 'data')
let service = null
let failures = 0

function check(label, condition, extra) {
  if (condition) console.log('OK  ', label, extra ?? '')
  else {
    failures++
    console.log('FAIL', label, extra ?? '')
  }
}

async function main() {
  const res = await fetch(TORRENT_URL, { signal: AbortSignal.timeout(30000) })
  check('descarga del .torrent', res.ok, String(res.status))
  fs.writeFileSync(torrentPath, Buffer.from(await res.arrayBuffer()))

  service = new TorrentService(downloadDir)
  const started = Date.now()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sin metadatos/listo en 60 s')), 60000)
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

  const added = await service.add(torrentPath)
  check('add inmediato sin esperar al DHT', added.ok === true, JSON.stringify(added))
  if (!added.ok) throw new Error(added.message)

  const snapshot = await ready
  console.log('listo en', ((Date.now() - started) / 1000).toFixed(1), 's | pares:', snapshot.peers)
  check('archivo grande detectado', snapshot.files[0].length > 1e9, `${snapshot.files[0].name} (${(snapshot.files[0].length / 1073741824).toFixed(1)} GB)`)

  const served = await fetch(snapshot.streamBase + '0', { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(90000) })
  const servedBuf = Buffer.from(await served.arrayBuffer())
  check('206 desde el torrent', served.status === 206, String(served.status))
  check('64 KB servidos', servedBuf.length === 65536, String(servedBuf.length))

  const mirror = await fetch(ISO_URL, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(60000) })
  const mirrorBuf = Buffer.from(await mirror.arrayBuffer())
  check('rango del espejo', mirror.status === 206, String(mirror.status))
  check('bytes identicos al ISO oficial', servedBuf.equals(mirrorBuf), `${servedBuf.length} bytes`)

  const after = await fetch(snapshot.streamBase + '0', { headers: { Range: 'bytes=6000000000-6000065535' }, signal: AbortSignal.timeout(90000) })
  const afterBuf = Buffer.from(await after.arrayBuffer())
  check('seek a 6 GB responde 206', after.status === 206, String(after.status))
  check('seek devuelve 64 KB', afterBuf.length === 65536, String(afterBuf.length))
}

main()
  .catch((error) => {
    failures++
    console.error('ERROR:', error.message)
  })
  .finally(async () => {
    try {
      service && service.dispose()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(path.join(__dirname, '.torrent-service.cjs'), { force: true })
    console.log(failures === 0 ? '\nREAL OK' : `\n${failures} FALLOS`)
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500)
  })
