import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import {
  exportFitFromZip,
  FitExportError,
  fitAccountOutputDirectory,
  MAX_FIT_BYTES,
  MAX_ZIP_BYTES,
} from '../src/fit-export'

/** Independent bit-at-a-time reference for the CRC-16/ARC used by FIT. */
function referenceFitCrc(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0
        ? (crc >>> 1) ^ 0xA001
        : crc >>> 1
    }
  }
  return crc & 0xFFFF
}

function writeReferenceFileCrc(fit: Buffer): void {
  const crcOffset = fit.length - 2
  fit.writeUInt16LE(referenceFitCrc(fit.subarray(0, crcOffset)), crcOffset)
}

function makeFit(headerSize: 12 | 14 = 14, payload = Buffer.from([1, 2, 3])): Buffer {
  const fit = Buffer.alloc(headerSize + payload.length + 2)
  fit[0] = headerSize
  fit[1] = 0x20
  fit.writeUInt16LE(100, 2)
  fit.writeUInt32LE(payload.length, 4)
  fit.write('.FIT', 8, 'ascii')
  if (headerSize === 14) {
    fit.writeUInt16LE(referenceFitCrc(fit.subarray(0, 12)), 12)
  }
  payload.copy(fit, headerSize)
  writeReferenceFileCrc(fit)
  return fit
}

function makeZip(entries: Record<string, Uint8Array>, level: 0 | 6 = 0): Buffer {
  return Buffer.from(zipSync(entries, { level }))
}

describe('fitAccountOutputDirectory', () => {
  it('never falls back to the process working directory', () => {
    expect(() => fitAccountOutputDirectory('', 'runner@example.com'))
      .toThrow('FIT output directory is not configured')
  })

  it('keeps a normal account email readable under the configured parent', () => {
    expect(fitAccountOutputDirectory('/private/exports', ' Runner@Example.COM '))
      .toBe('/private/exports/GARMIN_FIT_runner@example.com')
  })

  it('encodes path characters and cannot escape the configured parent', () => {
    const parent = resolve('/private/exports')
    const result = fitAccountOutputDirectory(parent, '../family\\runner@example.com')

    expect(dirname(result)).toBe(parent)
    expect(basename(result)).toMatch(/^GARMIN_FIT_/)
    expect(basename(result)).not.toContain('/')
    expect(basename(result)).not.toContain('\\')
  })
})

