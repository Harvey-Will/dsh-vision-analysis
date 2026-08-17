/**
 * The vision HTTP client: request construction for the OpenAI
 * `chat/completions` and Anthropic `messages` wire formats, the bounded
 * fetch with cancellation and timeout, and response validation/extraction.
 * @module dsh-universal-vision-analysis/vision-client
 */

import type { Config } from './config.js'
import type { LoadedImage } from './media.js'
import type { VisionMode } from './modes.js'

/** Effective output tuning for one call. */
export interface CallTuning {
  maxTokens: number
  temperature: number
}

/** The outcome of one successful vision request. */
export interface VisionResult {
  /** The extracted text answer. */
  text: string
  /** HTTP status of the response. */
  httpStatus: number
  /** Wall-clock latency of the request in milliseconds. */
  latencyMs: number
  /** Whether the endpoint signalled that the output hit the token budget. */
  truncated: boolean
  /** The endpoint's own finish/stop reason, when present. */
  finishReason?: string
}

/** Error thrown for a non-2xx response or an endpoint-declared error. */
export class VisionApiError extends Error {
  readonly httpStatus?: number
  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'VisionApiError'
    this.httpStatus = httpStatus
  }
}

/** One image content block in the request body (format-neutral). */
type ImageBlock =
  | { kind: 'data'; mimeType: string; base64: string }
  | { kind: 'url'; url: string }

function imageBlock(image: LoadedImage): ImageBlock {
  if (image.base64 !== undefined) {
    return { kind: 'data', mimeType: image.mimeType, base64: image.base64 }
  }
  return { kind: 'url', url: image.source }
}

/**
 * Build the JSON request body for one format.
 * @param config - resolved configuration.
 * @param prompt - the composed instruction text.
 * @param images - the loaded images.
 * @param tuning - effective output tuning.
 * @returns the request body object (JSON-serializable).
 */
export function buildVisionBody(
  config: Config,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
): unknown {
  const blocks = images.map(imageBlock)
  if (config.apiFormat === 'anthropic') {
    return {
      model: config.model,
      max_tokens: tuning.maxTokens,
      temperature: tuning.temperature,
      messages: [{
        role: 'user',
        content: [
          ...blocks.map((block) => block.kind === 'data'
            ? { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.base64 } }
            : { type: 'image', source: { type: 'url', url: block.url } }),
          { type: 'text', text: prompt },
        ],
      }],
    }
  }
  return {
    model: config.model,
    max_completion_tokens: tuning.maxTokens,
    temperature: tuning.temperature,
    messages: [{
      role: 'user',
      content: [
        ...blocks.map((block) => block.kind === 'data'
          ? { type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.base64}` } }
          : { type: 'image_url', image_url: { url: block.url } }),
        { type: 'text', text: prompt },
      ],
    }],
  }
}

/**
 * Extract the answer text from a parsed response, validating the endpoint's
 * error envelope and detecting token-budget truncation.
 * @param config - resolved configuration (selects the format).
 * @param json - the parsed response body.
 * @returns the extracted text, truncation flag, and finish/stop reason.
 */
export function extractVisionText(config: Config, json: unknown): { text: string; truncated: boolean; finishReason?: string } {
  if (typeof json !== 'object' || json === null) {
    throw new VisionApiError('vision endpoint returned a non-object body')
  }
  const body = json as Record<string, unknown>
  if (body.error !== undefined) {
    const message = typeof body.error === 'object' && body.error !== null
      ? String((body.error as Record<string, unknown>).message ?? JSON.stringify(body.error))
      : String(body.error)
    throw new VisionApiError(`vision endpoint reported an error: ${message}`)
  }
  if (config.apiFormat === 'anthropic') {
    const content = Array.isArray(body.content)
      ? body.content
        .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && block.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
      : ''
    const stopReason = typeof body.stop_reason === 'string' ? body.stop_reason : undefined
    return { text: content, truncated: stopReason === 'max_tokens', finishReason: stopReason }
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined
  const message = (typeof choice === 'object' && choice !== null ? choice as Record<string, unknown> : {}).message
  const content = (typeof message === 'object' && message !== null ? message as Record<string, unknown> : {}).content
  const text = Array.isArray(content)
    ? content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
    : typeof content === 'string' ? content : ''
  const finishReason = (typeof choice === 'object' && choice !== null ? (choice as Record<string, unknown>).finish_reason : undefined)
  return {
    text,
    truncated: typeof finishReason === 'string' && finishReason === 'length',
    finishReason: typeof finishReason === 'string' ? finishReason : undefined,
  }
}

/** Bounded read of a response body as text (for error excerpts). */
async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return '<unreadable response body>'
  }
}

/** The shape of the global fetch function, injectable for tests. */
export type FetchLike = typeof fetch

/**
 * Perform one vision request: build the body, fetch with caller cancellation
 * and a timeout, validate the HTTP status, and extract the answer.
 * @param config - resolved configuration.
 * @param endpoint - the composed endpoint URL.
 * @param prompt - the composed instruction text.
 * @param images - the loaded images.
 * @param tuning - effective output tuning.
 * @param signal - caller cancellation, forwarded to the request.
 * @param fetchImpl - fetch implementation (defaults to the global fetch).
 * @returns the validated result.
 */
export async function callVision(
  config: Config,
  endpoint: string,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<VisionResult> {
  const started = Date.now()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiFormat === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (config.apiKey.trim() !== '') headers['x-api-key'] = config.apiKey.trim()
  } else if (config.apiKey.trim() !== '') {
    headers['authorization'] = `Bearer ${config.apiKey.trim()}`
  }
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const combined = AbortSignal.any([signal, timeoutSignal])
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildVisionBody(config, prompt, images, tuning)),
      signal: combined,
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new VisionApiError(`vision request timed out after ${config.timeoutMs} ms`)
    }
    throw new VisionApiError(`vision request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const latencyMs = Date.now() - started
  if (!response.ok) {
    const excerpt = await readErrorText(response)
    throw new VisionApiError(`vision endpoint responded with HTTP ${response.status}: ${excerpt}`, response.status)
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new VisionApiError(`vision endpoint returned non-JSON (HTTP ${response.status})`, response.status)
  }
  const extracted = extractVisionText(config, json)
  return {
    text: extracted.text,
    httpStatus: response.status,
    latencyMs,
    truncated: extracted.truncated,
    finishReason: extracted.finishReason,
  }
}

/** The mode identifiers that participate in a `compare`-style multi-image call. */
export const MULTI_IMAGE_MODES: readonly VisionMode[] = ['compare', 'describe', 'ui-review', 'object-detect']
