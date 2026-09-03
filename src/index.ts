/**
 * Model-facing `analyze_image` tool for the DeepSeek Harness.
 *
 * One call analyzes one or more images — a local absolute path or an http(s)
 * URL each — through an OpenAI- or Anthropic-compatible vision endpoint and
 * returns only the vision model's text answer, so the image bytes never enter
 * the conversation. Eight analysis modes provide default instructions and
 * output tuning; a caller-supplied `prompt` overrides the mode template. The
 * plugin configuration is editable live from Settings -> 插件配置.
 * @module dsh-vision-analysis
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// rc.1 moved JsonValue out of the dsh-session entry (it now lives in
// dsh-util-values, which dsh-session/types consumes).
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only: loads the dsh-settings Context augmentation (ctx.settings) for installSection.
import type {} from '@deepseek-ai/dsh-settings'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, resolveApiKey, resolveConfig, visionModelChain } from './config.js'
import type { ApiFormat } from './config.js'
import { ImageSourceError, loadImage } from './media.js'
import { composePrompt, resolveTuning, VISION_MODES } from './modes.js'
import type { VisionMode } from './modes.js'
import { appendStructured, extractJsonObject, isStructuredMode, isValidShape } from './structured.js'
import { installImageBridge } from './bridge.js'
import type { BridgeServices } from './bridge.js'
import { bridgeChangeNotice } from './model-registry.js'
import { callVision, callVisionWithFailover, VisionCache } from './vision-client.js'
import { installSettingsSectionCompat } from './settings-compat.js'
import {
  ensureBridgeModalities,
  revertBridgeModalities,
  revertAllBridgeModalities,
} from './modalities-sync.js'

/** The plugin's Cordis identity. */
export const name = 'vision-analysis'

/** Hard dependencies; `apply` runs only once they are ready. */
export const inject = ['tools', 'llm', 'attachments', 'settings']

/** The settings namespace under which the plugin's configuration is edited. */
export const SETTINGS_NAMESPACE = 'vision-analysis'

/** The registered tool's canonical call arguments. */
export interface AnalyzeImageArgs {
  /** Local absolute path or http(s) URL of the image to analyze. */
  image?: string
  /** Up to `maxImages` image sources for a multi-image call; overrides `image`. */
  images?: string[]
  /** One of the eight analysis modes; defaults to the configured `defaultMode`. */
  mode?: VisionMode
  /** Custom instruction replacing the mode's default template. */
  prompt?: string
}

/** The canonical output value of one `analyze_image` call. */
export interface AnalyzeImageOutput {
  /** The vision model's text answer (or the debug diagnostics report). */
  text: string
  /** The mode that produced the answer. */
  mode: string
  /** The vision model identifier that produced the answer. */
  model: string
  /** Number of images in the call. */
  imageCount: number
  /** HTTP status of the vision request, when one was made. */
  httpStatus?: number
  /** Request latency in milliseconds, when a request was made. */
  latencyMs?: number
  /** Whether the endpoint signalled token-budget truncation. */
  truncated?: boolean
  /** Parsed machine-readable answer for structured modes (chart-data, ocr), when the reply was valid JSON of the expected shape. */
  data?: Record<string, JsonValue>
}

const TOOL_HEAD =
  'Analyze one or more images with a vision-language model and return its text answer. '
  + 'Use when the user references an image file or URL, or when a task needs OCR, chart or '
  + 'diagram reading, screenshot or UI analysis, image comparison, translation of image text, '
  + 'photo understanding, or HTML/CSS recreation of a UI. '
  + 'Each source is an absolute local path, an http(s) URL, or a base64 image data URL '
  + '(`data:image/png;base64,…`); for a multi-image comparison pass the sources in `images`. '
  + 'Pick the `mode` that best matches the task (describe, ocr, ui-review, chart-data, '
  + 'object-detect, compare, code-gen, debug) and, for anything but a plain description, pass a '
  + 'precise `prompt` — e.g. "transcribe all text", "extract the table as CSV", '
  + '"diagnose the UI layout problems" — since a targeted instruction produces a much more '
  + 'useful answer. The image itself never enters the conversation: only the returned text is shown. '
  + 'The data-heavy modes (chart-data, ocr) also return a machine-readable `data` object '
  + 'alongside the text when structured output is enabled.'

