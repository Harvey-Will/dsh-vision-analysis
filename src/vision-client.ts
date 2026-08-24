/**
 * The vision HTTP client: request construction for the OpenAI
 * `chat/completions` and Anthropic `messages` wire formats, the bounded
 * fetch with cancellation and timeout, and response validation/extraction.
 * @module dsh-vision-analysis/vision-client
 */

import type { Config, } from './config.js'
import { resolveApiKey } from './config.js'
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
 * @param opts - optional extras; `responseFormat` asks OpenAI-format endpoints
 *   for a JSON-only answer (ignored for Anthropic, which has no such field).
 * @returns the request body object (JSON-serializable).
 */
export function buildVisionBody(
  config: Config,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
  opts: { responseFormat?: 'json_object' } = {},
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
    ...(opts.responseFormat !== undefined ? { response_format: { type: opts.responseFormat } } : {}),
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
 * Short-lived semantic cache: identical endpoint + model + prompt + image set
 * within the TTL reuses the prior answer instead of issuing a second request.
 * Bounded by entry count (oldest evicted first).
 */
export class VisionCache {
  private entries = new Map<string, { result: VisionResult; expiresAt: number }>()

  constructor(
    /** Result lifetime in milliseconds; 0 disables storing. */
    readonly ttlMs: number,
    /** Maximum number of entries before the oldest is evicted. */
    readonly maxEntries: number,
  ) {}

  private static cacheKey(endpoint: string, prompt: string, images: readonly LoadedImage[]): string {
    const parts = images.map((img) => `${img.source}:${img.mimeType}:${img.base64 ?? img.source}`)
    return [endpoint, prompt, ...parts].join('|')
  }

  get(endpoint: string, prompt: string, images: readonly LoadedImage[]): VisionResult | undefined {
    const k = VisionCache.cacheKey(endpoint, prompt, images)
    const hit = this.entries.get(k)
    if (hit === undefined) return undefined
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(k)
      return undefined
    }
    return hit.result
  }

  set(endpoint: string, prompt: string, images: readonly LoadedImage[], result: VisionResult): void {
    // ttlMs 0 disables storing entirely (a stored entry would be expired the
    // same millisecond, so storing is pure waste); maxEntries 0 also no-ops.
    if (this.maxEntries <= 0 || this.ttlMs <= 0) return
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const k = VisionCache.cacheKey(endpoint, prompt, images)
    this.entries.set(k, { result, expiresAt: Date.now() + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Perform one vision request: build the body, fetch with caller cancellation
 * and a timeout, validate the HTTP status, and extract the answer. On HTTP 429
 * or transient 5xx, retries with exponential backoff up to `retryCount` times.
 * @param config - resolved configuration.
 * @param endpoint - the composed endpoint URL.
 * @param prompt - the composed instruction text.
 * @param images - the loaded images.
 * @param tuning - effective output tuning.
 * @param signal - caller cancellation, forwarded to the request.
 * @param fetchImpl - fetch implementation (defaults to the global fetch).
 * @param opts - optional extras; `responseFormat` asks OpenAI-format endpoints
 *   for a JSON-only answer, and when the endpoint rejects that parameter the
 *   request is retried once without it (prompt-only structured instruction).
 * @returns the validated result.
 */
export async function callVision(
  config: Config,
  endpoint: string,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
  signal: AbortSignal,
  retryCount = 0,
  retryBackoffMs = 2000,
  fetchImpl: FetchLike = fetch,
  opts: { responseFormat?: 'json_object' } = {},
): Promise<VisionResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callVisionOnce(config, endpoint, prompt, images, tuning, signal, fetchImpl, opts)
    } catch (error) {
      if (signal.aborted) throw error
      // An endpoint that does not know `response_format` rejects the whole
      // request with a 4xx naming it. The JSON-shape instruction in the prompt
      // still stands, so one plain retry recovers the feature gracefully.
      if (
        opts.responseFormat !== undefined &&
        error instanceof VisionApiError &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 400 && error.httpStatus < 500 &&
        /response_format|json_object|json mode|response format/i.test(error.message)
      ) {
        return callVision(config, endpoint, prompt, images, tuning, signal, 0, retryBackoffMs, fetchImpl, {})
      }
      const isRetryable =
        error instanceof VisionApiError &&
        (error.httpStatus === 429 || (error.httpStatus !== undefined && error.httpStatus >= 500))
      if (!isRetryable || attempt >= retryCount) throw error
      // Exponential backoff: 2s, 4s, 8s … abort-aware. The abort listener is
      // removed once the wait completes so it never leaks on the shared signal.
      const delay = retryBackoffMs * Math.pow(2, attempt)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, delay)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}

/**
 * Thrown when every model in a failover chain answered HTTP 429 — the
 * deployment's quota for this endpoint is exhausted for now. The message
 * carries user-facing recovery guidance; `triedModels` lists the attempts.
 */
export class VisionRateLimitError extends Error {
  /** Every model id that was tried and answered 429, in order. */
  readonly triedModels: string[]

  constructor(message: string, triedModels: string[]) {
    super(message)
    this.name = 'VisionRateLimitError'
    this.triedModels = triedModels
  }
}

/** User-facing recovery guidance embedded in rate-limit errors. */
export const RATE_LIMIT_GUIDANCE =
  'Free-tier quotas reset every minute — retry shortly, register a free OVHcloud API key ' +
  '(https://www.ovhcloud.com/en/public-cloud/ai-endpoints/) for higher limits, or configure your own vision endpoint.'

/**
 * Call the configured primary vision model and, when it is rate limited
 * (HTTP 429), fall over to each fallback model in order. Non-429 errors are
 * NOT retried across models — they indicate a problem failover cannot fix.
 * @param config - resolved configuration (`config.model` is the primary).
 * @param endpoint - the composed endpoint URL.
 * @param prompt - the composed instruction text.
 * @param images - the loaded images.
 * @param tuning - effective output tuning.
 * @param signal - caller cancellation, forwarded to each attempt.
 * @param models - ordered model ids (see `visionModelChain`).
 * @param retryCount - per-model transient-error retries before failing over.
 * @param retryBackoffMs - base backoff for those retries.
 * @param fetchImpl - fetch implementation (defaults to the global fetch).
 * @param opts - optional extras forwarded to every attempt (e.g.
 *   `responseFormat` for structured answers; a 429 still fails over, and the
 *   plain-retry fallback inside each attempt drops it when unsupported).
 * @returns the validated result plus the model that actually answered.
 * @throws VisionRateLimitError when every model answers 429.
 */
export async function callVisionWithFailover(
  config: Config,
  endpoint: string,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
  signal: AbortSignal,
  models: readonly string[],
  retryCount = 0,
  retryBackoffMs = 2000,
  fetchImpl: FetchLike = fetch,
  opts: { responseFormat?: 'json_object' } = {},
): Promise<{ result: VisionResult; model: string }> {
  const tried: string[] = []
  for (const model of models) {
    tried.push(model)
    try {
      const result = await callVision(
        { ...config, model },
        endpoint,
        prompt,
        images,
        tuning,
        signal,
        retryCount,
        retryBackoffMs,
        fetchImpl,
        opts,
      )
      return { result, model }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof VisionApiError && error.httpStatus === 429) {
        continue
      }
      throw error
    }
  }
  throw new VisionRateLimitError(
    `All vision models are rate limited (${tried.join(' → ')}). ${RATE_LIMIT_GUIDANCE}`,
    tried,
  )
}

/** Single attempt (no retry). */
async function callVisionOnce(
  config: Config,
  endpoint: string,
  prompt: string,
  images: readonly LoadedImage[],
  tuning: CallTuning,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  opts: { responseFormat?: 'json_object' } = {},
): Promise<VisionResult> {
  const started = Date.now()
  const apiKey = resolveApiKey(config)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiFormat === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey !== undefined) headers['x-api-key'] = apiKey
  } else if (apiKey !== undefined) {
    headers['authorization'] = `Bearer ${apiKey}`
  }
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const combined = AbortSignal.any([signal, timeoutSignal])
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildVisionBody(config, prompt, images, tuning, opts)),
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
