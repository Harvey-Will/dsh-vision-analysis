/**
 * The image bridge: a `llm/stream` waterfall listener that routes image
 * content to the configured vision endpoint for models listed in
 * `bridgeModels`.
 *
 * Bridged models are text-only models the deployment declared image-capable
 * (their `inputModalities` includes `image` in settings.yaml) so the harness
 * admits image prompts. Because they are declared image-capable, DSH's own
 * text-only projection is skipped — so this listener is the ONLY thing that
 * keeps raw image bytes away from those models:
 *
 *  - a conversation turn whose newest user message carries images is
 *    short-circuited: the images are read through the attachment store and
 *    analyzed by the configured vision endpoint, and the analysis text is
 *    yielded as the response (the user's question from the same message rides
 *    along);
 *  - images in OLDER history (already answered by a previous bridge turn) are
 *    projected to stable placeholder text before any re-dispatch, exactly as
 *    DSH's own text-only projection would;
 *  - compaction / session-title calls never run vision analysis — they are
 *    re-dispatched with every image projected, so the harness's internal
 *    summaries keep working without raw images reaching the model;
 *  - any failure degrades the same way (all images projected, model answers
 *    text-only history) — never `next()`, because DSH would not project a
 *    declared-image-capable model and the raw bytes would 404.
 *
 * Models NOT in `bridgeModels` (native multimodal ones) pass through
 * untouched via `next()`. The request is never mutated in place; re-dispatch
 * builds a fresh options object whose projected messages are reconstructable
 * from the session log (the placeholder carries the attachment digest).
 * @module dsh-vision-analysis/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, ImageBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.js'
import { resolveConfig, visionModelChain } from './config.js'
import { resolveTuning } from './modes.js'
import { callVisionWithFailover, VisionRateLimitError } from './vision-client.js'
import type { LoadedImage } from './media.js'
import { isBridged } from './model-registry.js'

/** Default instruction appended to the user's question when bridging. */
export const BRIDGE_DEFAULT_PROMPT =
  'Analyze the attached image(s) to answer the user\'s request above. '
  + 'Report what is actually visible; do not invent details. '
  + 'Respond in the same language as the user.'

/** Stable, deterministic text replacing one image for a text-only model. */
export function bridgeImagePlaceholder(ref: ImageAttachmentRef): string {
  return `[image omitted — bridged text-only model; attachment ${ref.attachmentId}]`
}

/**
 * Project every image block (nested tool results included) to placeholder
 * text, mirroring DSH's own text-only projection. The placeholder is
 * deterministic in the attachment id, so it is reconstructable from the
 * session log — the model-visible ⟺ logged invariant holds.
 */
export function projectImagesInMessages(messages: readonly Message[]): Message[] {
  const projectContent = (blocks: readonly ContentBlock[]): ContentBlock[] => {
    const next: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type === 'image') {
        next.push({ type: 'text', text: bridgeImagePlaceholder(block.attachment) })
      } else if (block.type === 'tool-result') {
        next.push({ ...block, content: projectContent(block.content) })
      } else {
        next.push(block)
      }
    }
    return next
  }
  return messages.map((message) => ({ ...message, content: projectContent(message.content) }))
}

/** The slice of the runtime services the bridge needs, for testability. */
export interface BridgeServices {
  llm: {
    /** Re-dispatch a (possibly projected) model call through the full pipeline. */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
  attachments: {
    readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
  }
}

/** One decided bridge plan: the composed prompt and the images to send. */
export interface BridgePlan {
  prompt: string
  images: LoadedImage[]
}

/** Whether any message in the list carries an image block, nested included. */
export function messagesContainImage(messages: readonly Message[]): boolean {
  return messages.some((message) => contentHasImage(message.content))
}

/** Index of the last user-role message in the list, or -1. */
export function lastUserMessageIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i
  }
  return -1
}

/** Collect every image block from one message's content, in order. */
export function imageBlocksOf(message: Message): ImageBlock[] {
  return message.content.filter((block): block is ImageBlock => block.type === 'image')
}

/** Collect the plain-text blocks of one message, joined with newlines. */
export function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
}

/**
 * Build a bridge plan for the NEWEST user message only. History images are
 * left alone here — the caller projects them before any re-dispatch.
 * Returns `null` when the newest user message carries no images.
 * @param services - the attachment slice used for bytes.
 * @param config - the plugin configuration in effect.
 * @param options - the assembled model request.
 */
export async function planBridge(
  services: BridgeServices,
  config: Config,
  options: GenerateOptions,
): Promise<BridgePlan | null> {
  if (config.imageBridge !== true) return null
  if (!isBridged(config.bridgeModels ?? [], options.model)) return null
  const index = lastUserMessageIndex(options.messages)
  if (index === -1) return null
  const target = options.messages[index]!
  const blocks = imageBlocksOf(target)
  if (blocks.length === 0) return null

  const images: LoadedImage[] = []
  for (const block of blocks) {
    const stored = await services.attachments.readImage(block.attachment, options.signal)
    images.push({
      source: `attachment:${block.attachment.attachmentId}`,
      mimeType: block.attachment.mediaType as LoadedImage['mimeType'],
      base64: Buffer.from(stored.data.buffer as ArrayBuffer, stored.data.byteOffset, stored.data.byteLength).toString('base64'),
      bytes: stored.data.byteLength,
    })
  }
  if (images.length === 0) return null

  const userText = textOf(target)
  const instruction = config.bridgePrompt.trim() === '' ? BRIDGE_DEFAULT_PROMPT : config.bridgePrompt.trim()
  const prompt = userText.trim() === '' ? instruction : `${userText.trim()}\n\n${instruction}`
  return { prompt, images }
}

