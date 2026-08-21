/**
 * Browser half of dsh-universal-vision-analysis: a `conversation.input.dock`
 * entry that guides the Web UI when the active model cannot take image input.
 *
 * Flow: when the composer holds draft images and the session's current model
 * is NOT confirmed image-capable, the entry renders a hint asking the user to
 * save the image to a local file and send its absolute path, so the host-side
 * `analyze_image` tool parses it directly. Base64 data URLs were tried first
 * (compress → embed in a text prompt → agent calls analyze_image), but the
 * multi-hundred-KB payloads were corrupted in the message→tool→vision-API
 * pipeline, so the banner now only guides toward the reliable local-path
 * route. When the model is image-capable, the entry renders nothing and the
 * native image send path is untouched.
 *
 * Deliberately dependency-light: the entry reads input state through the
 * standard composer provide channel (`useInput`), resolves the current model
 * through the shared API client, and collaborates with the host half only
 * through the `analyze_image` tool itself — no custom client→host RPC is
 * registered.
 * @module dsh-universal-vision-analysis/client
 */

import React, { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pull the client Context merges (ctx.locale, ctx.slots,
// ctx.connection, ctx.conversation) from their owning packages. These imports
// are erased at build time and never enter the browser bundle.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Locale namespace for this browser half. */
const NS = 'universal-vision-analysis'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Composer paste-image interpretation fallback copy. */
    'universal-vision-analysis': (typeof COPY)['zh']
  }
}

/** Product copy (Chinese, matching the DSH web UI language). */
const COPY = {
  zh: {
    'interpret.banner': '当前模型不支持图片输入。请将图片保存到本地磁盘，然后发送其绝对路径（如 /path/to/image.png），我会调用 analyze_image 工具解析。',
    'interpret.hint': '或切换到支持图片的模型（如 doubao-seed-2.0-lite）后直接粘贴发送。',
  },
  en: {
    'interpret.banner': 'The current model cannot take images. Save the image to a local file and send its absolute path (e.g. /path/to/image.png); the analyze_image tool will parse it.',
    'interpret.hint': 'Or switch to an image-capable model (e.g. doubao-seed-2.0-lite) and paste directly.',
  },
}

/**
 * Model ids that natively accept image input. Prefix matching, lowercase.
 * A model on this list sends pasted images through the native path; any other
 * model falls back to the analyze_image interpretation path.
 *
 * Only models whose endpoint ACTUALLY accepts image input belong here. The
 * deployment enables native image requests per model via `inputModalities` in
 * `llm-deepseek.models` (settings.yaml), but the adapter still re-checks the
 * live endpoint model directory at request time — a model listed here while
 * its endpoint stays text-only lets an image into the session history, which
 * then fails every later turn. DeepSeek-v4/glm stay off this list; only the
 * verified multimodal route (doubao-seed-2.0) is enabled.
 */
const IMAGE_CAPABLE_MODEL_HINTS = [
  'doubao-seed-2.0',
  'gpt-4o',
  'gpt-4.1',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'gemini-1.5',
  'gemini-2.0',
  'gemini-2.5',
  'qwen-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'glm-4v',
  'llava',
  'internvl',
  'minicpm-v',
]

/** Whether a model id is presumed capable of native image input. */
function modelSupportsImage(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return IMAGE_CAPABLE_MODEL_HINTS.some((hint) => id.includes(hint))
}

/** Minimal structural contracts; the runtime injects the real objects. */
interface VisionDockProps {
  sessionId?: string
  /** Composer input state, provided to every session-scope entry. */
  useInput?: (selector: (state: unknown) => unknown) => unknown
  /** Injectable: the shared API client (current model resolution). */
  api?: {
    sessions: {
      models(request: { sessionId: string }): Promise<{ result?: { current?: { model?: string } } }>
    }
  }
  /** Injectable: bound translator for this namespace. */
  t?: (key: string, params?: Record<string, string>) => string
}

/** The composer dock entry that guides image-capability fallback. */
function VisionInterpretDock({
  sessionId, useInput, api, t,
}: VisionDockProps): React.ReactElement | null {
  const inputState = useInput === undefined ? undefined : useInput((state) => state)
  const imageIds: string[] = (inputState as { imageIds?: string[] } | undefined)?.imageIds ?? []
  const [modelImageCapable, setModelImageCapable] = useState<boolean | null>(null)

  useEffect(() => {
    if (sessionId === undefined || api === undefined) return
    let cancelled = false
    api.sessions.models({ sessionId }).then((response) => {
      if (cancelled) return
      const model = response.result?.current?.model
      setModelImageCapable(model === undefined ? null : modelSupportsImage(model))
    }).catch(() => {
      if (!cancelled) setModelImageCapable(null)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, api])

  // Show the hint unless the model is CONFIRMED image-capable. An unknown
  // capability (query failed, model not resolved) must still show it —
  // otherwise the user only has the native send, which the host rejects for a
  // text-only model.
  const showHint = imageIds.length > 0 && modelImageCapable !== true

  if (!showHint) return null

  return React.createElement(
    'div',
    {
      role: 'status',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 10px',
        margin: '6px 10px 0',
        borderRadius: 8,
        background: 'var(--dsw-bg-soft, rgba(128,128,128,0.12))',
        color: 'var(--dsw-text-2, #888)',
        fontSize: 12,
      },
    },
    React.createElement('span', null, t?.('interpret.banner')),
    React.createElement('span', null, t?.('interpret.hint')),
  )
}

/**
 * Client plugin body: registers the composer dock entry.
 * @param ctx - client cordis context.
 */
// Hard dependencies: the slot/locale/connection services gate `apply` until
// they are ready, and the Guard rejects their Context access without this
// declaration (the browser-half analogue of the node half's `inject`).
export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: Context): void {
  // Pragmatic loose typing at the cordis boundary: this third-party browser
  // half composes against slots/locale/connection through the runtime shapes
  // it needs, not the full package-internal prop contracts of the owning
  // plugins (which are not importable across packages).
  //
  // CRITICAL: every service method is invoked as `ctx.<svc>.<method>(...)` —
  // never destructured into a free function — because Cordis services bind
  // instance state through `this` (LocaleRuntime keeps its dictionaries on
  // `this.dicts`; slots keeps registrations on its instance). A destructured
  // method reference drops the receiver and breaks `this.dicts` at boot.
  ctx.effect(() => (
    ctx.locale.register as unknown as (
      ns: string,
      dicts: { zh: unknown; en: unknown },
    ) => () => void
  )(NS, { zh: COPY.zh, en: COPY.en }), 'uva: dictionaries')
  const t = ctx.locale.bind(NS)
  const injectSlot = (name: string, callback: () => unknown): void => {
    (ctx.slots.inject as unknown as (n: string, cb: () => unknown) => void)(name, callback)
  }
  const registerSlot = (options: object, component: unknown): (() => void) => (
    ctx.slots.register as unknown as (o: object, c: unknown) => () => void
  )(options, component)
  injectSlot('conversation.input.dock', () => registerSlot({
    name: 'conversation.input.dock',
    id: 'uva-vision-interpret',
    order: 500,
    locale: NS,
    inject: () => ({
      api: (ctx.get('connection') as { api?: unknown } | undefined)?.api,
      t,
    }),
  }, VisionInterpretDock))
}

export { modelSupportsImage }
export type { VisionDockProps }
