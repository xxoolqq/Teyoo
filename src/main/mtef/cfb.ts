// Minimal OLE2 / CFB (Compound File Binary) reader — enough to pull streams
// such as "Equation Native" out of MathType OLE objects embedded in Word docs.
// Replaces the Go library's dependency on github.com/extrame/ole2.
//
// Implements the parts of [MS-CFB] that these files actually use:
// v3 headers (512-byte sectors), DIFAT, FAT, directory chain, mini FAT.

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const FATSECT = 0xfffffffd
const DIFSECT = 0xfffffffc

export interface CFBEntry {
  name: string
  type: number // 1=storage 2=stream 5=root
  startSector: number
  size: number
}

export class CFBFile {
  private readonly dv: DataView
  private readonly sectorSize: number
  private readonly miniSectorSize: number
  private readonly cutoff: number
  /** FAT as a flat array of "next sector" entries. */
  private readonly fat: number[] = []
  private readonly miniFat: number[] = []
  private readonly miniStream: Uint8Array
  readonly entries: CFBEntry[] = []

  constructor(buf: Uint8Array) {
    if (buf.length < 512) throw new Error('CFB: buffer too small')
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.dv = dv

    // Signature D0 CF 11 E0 A1 B1 1A E1
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    for (let i = 0; i < 8; i++) {
      if (dv.getUint8(i) !== sig[i]) throw new Error('CFB: bad signature, not an OLE file')
    }

    this.sectorSize = 1 << dv.getUint16(0x1e, true)
    this.miniSectorSize = 1 << dv.getUint16(0x20, true)
    this.cutoff = dv.getUint32(0x38, true) || 4096

    // --- DIFAT -> list of FAT sector ids ---
    const difat: number[] = []
    for (let i = 0; i < 109; i++) difat.push(dv.getUint32(0x4c + i * 4, true))
    let difatSector = dv.getUint32(0x44, true)
    const difatCount = dv.getUint32(0x48, true)
    for (let n = 0; n < difatCount && difatSector !== ENDOFCHAIN; n++) {
      const off = this.sectorOffset(difatSector)
      const perSector = this.sectorSize / 4
      for (let i = 0; i < perSector - 1; i++) {
        const v = dv.getUint32(off + i * 4, true)
        if (v === FREESECT) continue
        difat.push(v)
      }
      difatSector = dv.getUint32(off + (perSector - 1) * 4, true)
    }

    // --- FAT ---
    for (const fs of difat) {
      if (fs >= FATSECT) continue
      const off = this.sectorOffset(fs)
      for (let i = 0; i < this.sectorSize / 4; i++) this.fat.push(dv.getUint32(off + i * 4, true))
    }

    // --- Directory chain -> entries ---
    const dirStart = dv.getUint32(0x30, true)
    const dirBuf = this.readSectorChain(dirStart)
    const dvDir = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength)
    for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
      const nameLen = dvDir.getUint16(off + 64, true)
      let name = ''
      if (nameLen >= 2) {
        for (let i = 0; i < nameLen - 2; i += 2) {
          name += String.fromCharCode(dvDir.getUint16(off + i, true))
        }
      }
      const type = dvDir.getUint8(off + 66)
      this.entries.push({
        name,
        type,
        startSector: dvDir.getUint32(off + 116, true),
        size: dvDir.getUint32(off + 120, true),
      })
    }
    const root = this.entries[0]

    // --- Mini FAT + mini stream (root entry chain) ---
    const miniFatStart = dv.getUint32(0x3c, true)
    if (miniFatStart !== ENDOFCHAIN && root) {
      const mfBuf = this.readSectorChain(miniFatStart)
      const dvMf = new DataView(mfBuf.buffer, mfBuf.byteOffset, mfBuf.byteLength)
      for (let off = 0; off + 4 <= mfBuf.length; off += 4) {
        this.miniFat.push(dvMf.getUint32(off, true))
      }
      this.miniStream = root.startSector !== ENDOFCHAIN ? this.readSectorChain(root.startSector) : new Uint8Array(0)
    } else {
      this.miniStream = new Uint8Array(0)
    }
  }

  private sectorOffset(id: number): number {
    return (id + 1) * this.sectorSize
  }

  /** Concatenate every sector in a FAT chain starting at `start`. */
  private readSectorChain(start: number): Uint8Array {
    if (start === ENDOFCHAIN || start >= this.fat.length) return new Uint8Array(0)
    const parts: Uint8Array[] = []
    let cur = start
    const seen = new Set<number>()
    while (cur !== ENDOFCHAIN && cur < this.fat.length) {
      if (seen.has(cur)) throw new Error('CFB: FAT chain loop at sector ' + cur)
      seen.add(cur)
      parts.push(new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.sectorOffset(cur), this.sectorSize))
      cur = this.fat[cur]
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let pos = 0
    for (const p of parts) {
      out.set(p, pos)
      pos += p.length
    }
    return out
  }

  private readMiniChain(start: number): Uint8Array {
    const parts: Uint8Array[] = []
    let cur = start
    const seen = new Set<number>()
    while (cur !== ENDOFCHAIN && cur < this.miniFat.length) {
      if (seen.has(cur)) break // malformed mini chain: stop instead of looping
      seen.add(cur)
      const off = cur * this.miniSectorSize
      parts.push(this.miniStream.subarray(off, off + this.miniSectorSize))
      cur = this.miniFat[cur]
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let pos = 0
    for (const p of parts) {
      out.set(p, pos)
      pos += p.length
    }
    return out
  }

  /** Directory entries by (exact) name lookup, e.g. "Equation Native". */
  findEntry(name: string): CFBEntry | undefined {
    return this.entries.find((e) => e.name === name)
  }

  /** Full bytes of a stream, or null when no such stream exists. */
  getStream(name: string): Uint8Array | null {
    const entry = this.findEntry(name)
    if (!entry || entry.type !== 2) return null
    const raw = entry.size >= this.cutoff ? this.readSectorChain(entry.startSector) : this.readMiniChain(entry.startSector)
    return raw.subarray(0, entry.size)
  }
}
