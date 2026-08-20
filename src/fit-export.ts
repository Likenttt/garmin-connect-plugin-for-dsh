import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { PublicToolError } from './utils/errors'

export const MAX_ZIP_BYTES = 50 * 1024 * 1024
export const MAX_FIT_BYTES = 25 * 1024 * 1024
const ZIP_STREAM_CHUNK_BYTES = 1024
const MAX_ZIP_ENTRIES = 1024
const FIT_CRC_TABLE = [
  0x0000, 0xCC01, 0xD801, 0x1400,
  0xF001, 0x3C00, 0x2800, 0xE401,
  0xA001, 0x6C00, 0x7800, 0xB401,
  0x5000, 0x9C01, 0x8801, 0x4400,
] as const

export type FitExportErrorCode =
  | 'INVALID_ACTIVITY_ID'
  | 'INVALID_ACCOUNT_IDENTIFIER'
  | 'INVALID_ZIP_SOURCE'
  | 'ZIP_TOO_LARGE'
  | 'INVALID_ZIP'
  | 'TOO_MANY_ZIP_ENTRIES'
  | 'FIT_ENTRY_NOT_FOUND'
  | 'MULTIPLE_FIT_ENTRIES'
  | 'FIT_TOO_LARGE'
  | 'INVALID_FIT_HEADER'
  | 'INVALID_FIT_HEADER_CRC'
  | 'INVALID_FIT_FILE_CRC'
  | 'INVALID_OUTPUT_DIRECTORY'
  | 'UNSAFE_OUTPUT_DIRECTORY'
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_WRITE_FAILED'

/** A bounded, path-free error that is safe for the caller to translate. */
export class FitExportError extends PublicToolError {
  override readonly name = 'FitExportError'

  constructor(
    readonly code: FitExportErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ExportFitFromZipOptions {
  activityId: number
  outputDir: string
  /** Exactly one of zipPath and zipBuffer must be supplied. */
  zipPath?: string
  /** Exactly one of zipPath and zipBuffer must be supplied. */
  zipBuffer?: Uint8Array
}

export interface FitExportMetadata {
  fileName: string
  savedPath: string
  sizeBytes: number
  sha256: string
}

/**
 * Build the deterministic per-account directory selected by the user-facing
 * GARMIN_FIT_DOWNLOAD_DIR parent. Normal email addresses remain readable;
 * path/control characters are encoded and disambiguated with a short hash.
 */
export function fitAccountOutputDirectory(
  parentDirectory: string,
  username: string,
): string {
  if (!parentDirectory.trim()) {
    throw new FitExportError(
      'INVALID_OUTPUT_DIRECTORY',
      'The FIT output directory is not configured.',
    )
  }
  const account = username.trim().normalize('NFKC').toLowerCase()
  if (!account) {
    throw new FitExportError(
      'INVALID_ACCOUNT_IDENTIFIER',
      'The Garmin account identifier is invalid.',
    )
  }

  let encoded = ''
  let changed = false
  for (const character of account) {
    if (/^[a-z0-9@._+-]$/.test(character)) {
      encoded += character
    } else {
      changed = true
      encoded += `_u${character.codePointAt(0)!.toString(16)}_`
    }
  }

  if (encoded.length > 160) {
    encoded = encoded.slice(0, 140)
    changed = true
  }
  if (changed) {
    encoded += `_${createHash('sha256').update(account).digest('hex').slice(0, 12)}`
  }

  return resolve(parentDirectory, `GARMIN_FIT_${encoded}`)
}

function isNodeErrorWithCode(error: unknown, codes: ReadonlyArray<string>): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code)
}

