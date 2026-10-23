// Bounded synthetic EXIF fixture and structural byte inspection, no photo assets.
import assert from 'node:assert/strict'

export function jpegSegments(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'JPEG SOI')
  const segments = []
  let offset = 2
  while (offset < bytes.length) {
    assert.equal(bytes[offset++], 0xff, 'JPEG marker prefix')
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) break
    const length = bytes.readUInt16BE(offset)
    assert.ok(length >= 2 && offset + length <= bytes.length, 'bounded JPEG segment')
    segments.push({ marker, data: bytes.subarray(offset + 2, offset + length) })
    if (marker === 0xda) break // metadata precedes entropy-coded image scan
    offset += length
  }
  return segments
}

export function gpsPhoto(jpeg) {
  jpegSegments(jpeg)
  // TIFF little endian: IFD0 GPSInfo pointer -> GPS IFD with N/E references and
  // three RATIONALs each. Synthetic coordinates: 12°34′56″ N, 65°43′21″ E.
  const tiff = Buffer.alloc(128)
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2)
    tiff.writeUInt32LE(count, at + 4); tiff.writeUInt32LE(value, at + 8)
  }
  entry(10, 0x8825, 4, 1, 26)
  tiff.writeUInt16LE(4, 26)
  entry(28, 1, 2, 2, 78); entry(40, 2, 5, 3, 80)
  entry(52, 3, 2, 2, 69); entry(64, 4, 5, 3, 104)
  for (const [i, value] of [12, 34, 56, 65, 43, 21].entries()) {
    tiff.writeUInt32LE(value, 80 + i * 8); tiff.writeUInt32LE(1, 84 + i * 8)
  }
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
  const header = Buffer.from([0xff, 0xe1, 0, 0]); header.writeUInt16BE(exif.length + 2, 2)
  const photo = Buffer.concat([jpeg.subarray(0, 2), header, exif, jpeg.subarray(2)])
  assert.ok(photo.length < 16384, 'tiny generated fixture')
  const app1 = jpegSegments(photo).filter(s => s.marker === 0xe1)
  assert.equal(app1.length, 1)
  const decoded = app1[0].data.subarray(6)
  assert.equal(app1[0].data.subarray(0, 6).toString(), 'Exif\0\0')
  assert.equal(decoded.readUInt16LE(10), 0x8825, 'real GPSInfo tag, not a text-only sentinel')
  const gps = decoded.readUInt32LE(18)
  assert.equal(decoded.readUInt16LE(gps), 4)
  assert.equal(decoded.readUInt16LE(gps + 14), 2, 'GPSLatitude')
  assert.equal(decoded.readUInt16LE(gps + 38), 4, 'GPSLongitude')
  for (const [at, values] of [[gps + 14, [12, 34, 56]], [gps + 38, [65, 43, 21]]]) {
    const data = decoded.readUInt32LE(at + 8)
    assert.deepEqual(values.map((_, i) => decoded.readUInt32LE(data + i * 8) / decoded.readUInt32LE(data + i * 8 + 4)), values)
  }
  return { photo, exif, tiff }
}

export function assertMetadataAbsent(bytes, mime, fixture) {
  assert.equal(bytes.includes(fixture.exif), false, 'source EXIF absent')
  assert.equal(bytes.includes(fixture.tiff), false, 'source GPS TIFF absent')
  assert.equal(bytes.includes(Buffer.from('Exif\0\0')), false, 'no EXIF signature')
  if (mime === 'image/jpeg') {
    assert.equal(jpegSegments(bytes).some(s => s.marker === 0xe1), false, 'no JPEG APP1')
  } else {
    assert.equal(mime, 'image/png', 'only PNG/JPEG are supported by Studio')
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const chunks = []
    let offset = 8
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset)
      assert.ok(offset + length + 12 <= bytes.length, 'bounded PNG chunk')
      chunks.push(bytes.toString('ascii', offset + 4, offset + 8))
      offset += length + 12
    }
    assert.equal(offset, bytes.length)
    assert.equal(chunks.at(-1), 'IEND')
    for (const type of ['eXIf', 'tEXt', 'iTXt', 'zTXt']) assert.equal(chunks.includes(type), false, `no ${type} metadata`)
  }
}
