/**
 * Image source handling: MIME detection by extension and magic bytes, bounded
 * reads for local files and http(s) URLs, and the image-reference model used
 * by the vision client (local files are base64-embedded, URLs are passed
 * through verbatim).
 * @module dsh-universal-vision-analysis/media
 */

import { readFile, stat } from 'node:fs/promises'

/** MIME types this plugin recognizes. */
export type ImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/bmp'

/** Image file extensions this plugin recognizes (lowercase, no dot). */
export const IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpeg',
  'jpg',
  'gif',
  'webp',
  'bmp',
]

const EXTENSION_MIME: Readonly<Record<string, ImageMimeType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** Bytes-per-megabyte constant for readable size messages. */
export const MEGABYTE = 1024 * 1024

/**
 * Map a file extension to a MIME type.
 * @param path - a local path or URL whose last segment carries the extension.
 * @returns the recognized MIME type, or `undefined` for an unknown extension.
 */
export function mimeFromName(path: string): ImageMimeType | undefined {
  const match = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(path)
  if (match === null) return undefined
  return EXTENSION_MIME[match[1]!.toLowerCase()]
}

/**
 * Sniff the MIME type from leading magic bytes. JPEG, PNG, GIF, WebP and BMP
 * each carry a recognizable signature; anything else returns `undefined`.
 * @param bytes - the file's leading bytes.
 * @returns the sniffed MIME type, or `undefined` when the signature is unknown.
 */
export function sniffMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp'
  }
  return undefined
}

/** Whether a source string is an http(s) URL. */
export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

/**
 * Read the body of an http(s) response with a byte cap, honoring the
 * `content-length` header and then streaming with a hard cap so an oversized
 * or hostile body cannot be buffered whole.
 * @param response - a fetched response whose body has not been consumed.
 * @param maxBytes - per-image byte cap.
 * @returns the buffered bytes and the response's content-type header, if any.
 */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`image exceeds the ${Math.round(maxBytes / MEGABYTE)} MB limit (content-length ${size} bytes)`)
    }
  }
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error(`image exceeds the ${Math.round(maxBytes / MEGABYTE)} MB limit (${buffer.byteLength} bytes)`)
    }
    return { bytes: buffer, contentType: response.headers.get('content-type') }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`image exceeds the ${Math.round(maxBytes / MEGABYTE)} MB limit (stream aborted at ${total} bytes)`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, contentType: response.headers.get('content-type') }
}

/** One image ready to send to a vision endpoint. */
export interface LoadedImage {
  /** The caller's original source string (path or URL). */
  source: string
  /** The image MIME type, resolved from extension, magic bytes, or content-type. */
  mimeType: ImageMimeType
  /** Base64 data for local files; `undefined` when the image is passed as a URL. */
  base64?: string
  /** Size of the underlying bytes for local files; `undefined` for URLs. */
  bytes?: number
}

/** Error thrown when a local path does not exist or is not a regular file. */
export class ImageSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageSourceError'
  }
}

/**
 * Resolve one image source to a MIME type (and bytes for local files). URL
 * sources are passed through by reference — the vision endpoint fetches them —
 * after basic URL and extension checks. Local paths are read with a byte cap
 * and embedded as base64.
 * @param source - an absolute local path or an http(s) URL.
 * @param maxBytes - per-image byte cap for local files.
 * @param signal - cancellation forwarded to the URL fetch.
 * @returns the loaded image reference.
 */
export async function loadImage(source: string, maxBytes: number, signal: AbortSignal): Promise<LoadedImage> {
  if (isHttpUrl(source)) {
    const byName = mimeFromName(source)
    if (byName === undefined) {
      throw new ImageSourceError(`URL does not end in a recognized image extension (.png/.jpg/.jpeg/.gif/.webp/.bmp): ${source}`)
    }
    return { source, mimeType: byName }
  }
  if (!source.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(source)) {
    throw new ImageSourceError(`image must be an absolute local path or an http(s) URL: ${source}`)
  }
  const info = await stat(source)
  if (!info.isFile()) {
    throw new ImageSourceError(`not a regular file: ${source}`)
  }
  if (info.size > maxBytes) {
    throw new ImageSourceError(`image exceeds the ${Math.round(maxBytes / MEGABYTE)} MB limit (${info.size} bytes): ${source}`)
  }
  const bytes = await readFile(source)
  const byName = mimeFromName(source)
  const sniffed = sniffMime(bytes)
  const mimeType = byName ?? sniffed
  if (mimeType === undefined) {
    throw new ImageSourceError(`unrecognized image format (expected PNG/JPEG/GIF/WebP/BMP): ${source}`)
  }
  return {
    source,
    mimeType,
    base64: Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    bytes: bytes.byteLength,
  }
}