/**
 * Synthesize the model-response stream for one bridged answer, mirroring the
 * chunk sequence a real text adapter would emit. `usage` is intentionally
 * omitted — the vision endpoint does not report harness token accounting.
 * @param text - the vision model's answer.
 */
export function* textResponseStream(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Run one vision analysis for a bridge plan across the configured model
 * chain (primary + rate-limit fallbacks) and return the answer text.
 * @param config - the plugin configuration in effect.
 * @param plan - the decided plan (prompt + loaded images).
 * @param signal - caller cancellation.
 */
async function runBridgeVision(config: Config, plan: BridgePlan, signal?: AbortSignal): Promise<string> {
  const endpoint = resolveConfig(config)
  const tuning = resolveTuning(
    'describe',
    { maxTokens: config.maxTokens, temperature: config.temperature },
    config.modes,
  )
  const { result } = await callVisionWithFailover(
    config,
    endpoint,
    plan.prompt,
    plan.images,
    tuning,
    signal ?? new AbortController().signal,
    visionModelChain(config),
  )
  return result.text
}

/**
 * The user-facing notice yielded when every vision model in the chain is rate
 * limited: explains what happened and lays out the recovery options (wait for
 * the per-minute reset, register a free OVHcloud API key, or configure a own
 * endpoint).
 * @param error - the exhausted-chain error carrying the tried models.
 */
export function bridgeRateLimitNotice(error: VisionRateLimitError): string {
  return [
    `⚠️ 免费视觉源额度已用完（依次尝试了 ${error.triedModels.join(' → ')}，均被限流），本轮图片未能分析。`,
    '可以选择：① 稍等约一分钟再发（每分钟配额自动重置）；② 在插件配置中填入免费的 OVHcloud API Key 提升限额；③ 配置自己的视觉端点。',
    '',
    '⚠️ Image bridge: the free vision source is rate limited and this image could not be analyzed. '
    + 'Wait about a minute and resend, add a free OVHcloud API key in the plugin settings, or configure your own endpoint.',
  ].join('\n')
}

/**
 * Re-dispatch a call whose every image is projected to placeholder text, so a
 * bridged (declared image-capable but text-only) model never receives raw
 * image bytes. Mirrors DSH's own text-only projection and keeps the response
 * reconstructable from the session log.
 */
async function* projectAndRedispatch(
  services: BridgeServices,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const projected = projectImagesInMessages(options.messages)
  yield* services.llm.stream({ ...options, messages: projected })
}

/**
 * Install the `llm/stream` waterfall listener. Returns the disposer.
 *
 * Routing for one call:
 *  - bridge disabled, model not in `bridgeModels`, or no image anywhere →
 *    `next()` (untouched);
 *  - internal-purpose calls (compaction / session-title) or a conversation
 *    turn whose newest user message has no images → re-dispatch with every
 *    image projected (never raw bytes, never vision cost);
 *  - a conversation turn with images in its newest user message → vision
 *    bridge; on any failure → projected re-dispatch.
 * @param ctx - registrant context (must declare `llm/stream`).
 * @param services - the llm + attachments slices (typically `ctx.llm`/`ctx.attachments`).
 * @param getConfig - resolves the live plugin configuration per call.
 */
export function installImageBridge(
  ctx: Pick<Context, 'on'>,
  services: BridgeServices,
  getConfig: () => Config,
): () => void {
  return ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const config = getConfig()
    if (
      config.imageBridge !== true
      || !isBridged(config.bridgeModels ?? [], options.model)
      || !messagesContainImage(options.messages)
    ) {
      return next()
    }

    return (async function* (): AsyncGenerator<StreamChunk> {
      // Internal calls never pay vision cost and never send raw images.
      if (options.purpose !== undefined) {
        yield* projectAndRedispatch(services, options)
        return
      }

      let plan: BridgePlan | null
      try {
        plan = await planBridge(services, config, options)
      } catch {
        yield* projectAndRedispatch(services, options)
        return
      }
      if (plan === null) {
        // Images only in history (already answered in earlier bridge turns).
        yield* projectAndRedispatch(services, options)
        return
      }
      try {
        yield* textResponseStream(await runBridgeVision(config, plan, options.signal))
      } catch (error) {
        if (error instanceof VisionRateLimitError) {
          // Every model in the chain is rate limited: tell the user what to
          // do instead of degrading silently.
          yield* textResponseStream(bridgeRateLimitNotice(error))
          return
        }
        // Other failures: degrade to DSH's normal placeholder pipeline.
        yield* projectAndRedispatch(services, options)
      }
    })()
  })
}