describe('exportFitFromZip', () => {
  let sandboxDir: string

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'garmin-fit-export-'))
  })

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true })
  })

  it('extracts the unique FIT entry without trusting its ZIP path', async () => {
    const fit = makeFit()
    const outputDir = join(sandboxDir, 'private-downloads')

    const result = await exportFitFromZip({
      zipBuffer: makeZip({ '../../untrusted-name.FIT': fit }),
      activityId: 123456789,
      outputDir,
    })

    expect(result).toEqual({
      fileName: '123456789.fit',
      savedPath: join(outputDir, '123456789.fit'),
      sizeBytes: fit.length,
      sha256: createHash('sha256').update(fit).digest('hex'),
    })
    await expect(readFile(result.savedPath)).resolves.toEqual(fit)
    await expect(lstat(join(sandboxDir, 'untrusted-name.FIT'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    if (process.platform !== 'win32') {
      expect((await lstat(outputDir)).mode & 0o777).toBe(0o700)
      expect((await lstat(result.savedPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('accepts a ZIP file path and the standard 12-byte FIT header', async () => {
    const fit = makeFit(12)
    const zipPath = join(sandboxDir, 'activity.zip')
    await writeFile(zipPath, makeZip({ 'activity.fit': fit }))

    const result = await exportFitFromZip({
      zipPath,
      activityId: 42,
      outputDir: join(sandboxDir, 'downloads'),
    })

    await expect(readFile(result.savedPath)).resolves.toEqual(fit)
  })

  it('accepts the empty 14-byte FIT example published by the Garmin SDK', async () => {
    const fit = Buffer.from([
      0x0E, 0x10, 0xD9, 0x07, 0x00, 0x00, 0x00, 0x00,
      0x2E, 0x46, 0x49, 0x54, 0x91, 0x33, 0x00, 0x00,
    ])

    const result = await exportFitFromZip({
      zipBuffer: makeZip({ 'official-example.fit': fit }),
      activityId: 420,
      outputDir: join(sandboxDir, 'downloads'),
    })

    await expect(readFile(result.savedPath)).resolves.toEqual(fit)
  })

  it('accepts an omitted 14-byte header CRC when the mandatory file CRC is valid', async () => {
    const fit = makeFit(14)
    fit.writeUInt16LE(0, 12)
    writeReferenceFileCrc(fit)

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': fit }),
      activityId: 421,
      outputDir: join(sandboxDir, 'downloads'),
    })).resolves.toMatchObject({ fileName: '421.fit' })
  })

  it('rejects a corrupted non-zero 14-byte header CRC', async () => {
    const fit = makeFit(14)
    fit[12] ^= 0x01
    // Keep the mandatory file CRC valid so this isolates header-CRC checking.
    writeReferenceFileCrc(fit)
    const outputDir = join(sandboxDir, 'downloads')

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': fit }),
      activityId: 422,
      outputDir,
    })).rejects.toMatchObject({ code: 'INVALID_FIT_HEADER_CRC' })
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([12, 14] as const)(
    'rejects a corrupted file CRC with a %i-byte header',
    async (headerSize) => {
      const fit = makeFit(headerSize)
      fit[fit.length - 1] ^= 0x01
      const outputDir = join(sandboxDir, `downloads-${headerSize}`)

      await expect(exportFitFromZip({
        zipBuffer: makeZip({ 'activity.fit': fit }),
        activityId: 423 + headerSize,
        outputDir,
      })).rejects.toMatchObject({ code: 'INVALID_FIT_FILE_CRC' })
      await expect(lstat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('extracts a deflate-compressed FIT entry', async () => {
    const fit = makeFit(14, Buffer.alloc(4096, 0x5a))

    const result = await exportFitFromZip({
      zipBuffer: makeZip({ 'compressed.fit': fit }, 6),
      activityId: 43,
      outputDir: join(sandboxDir, 'downloads'),
    })

    await expect(readFile(result.savedPath)).resolves.toEqual(fit)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid activity ID %p',
    async (activityId) => {
      await expect(exportFitFromZip({
        zipBuffer: makeZip({ 'activity.fit': makeFit() }),
        activityId,
        outputDir: join(sandboxDir, 'downloads'),
      })).rejects.toMatchObject({ code: 'INVALID_ACTIVITY_ID' })
    },
  )

  it('requires exactly one ZIP input source', async () => {
    const zipBuffer = makeZip({ 'activity.fit': makeFit() })
    const outputDir = join(sandboxDir, 'downloads')

    await expect(exportFitFromZip({
      activityId: 1,
      outputDir,
    })).rejects.toMatchObject({ code: 'INVALID_ZIP_SOURCE' })

    await expect(exportFitFromZip({
      zipBuffer,
      zipPath: join(sandboxDir, 'activity.zip'),
      activityId: 1,
      outputDir,
    })).rejects.toMatchObject({ code: 'INVALID_ZIP_SOURCE' })
  })

  it('rejects ZIPs without exactly one FIT entry and leaves no output', async () => {
    const outputDir = join(sandboxDir, 'downloads')

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'readme.txt': Buffer.from('not a FIT') }),
      activityId: 1,
      outputDir,
    })).rejects.toMatchObject({ code: 'FIT_ENTRY_NOT_FOUND' })

    await expect(exportFitFromZip({
      zipBuffer: makeZip({
        'one.fit': makeFit(),
        'nested/two.FIT': makeFit(),
      }),
      activityId: 1,
      outputDir,
    })).rejects.toMatchObject({ code: 'MULTIPLE_FIT_ENTRIES' })

    await expect(lstat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects archives with excessive entry counts before array queues grow unbounded', async () => {
    const entries: Record<string, Uint8Array> = {}
    for (let index = 0; index < 1025; index += 1) {
      entries[`empty-${index}.txt`] = new Uint8Array()
    }

    await expect(exportFitFromZip({
      zipBuffer: makeZip(entries),
      activityId: 3,
      outputDir: join(sandboxDir, 'downloads'),
    })).rejects.toMatchObject({ code: 'TOO_MANY_ZIP_ENTRIES' })
  })

  it.each([
    ['bad signature', (() => {
      const fit = makeFit()
      fit.write('NOPE', 8, 'ascii')
      return fit
    })()],
    ['unsupported header length', (() => {
      const fit = makeFit()
      fit[0] = 13
      return fit
    })()],
    ['truncated header', Buffer.from([14, 0, 0])],
    ['mismatched declared data size', (() => {
      const fit = makeFit()
      fit.writeUInt32LE(999, 4)
      return fit
    })()],
  ])('rejects a FIT with %s', async (_caseName, fit) => {
    const outputDir = join(sandboxDir, 'downloads')

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': fit as Buffer }),
      activityId: 1,
      outputDir,
    })).rejects.toMatchObject({ code: 'INVALID_FIT_HEADER' })
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a ZIP path larger than the compressed-size limit before reading it', async () => {
    const zipPath = join(sandboxDir, 'oversized.zip')
    await writeFile(zipPath, Buffer.alloc(0))
    await truncate(zipPath, MAX_ZIP_BYTES + 1)

    await expect(exportFitFromZip({
      zipPath,
      activityId: 1,
      outputDir: join(sandboxDir, 'downloads'),
    })).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' })
  })

  it('rejects an extracted FIT larger than the decompressed-size limit', async () => {
    const oversizedFit = Buffer.alloc(MAX_FIT_BYTES + 1)
    oversizedFit[0] = 14
    oversizedFit.write('.FIT', 8, 'ascii')

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': oversizedFit }),
      activityId: 1,
      outputDir: join(sandboxDir, 'downloads'),
    })).rejects.toMatchObject({ code: 'FIT_TOO_LARGE' })
  }, 20_000)

  it('enforces the actual streamed size when a ZIP header lies about FIT size', async () => {
    const oversizedFit = Buffer.alloc(MAX_FIT_BYTES + 1)
    oversizedFit[0] = 14
    oversizedFit.write('.FIT', 8, 'ascii')
    const archive = makeZip({ 'activity.fit': oversizedFit }, 6)
    // ZIP local-file header uncompressed-size field. The central directory is
    // intentionally left intact; extraction must not trust either declaration.
    archive.writeUInt32LE(1, 22)

    await expect(exportFitFromZip({
      zipBuffer: archive,
      activityId: 2,
      outputDir: join(sandboxDir, 'downloads'),
    })).rejects.toMatchObject({ code: 'FIT_TOO_LARGE' })
  }, 20_000)

  it('never overwrites an existing file', async () => {
    const outputDir = join(sandboxDir, 'downloads')
    const existingPath = join(outputDir, '7.fit')
    await mkdir(outputDir)
    await writeFile(existingPath, 'keep me')

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': makeFit() }),
      activityId: 7,
      outputDir,
    })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' })
    await expect(readFile(existingPath, 'utf8')).resolves.toBe('keep me')
  })

  it('never follows or overwrites an existing output symlink', async () => {
    if (process.platform === 'win32') return

    const outputDir = join(sandboxDir, 'downloads')
    const targetPath = join(sandboxDir, 'target.fit')
    const outputPath = join(outputDir, '8.fit')
    await mkdir(outputDir)
    await writeFile(targetPath, 'keep target')
    await symlink(targetPath, outputPath)

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': makeFit() }),
      activityId: 8,
      outputDir,
    })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' })
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('keep target')
    expect((await lstat(outputPath)).isSymbolicLink()).toBe(true)
  })

  it('rejects a symlink used as the output directory', async () => {
    if (process.platform === 'win32') return

    const realDir = join(sandboxDir, 'real-downloads')
    const outputDir = join(sandboxDir, 'linked-downloads')
    await mkdir(realDir)
    await symlink(realDir, outputDir)

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': makeFit() }),
      activityId: 9,
      outputDir,
    })).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_DIRECTORY' })
    await expect(lstat(join(realDir, '9.fit'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove an existing directory when the exclusive output open fails', async () => {
    const outputDir = join(sandboxDir, 'downloads')
    const collisionPath = join(outputDir, '10.fit')
    await mkdir(collisionPath, { recursive: true })

    await expect(exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': makeFit() }),
      activityId: 10,
      outputDir,
    })).rejects.toBeInstanceOf(FitExportError)
    expect((await lstat(collisionPath)).isDirectory()).toBe(true)
  })

  it('tightens an existing output directory before writing', async () => {
    if (process.platform === 'win32') return

    const outputDir = join(sandboxDir, 'downloads')
    await mkdir(outputDir, { mode: 0o755 })
    await chmod(outputDir, 0o755)

    await exportFitFromZip({
      zipBuffer: makeZip({ 'activity.fit': makeFit() }),
      activityId: 11,
      outputDir,
    })

    expect((await lstat(outputDir)).mode & 0o777).toBe(0o700)
  })
})