async function readZipFile(zipPath: string): Promise<Uint8Array> {
  if (zipPath.trim().length === 0) {
    throw new FitExportError('INVALID_ZIP_SOURCE', 'The ZIP file path is invalid.')
  }

  let file: FileHandle | undefined
  try {
    // O_NOFOLLOW keeps a caller-controlled final path component from resolving
    // through a symlink. The archive is still treated as untrusted afterwards.
    file = await open(zipPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await file.stat()
    if (!info.isFile()) {
      throw new FitExportError('INVALID_ZIP_SOURCE', 'The ZIP source must be a regular file.')
    }
    if (info.size > MAX_ZIP_BYTES) {
      throw new FitExportError('ZIP_TOO_LARGE', 'The ZIP archive exceeds the 50 MiB limit.')
    }

    const data = await file.readFile()
    if (data.byteLength > MAX_ZIP_BYTES) {
      throw new FitExportError('ZIP_TOO_LARGE', 'The ZIP archive exceeds the 50 MiB limit.')
    }
    return data
  } catch (error) {
    if (error instanceof FitExportError) throw error
    throw new FitExportError('INVALID_ZIP_SOURCE', 'The ZIP source could not be read safely.')
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function loadZip(options: ExportFitFromZipOptions): Promise<Uint8Array> {
  const hasPath = options.zipPath !== undefined
  const hasBuffer = options.zipBuffer !== undefined
  if (hasPath === hasBuffer) {
    throw new FitExportError(
      'INVALID_ZIP_SOURCE',
      'Provide exactly one ZIP source: zipPath or zipBuffer.',
    )
  }

  if (hasPath) {
    if (typeof options.zipPath !== 'string') {
      throw new FitExportError('INVALID_ZIP_SOURCE', 'The ZIP file path is invalid.')
    }
    return readZipFile(options.zipPath)
  }

  if (!(options.zipBuffer instanceof Uint8Array)) {
    throw new FitExportError('INVALID_ZIP_SOURCE', 'The ZIP buffer is invalid.')
  }
  if (options.zipBuffer.byteLength > MAX_ZIP_BYTES) {
    throw new FitExportError('ZIP_TOO_LARGE', 'The ZIP archive exceeds the 50 MiB limit.')
  }

  // Copy the caller-owned bytes so they cannot change while this async export
  // validates and writes the extracted file.
  return Uint8Array.from(options.zipBuffer)
}

function isFitEntryName(name: string): boolean {
  if (name.endsWith('/') || name.endsWith('\\')) return false
  const leafName = basename(name.replace(/\\/g, '/'))
  return leafName.length > 4 && leafName.toLowerCase().endsWith('.fit')
}

function extractUniqueFit(zipData: Uint8Array): Buffer {
  let totalEntryCount = 0
  let entryCount = 0
  let extractedSize = 0
  let extractionFinished = false
  let abortError: FitExportError | undefined
  const chunks: Buffer[] = []

  const unzipper = new Unzip((file) => {
    totalEntryCount += 1
    if (totalEntryCount > MAX_ZIP_ENTRIES) {
      abortError = new FitExportError(
        'TOO_MANY_ZIP_ENTRIES',
        'The ZIP archive contains too many entries.',
      )
      return
    }
    if (abortError || !isFitEntryName(file.name)) return

    entryCount += 1
    if (entryCount > 1) {
      abortError = new FitExportError(
        'MULTIPLE_FIT_ENTRIES',
        'The ZIP archive contains more than one FIT file.',
      )
      return
    }
    if (file.originalSize !== undefined && file.originalSize > MAX_FIT_BYTES) {
      abortError = new FitExportError(
        'FIT_TOO_LARGE',
        'The extracted FIT file exceeds the 25 MiB limit.',
      )
      return
    }

    file.ondata = (error, data, final) => {
      if (abortError) return
      if (error) {
        abortError = new FitExportError(
          'INVALID_ZIP',
          'The FIT entry could not be decompressed.',
        )
        return
      }

      if (data.byteLength > MAX_FIT_BYTES - extractedSize) {
        abortError = new FitExportError(
          'FIT_TOO_LARGE',
          'The extracted FIT file exceeds the 25 MiB limit.',
        )
        file.terminate()
        return
      }
      extractedSize += data.byteLength
      if (data.byteLength > 0) chunks.push(Buffer.from(data))
      if (final) extractionFinished = true
    }
    file.start()
  })
  unzipper.register(UnzipInflate)

  try {
    // fflate's streaming inflater can allocate according to each compressed
    // input chunk before invoking ondata. Feeding the entire archive at once
    // therefore lets a forged originalSize field cause a large transient
    // allocation before our byte counter runs. Small chunks keep that spike
    // bounded, while abortError stops all subsequent compressed input as soon
    // as the actual decompressed byte count exceeds MAX_FIT_BYTES.
    for (let offset = 0; offset < zipData.byteLength && !abortError; offset += ZIP_STREAM_CHUNK_BYTES) {
      const end = Math.min(offset + ZIP_STREAM_CHUNK_BYTES, zipData.byteLength)
      unzipper.push(zipData.subarray(offset, end), end === zipData.byteLength)
    }
  } catch (error) {
    if (error instanceof FitExportError) throw error
    throw new FitExportError('INVALID_ZIP', 'The ZIP archive is invalid or unsupported.')
  }

  if (abortError) throw abortError

  if (entryCount === 0) {
    throw new FitExportError('FIT_ENTRY_NOT_FOUND', 'The ZIP archive does not contain a FIT file.')
  }
  if (!extractionFinished) {
    throw new FitExportError('INVALID_ZIP', 'The FIT entry is incomplete.')
  }

  return Buffer.concat(chunks, extractedSize)
}

/** Garmin FIT CRC-16 implementation from the protocol's 16-entry lookup table. */
function calculateFitCrc(
  data: Uint8Array,
  start: number,
  end: number,
): number {
  let crc = 0
  for (let index = start; index < end; index += 1) {
    const byte = data[index]

    let lookup = FIT_CRC_TABLE[crc & 0x0F]
    crc = ((crc >>> 4) & 0x0FFF) ^ lookup ^ FIT_CRC_TABLE[byte & 0x0F]

    lookup = FIT_CRC_TABLE[crc & 0x0F]
    crc = ((crc >>> 4) & 0x0FFF) ^ lookup ^ FIT_CRC_TABLE[(byte >>> 4) & 0x0F]
  }
  return crc & 0xFFFF
}

function readUint16LittleEndian(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}

function validateFitIntegrity(fitData: Uint8Array): void {
  if (fitData.byteLength < 12) {
    throw new FitExportError('INVALID_FIT_HEADER', 'The extracted file has an invalid FIT header.')
  }

  const headerSize = fitData[0]
  const isStandardHeader = headerSize === 12 || headerSize === 14
  const hasCompleteHeader = fitData.byteLength >= headerSize
  const hasFitSignature = fitData[8] === 0x2e
    && fitData[9] === 0x46
    && fitData[10] === 0x49
    && fitData[11] === 0x54
  const dataSize = fitData[4]
    | (fitData[5] << 8)
    | (fitData[6] << 16)
    | (fitData[7] << 24 >>> 0)
  const hasExactDeclaredLength = headerSize + (dataSize >>> 0) + 2 === fitData.byteLength

  if (
    !isStandardHeader
    || !hasCompleteHeader
    || !hasFitSignature
    || !hasExactDeclaredLength
  ) {
    throw new FitExportError('INVALID_FIT_HEADER', 'The extracted file has an invalid FIT header.')
  }

  if (headerSize === 14) {
    const storedHeaderCrc = readUint16LittleEndian(fitData, 12)
    const calculatedHeaderCrc = calculateFitCrc(fitData, 0, 12)
    // The FIT protocol permits a 14-byte header to omit its optional CRC by
    // storing 0x0000. The mandatory file CRC still covers the entire header.
    if (storedHeaderCrc !== 0 && storedHeaderCrc !== calculatedHeaderCrc) {
      throw new FitExportError(
        'INVALID_FIT_HEADER_CRC',
        'The extracted file has an invalid FIT header CRC.',
      )
    }
  }

  const fileCrcOffset = fitData.byteLength - 2
  const storedFileCrc = readUint16LittleEndian(fitData, fileCrcOffset)
  const calculatedFileCrc = calculateFitCrc(fitData, 0, fileCrcOffset)
  if (storedFileCrc !== calculatedFileCrc) {
    throw new FitExportError(
      'INVALID_FIT_FILE_CRC',
      'The extracted file has an invalid FIT file CRC.',
    )
  }
}

async function preparePrivateDirectory(outputDir: string): Promise<string> {
  if (typeof outputDir !== 'string' || outputDir.trim().length === 0) {
    throw new FitExportError('INVALID_OUTPUT_DIRECTORY', 'The FIT output directory is invalid.')
  }

  const absoluteDir = resolve(outputDir)
  try {
    let info
    try {
      info = await lstat(absoluteDir)
    } catch (error) {
      if (!isNodeErrorWithCode(error, ['ENOENT'])) throw error
      await mkdir(absoluteDir, { recursive: true, mode: 0o700 })
      info = await lstat(absoluteDir)
    }

    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new FitExportError(
        'UNSAFE_OUTPUT_DIRECTORY',
        'The FIT output path must be a real directory, not a file or symlink.',
      )
    }
    if (process.platform !== 'win32') await chmod(absoluteDir, 0o700)
    return absoluteDir
  } catch (error) {
    if (error instanceof FitExportError) throw error
    throw new FitExportError(
      'UNSAFE_OUTPUT_DIRECTORY',
      'The FIT output directory could not be prepared safely.',
    )
  }
}

async function writeExclusive(outputPath: string, fitData: Uint8Array): Promise<void> {
  let file: FileHandle | undefined
  let created = false

  try {
    file = await open(outputPath, 'wx', 0o600)
    created = true
    if (process.platform !== 'win32') await file.chmod(0o600)
    await file.writeFile(fitData)
    await file.sync()
    await file.close()
    file = undefined
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (created) await unlink(outputPath).catch(() => undefined)

    if (!created && isNodeErrorWithCode(error, ['EEXIST', 'EISDIR'])) {
      throw new FitExportError('OUTPUT_EXISTS', 'The FIT output file already exists.')
    }
    throw new FitExportError('OUTPUT_WRITE_FAILED', 'The FIT output file could not be saved.')
  }
}

/**
 * Extract one Garmin FIT file from a bounded ZIP archive and save it locally.
 * ZIP entry names are never used for the destination path, and existing files
 * (including symlinks) are never followed or overwritten.
 */
export async function exportFitFromZip(
  options: ExportFitFromZipOptions,
): Promise<FitExportMetadata> {
  if (!Number.isSafeInteger(options.activityId) || options.activityId <= 0) {
    throw new FitExportError('INVALID_ACTIVITY_ID', 'The Garmin activity ID must be a positive integer.')
  }

  const zipData = await loadZip(options)
  const fitData = extractUniqueFit(zipData)
  validateFitIntegrity(fitData)
  const sha256 = createHash('sha256').update(fitData).digest('hex')

  const privateOutputDir = await preparePrivateDirectory(options.outputDir)
  const fileName = `${options.activityId}.fit`
  const savedPath = resolve(privateOutputDir, fileName)
  await writeExclusive(savedPath, fitData)

  return {
    fileName,
    savedPath,
    sizeBytes: fitData.byteLength,
    sha256,
  }
}