/** Mask a base URL for display in diagnostics (query strings may carry tokens). */
function maskEndpoint(endpoint: string): string {
  const withoutQuery = endpoint.split('?')[0]!
  return withoutQuery
}

/**
 * Assemble the tool output for one finished call: shared by the cache-hit and
 * network paths so a cached structured answer still yields its `data` object.
 * @param active - the configuration in effect (supplies the model label).
 * @param mode - the analysis mode that produced the answer.
 * @param imageCount - number of images in the call.
 * @param result - the vision result (from the network or the cache).
 * @param structured - whether structured output was requested for this call.
 */
function finishOutput(
  active: Config,
  mode: VisionMode,
  imageCount: number,
  result: { text: string; httpStatus?: number; latencyMs?: number; truncated?: boolean },
  structured: boolean,
  answeredModel?: string,
): AnalyzeImageOutput {
  let data: Record<string, JsonValue> | undefined
  if (structured) {
    const parsed = extractJsonObject(result.text)
    if (parsed !== undefined && isValidShape(mode, parsed)) data = parsed as Record<string, JsonValue>
  }
  return {
    text: result.truncated
      ? `${result.text}\n\n[output truncated at the token limit]`
      : result.text,
    mode,
    model: answeredModel ?? active.model,
    imageCount,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    truncated: result.truncated,
    ...(data !== undefined ? { data } : {}),
  }
}

