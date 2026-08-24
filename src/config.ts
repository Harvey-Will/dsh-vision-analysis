/**
 * Plugin configuration: the Schemastery `Config` schema that the Harness
 * settings UI renders, plus pure resolution helpers (endpoint composition,
 * per-mode tuning, API key resolution).
 * @module dsh-universal-vision-analysis/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { ModeTuning, VisionMode } from './modes.js'

/** The vision API wire format spoken by the configured endpoint. */
export type ApiFormat = 'openai' | 'anthropic'

/** Plugin configuration, supplied through cordis.yml and the settings UI. */
export interface Config {
  /** Wire format of the vision endpoint (`openai` chat/completions or `anthropic` messages). */
  apiFormat: ApiFormat
  /** Base URL of the vision endpoint; a full `/chat/completions` or `/v1/messages` suffix is accepted and kept. */
  baseURL: string
  /** API key for the vision endpoint. Leave empty for local models (Ollama, LM Studio, vLLM) or to fall back to the `UNIVERSAL_VISION_API_KEY` environment variable. */
  apiKey: string
  /** Vision model identifier sent to the endpoint. */
  model: string
  /** Mode used when the caller omits `mode`. */
  defaultMode: VisionMode
  /** Maximum number of images per call (1-4). */
  maxImages: number
  /** Per-image byte cap for local files (and a hint for streamed URL bodies). */
  maxBytes: number
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Default maximum output tokens, used when a mode has no override. */
  maxTokens: number
  /** Default temperature, used when a mode has no override. */
  temperature: number
  /** Per-mode output tuning overrides. */
  modes: Partial<Record<VisionMode, ModeTuning>>
  /** Ask chart-data and ocr for machine-readable JSON; plain-text fallback when unsupported. */
  structuredOutputs: boolean
  /** Route pasted images to the configured vision model when the active model is text-only. */
  imageBridge: boolean
  /**
   * Model ids whose image content is routed through this plugin's vision
   * endpoint. These are text-only models that the deployment declared
   * image-capable (inputModalities includes `image` in settings.yaml) so the
   * harness admits image prompts; the plugin intercepts them before the LLM
   * call. Models NOT in this list keep their native route untouched.
   */
  bridgeModels: string[]
  /** Optional instruction appended to the user question when bridging images. */
  bridgePrompt: string
  /** Result cache TTL in milliseconds (0 disables caching). */
  cacheTtlMs: number
  /** Maximum number of cached results. */
  cacheMaxEntries: number
  /** Number of retries on HTTP 429 / transient 5xx. */
  retryCount: number
  /** Base backoff in ms for the first retry; doubles per subsequent attempt. */
  retryBackoffMs: number
}

/** Environment variable that supplies the API key when `config.apiKey` is empty. */
export const API_KEY_ENV = 'UNIVERSAL_VISION_API_KEY'

