/**
 * Model-facing `analyze_image` tool for the DeepSeek Harness.
 *
 * One call analyzes one or more images — a local absolute path or an http(s)
 * URL each — through an OpenAI- or Anthropic-compatible vision endpoint and
 * returns only the vision model's text answer, so the image bytes never enter
 * the conversation. Eight analysis modes provide default instructions and
 * output tuning; a caller-supplied `prompt` overrides the mode template. The
 * plugin configuration is editable live from Settings -> 插件配置.
 * @module dsh-universal-vision-analysis
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, resolveApiKey, resolveConfig } from './config.js'
import type { ApiFormat } from './config.js'
import { ImageSourceError, loadImage } from './media.js'
import { composePrompt, resolveTuning, VISION_MODES } from './modes.js'
import type { VisionMode } from './modes.js'
import { callVision } from './vision-client.js'

/** The plugin's Cordis identity. */
export const name = 'universal-vision-analysis'

/** Hard dependency on the tool registry; `apply` runs only once it is ready. */
export const inject = ['tools']

/** The settings namespace under which the plugin's configuration is edited. */
export const SETTINGS_NAMESPACE = 'universal-vision-analysis'

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
  + 'useful answer. The image itself never enters the conversation: only the returned text is shown.'

/** Mask a base URL for display in diagnostics (query strings may carry tokens). */
function maskEndpoint(endpoint: string): string {
  const withoutQuery = endpoint.split('?')[0]!
  return withoutQuery
}

/**
 * The plugin: registers the settings section and the `analyze_image` tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the composition entry configuration (defaults filled by the loader).
 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
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
      const prompt = composePrompt(mode, images.length, args.prompt)

      if (mode === 'debug') {
        return runDebug(active, endpoint, mode, images, prompt, tuning, exec.signal)
      }
      const result = await callVision(active, endpoint, prompt, images, tuning, exec.signal)
      const text = result.truncated
        ? `${result.text}\n\n[output truncated at the token limit]`
        : result.text
      return {
        text,
        mode,
        model: active.model,
        imageCount: images.length,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        truncated: result.truncated,
      }
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
): Promise<AnalyzeImageOutput> {
  const apiKey = resolveApiKey(active)
  const maskKey = (key: string | undefined): string =>
    key === undefined ? '(none)' : `${key.slice(0, 4)}****`
  const header = [
    '## Vision Endpoint Diagnostic',
    '',
    `- Provider format: ${active.apiFormat}`,
    `- Endpoint: ${maskEndpoint(endpoint)}`,
    `- Model: ${active.model}`,
    `- API key: ${maskKey(apiKey)}`,
    `- Mode: ${mode}`,
    `- Images: ${images.length}`,
  ].join('\n')
  try {
    const result = await callVision(active, endpoint, prompt, images, tuning, signal)
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
  resolveEndpoint,
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
  buildVisionBody,
  callVision,
  extractVisionText,
  VisionApiError,
} from './vision-client.js'
export type { CallTuning, FetchLike, VisionResult } from './vision-client.js'