/**
 * The plugin: registers the settings section and the `analyze_image` tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the composition entry configuration (defaults filled by the loader).
 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  let current: () => Config = () => config
  const logger = ctx.logger('vision-analysis')
  // Short-lived result cache. Rebuilt lazily per call so config edits to the
  // TTL / entry cap take effect immediately (a parameter change drops old
  // entries, which is the desired invalidation behavior).
  let cache: VisionCache | undefined
  // Image bridge: routes pasted images to the vision endpoint for bridged
  // (declared image-capable, originally text-only) models, so images can be
  // sent directly regardless of the main model.
  const bridgeServices: BridgeServices = {
    llm: ctx.llm,
    attachments: ctx.attachments,
  }
  ctx.effect(() => installImageBridge(ctx, bridgeServices, current), 'uva: image bridge')

  // Bridge list lifecycle: auto-configure inputModalities for bridged models
  // so DSH admits image prompts, and revert on removal / plugin deactivation.
  const settingsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml')
  let previousBridgeModels: readonly string[] = []

  // Boot-time sync: ensure every bridgeModel has `image` declared.
  const bootModels = config.bridgeModels ?? []
  if (bootModels.length > 0) {
    ensureBridgeModalities(settingsPath, bootModels, (msg) => logger.warn(`[modalities-sync] ${msg}`))
      .catch((err: unknown) => logger.error('[modalities-sync] boot sync failed:', err))
  }
  previousBridgeModels = bootModels

  // Config-change sync: add image for newly listed models, revert for removed ones.
  const syncBridgeLifecycle = (): void => {
    const active = current()
    const currentModels = active.bridgeModels ?? []
    const notice = bridgeChangeNotice(active, previousBridgeModels)
    const added = currentModels.filter((m) => !previousBridgeModels.includes(m))
    const removed = previousBridgeModels.filter((m) => !currentModels.includes(m))
    previousBridgeModels = currentModels

    if (notice !== undefined) logger.warn(`[image bridge] ${notice.replaceAll('\n', ' ')}`)
    if (added.length > 0) {
      ensureBridgeModalities(settingsPath, added, (msg) => logger.warn(`[modalities-sync] ${msg}`))
        .catch((err: unknown) => logger.error('[modalities-sync] add failed:', err))
    }
    if (removed.length > 0) {
      revertBridgeModalities(settingsPath, removed, (msg) => logger.warn(`[modalities-sync] ${msg}`))
        .catch((err: unknown) => logger.error('[modalities-sync] revert failed:', err))
    }
  }

  // On plugin deactivation: revert ALL bridge modalities.
  ctx.effect(() => () => {
    const models = current().bridgeModels ?? []
    if (models.length > 0) {
      revertAllBridgeModalities(settingsPath, (msg) => logger.warn(`[modalities-sync] ${msg}`))
        .catch((err: unknown) => logger.error('[modalities-sync] deactivation revert failed:', err))
    }
  }, 'uva: bridge modalities cleanup')

  installSettingsSectionCompat(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      syncBridgeLifecycle()
    },
    validate: (value) => {
      resolveConfig(value)
    },
  })

  ctx.tools.register(defineTool({
    name: 'analyze_image',
    description: TOOL_HEAD,
    parameters: {
      image: {
        type: 'string',
        description: 'Absolute path to a local image file, an http(s) URL of the image, or a base64 image data URL (data:image/png;base64,…). Required when `images` is omitted.',
      },
      images: {
        type: 'array',
        items: {
          type: 'string',
          description: 'Absolute path, http(s) URL, or base64 image data URL of one image in the batch.',
        },
        description: 'Image sources for a multi-image call (at most the configured maxImages, default 2; compare mode uses 2+). Overrides `image` when present.',
      },
      mode: {
        type: 'string',
        enum: [...VISION_MODES],
        description: 'Analysis mode: describe (default), ocr, ui-review, chart-data, object-detect, compare, code-gen, or debug.',
      },
      prompt: {
        type: 'string',
        description: 'Your precise instruction to the vision model about the image(s). Overrides the mode\'s default template.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          model: { type: 'string', required: true },
          imageCount: { type: 'integer', required: true },
          httpStatus: { type: 'integer' },
          latencyMs: { type: 'integer' },
          truncated: { type: 'boolean' },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const active = current()
      const endpoint = resolveConfig(active)
      const mode = args.mode ?? active.defaultMode
      const sources = args.images !== undefined && args.images.length > 0
        ? args.images
        : args.image !== undefined ? [args.image] : []
      if (sources.length === 0) {
        throw new ImageSourceError('provide an image path/URL, or an images array with at least one entry')
      }
      if (sources.length > active.maxImages) {
        throw new ImageSourceError(`at most ${active.maxImages} images per call (got ${sources.length})`)
      }
      const images = await Promise.all(sources.map((source) => loadImage(source, active.maxBytes, exec.signal)))
      const tuning = resolveTuning(
        mode,
        { maxTokens: active.maxTokens, temperature: active.temperature },
        active.modes,
      )
      const basePrompt = composePrompt(mode, images.length, args.prompt)
      // Structured output: chart-data / ocr get a JSON-shape instruction
      // appended (custom prompts included — the caller still wants data) and,
      // on OpenAI-format endpoints, a `response_format` hint. Everything
      // degrades to plain text when unsupported. Default-on: only an explicit
      // `structuredOutputs: false` turns it off.
      const structured = active.structuredOutputs !== false && isStructuredMode(mode)
      const prompt = structured ? appendStructured(basePrompt, mode) : basePrompt
      const callOpts = structured && active.apiFormat !== 'anthropic'
        ? { responseFormat: 'json_object' as const }
        : {}

      // Caching is skipped for `debug` (it must always hit the network) and
      // when the TTL is 0. On a hit the prior successful answer is returned
      // without issuing a second request. The cache key includes the full
      // prompt, so structured and plain variants never collide.
      const useCache = mode !== 'debug' && active.cacheTtlMs > 0
      if (useCache) {
        if (cache === undefined || cache.ttlMs !== active.cacheTtlMs || cache.maxEntries !== active.cacheMaxEntries) {
          cache = new VisionCache(active.cacheTtlMs, active.cacheMaxEntries)
        }
        const hit = cache.get(endpoint, prompt, images)
        if (hit !== undefined) {
          return finishOutput(active, mode, images.length, hit, structured)
        }
      }

      if (mode === 'debug') {
        return runDebug(active, endpoint, mode, images, prompt, tuning, exec.signal, active.retryCount, active.retryBackoffMs)
      }
      const { result, model } = await callVisionWithFailover(
        active, endpoint, prompt, images, tuning, exec.signal,
        visionModelChain(active), active.retryCount, active.retryBackoffMs, fetch, callOpts,
      )
      if (useCache) {
        cache!.set(endpoint, prompt, images, result)
      }
      return finishOutput(active, mode, images.length, result, structured, model)
    },
    presentCall(args) {
      const sources = args.images !== undefined && args.images.length > 0
        ? args.images
        : args.image !== undefined ? [args.image] : []
      return {
        card: 'generic',
        title: `Analyze image (${args.mode ?? 'describe'})`,
        kind: 'read',
        rawInput: { mode: args.mode, images: sources.length },
        locations: sources
          .filter((source) => !/^https?:\/\//i.test(source))
          .map((path) => ({ path })),
      }
    },
  }))
}

/** The `debug` mode: run a real request and return a connectivity report. */
async function runDebug(
  active: Config,
  endpoint: string,
  mode: VisionMode,
  images: Awaited<ReturnType<typeof loadImage>>[],
  prompt: string,
  tuning: { maxTokens: number; temperature: number },
  signal: AbortSignal,
  retryCount = 0,
  retryBackoffMs = 2000,
): Promise<AnalyzeImageOutput> {
  const apiKey = resolveApiKey(active)
  // Never expose any part of the key, not even a prefix: the report only
  // states whether a credential is configured.
  const keyStatus = apiKey === undefined ? 'not configured (local model)' : 'configured (masked)'
  const header = [
    '## Vision Endpoint Diagnostic',
    '',
    `- Provider format: ${active.apiFormat}`,
    `- Endpoint: ${maskEndpoint(endpoint)}`,
    `- Model: ${active.model}`,
    `- API key: ${keyStatus}`,
    `- Mode: ${mode}`,
    `- Images: ${images.length}`,
  ].join('\n')
  try {
    const result = await callVision(active, endpoint, prompt, images, tuning, signal, retryCount, retryBackoffMs)
    const text = [
      header,
      `- HTTP status: ${result.httpStatus}`,
      `- Latency: ${result.latencyMs} ms`,
      `- Truncated: ${result.truncated}`,
      '',
      '### Response excerpt',
      '',
      '```',
      result.text.slice(0, 2000),
      '```',
    ].join('\n')
    return {
      text,
      mode,
      model: active.model,
      imageCount: images.length,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      truncated: result.truncated,
    }
  } catch (error) {
    const text = [
      header,
      `- Error: ${error instanceof Error ? error.message : String(error)}`,
      '',
      'Check baseURL, apiKey, model, network reachability, and that the endpoint accepts the image format.',
    ].join('\n')
    return { text, mode, model: active.model, imageCount: images.length }
  }
}