/** Schema of the plugin configuration, validated at load and rendered by the settings UI. */
export const Config: Schema<Config> = Schema.object({
  apiFormat: Schema.union(['openai', 'anthropic'])
    .default('openai')
    .description('Wire format of the vision endpoint.'),
  baseURL: Schema.string()
    .description('Base URL of the vision endpoint. Accepts a full /chat/completions (OpenAI) or /v1/messages (Anthropic) suffix.'),
  apiKey: Schema.string()
    .role('secret')
    .default('')
    .description('API key for the vision endpoint. Empty means local model or the UNIVERSAL_VISION_API_KEY environment variable.'),
  model: Schema.string()
    .description('Vision model identifier, e.g. mimo-v2.5, gpt-4o-mini, llava:13b.'),
  defaultMode: Schema.union(['describe', 'ocr', 'ui-review', 'chart-data', 'object-detect', 'compare', 'code-gen', 'debug'])
    .default('describe')
    .description('Mode used when a call omits mode.'),
  maxImages: Schema.natural()
    .min(1)
    .max(4)
    .default(2)
    .description('Maximum number of images per call (1-4).'),
  maxBytes: Schema.natural()
    .min(64 * 1024)
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024)
    .description('Per-image byte cap for local files.'),
  timeoutMs: Schema.natural()
    .min(1000)
    .default(120000)
    .description('Request timeout in milliseconds.'),
  maxTokens: Schema.natural()
    .min(256)
    .max(65536)
    .default(4096)
    .description('Default maximum output tokens; a per-mode override wins when present.'),
  temperature: Schema.percent()
    .default(0.7)
    .description('Default temperature; a per-mode override wins when present.'),
  modes: Schema.dict(
    Schema.object({
      maxTokens: Schema.natural()
        .min(256)
        .max(65536)
        .description('Override of the maximum output tokens for this mode.'),
      temperature: Schema.percent()
        .description('Override of the temperature for this mode.'),
    }).description('Per-mode output tuning.'),
  ).default({}).description('Per-mode overrides of maxTokens and temperature.'),
  structuredOutputs: Schema.boolean()
    .default(true)
    .description('Ask chart-data and ocr modes for machine-readable JSON; falls back to plain text when the endpoint lacks support.'),
  imageBridge: Schema.boolean()
    .default(true)
    .description('Route pasted/sent images to the configured vision model when the active model is text-only, so images can be sent directly regardless of the main model.'),
  bridgeModels: Schema.array(Schema.string())
    .default([])
    .description('Text-only model ids routed through this plugin (images go to the configured vision endpoint). These models are marked as originally text-only: the deployment must also declare `image` in their inputModalities (settings.yaml) or the harness will still reject image prompts. Removing a model here cancels bridging — remember to remove `image` from its inputModalities to restore the text-only declaration. Models not listed here (e.g. native multimodal ones) keep their direct route.'),
  bridgePrompt: Schema.string()
    .default('')
    .description('Optional instruction appended to the user question when bridging images to the vision model (default: a neutral analyze-and-answer instruction).'),
  cacheTtlMs: Schema.natural()
    .min(0)
    .default(60_000)
    .description('Result cache TTL in milliseconds (0 disables caching).'),
  cacheMaxEntries: Schema.natural()
    .min(1)
    .default(32)
    .description('Maximum number of cached results.'),
  retryCount: Schema.natural()
    .min(0)
    .max(5)
    .default(1)
    .description('Retries on HTTP 429 / transient 5xx.'),
  retryBackoffMs: Schema.natural()
    .min(100)
    .default(2000)
    .description('Base backoff in ms for the first retry; doubles per subsequent attempt.'),
})

/** Error thrown when configuration cannot be used for a call. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Compose the full request endpoint from the configured base URL, keeping a
 * complete `/chat/completions` (OpenAI) or `/v1/messages` (Anthropic) suffix
 * and appending the canonical path otherwise.
 * @param config - resolved configuration.
 * @returns the absolute endpoint URL.
 */
export function resolveEndpoint(config: Config): string {
  const base = config.baseURL.trim().replace(/\/+$/, '')
  if (base === '') throw new ConfigError('baseURL is not configured')
  if (config.apiFormat === 'anthropic') {
    if (/\/messages$/.test(base)) return base
    if (/\/v1$/.test(base)) return `${base}/messages`
    return `${base}/v1/messages`
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

/**
 * Validate that the configuration names an endpoint and a model, returning
 * the normalized endpoint. Fail-loud at load time for a non-empty entry; the
 * tool re-checks per call so an unconfigured mount still reports clearly.
 * @param config - the configuration to resolve.
 * @returns the resolved endpoint URL.
 */
export function resolveConfig(config: Config): string {
  const endpoint = resolveEndpoint(config)
  if (config.model.trim() === '') {
    throw new ConfigError('model is not configured (set it in cordis.yml or Settings -> 插件配置)')
  }
  return endpoint
}

/**
 * Resolve the API key for one call: inline config value first, then the
 * `UNIVERSAL_VISION_API_KEY` environment variable. Local endpoints may run
 * with no key at all.
 * @param config - the configuration in effect for the call.
 * @returns the trimmed key, or `undefined` when neither source supplies one.
 */
export function resolveApiKey(config: Config): string | undefined {
  const inline = config.apiKey.trim()
  if (inline !== '') return inline
  const fromEnv = process.env[API_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return undefined
}