export { Config }
export type { ApiFormat }
export {
  API_KEY_ENV,
  ConfigError,
  OVHCLOUD_BASE_URL,
  OVHCLOUD_DEFAULT_MODEL,
  OVHCLOUD_FALLBACK_MODELS,
  resolveEndpoint,
  visionModelChain,
} from './config.js'
export {
  composePrompt,
  MODE_LABELS,
  MODE_PROMPTS,
  MODE_TUNING_DEFAULTS,
  resolveTuning,
  VISION_MODES,
} from './modes.js'
export type { ModeTuning } from './modes.js'
export {
  IMAGE_EXTENSIONS,
  ImageSourceError,
  isDataUrl,
  loadImage,
  mimeFromName,
  parseDataUrl,
  sniffMime,
} from './media.js'
export type { ImageMimeType, LoadedImage } from './media.js'
export {
  appendStructured,
  extractJsonObject,
  isStructuredMode,
  isValidShape,
  STRUCTURED_MODES,
  structuredInstruction,
} from './structured.js'
export {
  BRIDGE_DEFAULT_PROMPT,
  bridgeImagePlaceholder,
  imageBlocksOf,
  installImageBridge,
  lastUserMessageIndex,
  messagesContainImage,
  planBridge,
  projectImagesInMessages,
  textOf,
  textResponseStream,
} from './bridge.js'
export type { BridgePlan, BridgeServices } from './bridge.js'
export {
  bridgeCancelNotice,
  bridgeChangeNotice,
  bridgeSetupNotice,
  classifyModel,
  isBridged,
} from './model-registry.js'
export type { ModelRoute } from './model-registry.js'
export {
  buildVisionBody,
  callVision,
  callVisionWithFailover,
  extractVisionText,
  RATE_LIMIT_GUIDANCE,
  VisionApiError,
  VisionRateLimitError,
} from './vision-client.js'
export type { CallTuning, FetchLike, VisionResult } from './vision-client.js'
