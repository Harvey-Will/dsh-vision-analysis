/**
 * Browser half of dsh-universal-vision-analysis: a `conversation.input.dock`
 * entry that gives the Web UI a paste-image fallback for models that cannot
 * take image input.
 *
 * Flow: when the composer holds draft images and the session's current model
 * is NOT in the built-in image-capable list, the entry renders a banner with
 * an "interpret and send" action. The action compresses each draft image on a
 * canvas, appends an `analyze_image` instruction carrying the image as base64
 * data URLs to the draft, removes the draft images, and submits — so the agent
 * calls the plugin's host-side tool and the interpretation text enters the
 * conversation instead of the model being asked for image input it cannot
 * accept. When the model is image-capable, the entry renders nothing and the
 * native image send path is untouched.
 *
 * Deliberately dependency-light: the entry reads input state and actions
 * through the standard composer provide channel (`useInput` + `inputActions`),
 * resolves the current model through the shared API client, and collaborates
 * with the host half only through the `analyze_image` tool itself — no custom
 * client→host RPC is registered.
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
    'interpret.banner': '当前模型不支持图片，粘贴的图片将由 analyze_image 解读后发送',
    'interpret.action': '用 analyze_image 解读并发送',
    'interpret.busy': '正在解读图片…',
    'interpret.error': '图片解读失败：{message}',
    'interpret.instruction': '请调用 analyze_image 工具，用 mode=describe 解析下面这张图片，并告诉我图片里有什么：',
  },
  en: {
    'interpret.banner': 'The current model cannot take images; pasted images will be interpreted by analyze_image',
    'interpret.action': 'Interpret with analyze_image and send',
    'interpret.busy': 'Interpreting image…',
    'interpret.error': 'Image interpretation failed: {message}',
    'interpret.instruction': 'Use the analyze_image tool with mode=describe to analyze this image and tell me what it shows:',
  },
}

/**
 * Model ids that natively accept image input. Prefix matching, lowercase.
 * A model on this list sends pasted images through the native path; any other
 * model falls back to the analyze_image interpretation path.
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

/**
 * Compress one image file to a base64 data URL. GIFs and PNGs keep their
 * format; everything else is re-encoded as JPEG so the payload stays small
 * enough to travel inside a text prompt.
 * @param file - the browser image file.
 * @returns a `data:image/...;base64,` URL.
 */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const MAX_DIM = 1280
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    if (file.type === 'image/png' || file.type === 'image/gif') {
      return canvas.toDataURL('image/png')
    }
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    bitmap.close()
  }
}

/** Minimal structural contracts; the runtime injects the real objects. */
interface DraftAttachment {
  readonly id: string
  readonly file: File
}

interface VisionDockProps {
  sessionId?: string
  /** Composer input state, provided to every session-scope entry. */
  useInput?: (selector: (state: unknown) => unknown) => unknown
  /** Composer actions, provided to every session-scope entry. */
  inputActions?: {
    setDraft(text: string): void
    removeImage(id: string): void
    submit(): void
  }
  /** Injectable: the shared conversation controller (draft images). */
  conversation?: { draftImages(ids: readonly string[]): readonly DraftAttachment[] }
  /** Injectable: the shared API client (current model resolution). */
  api?: {
    sessions: {
      models(request: { sessionId: string }): Promise<{ result?: { current?: { model?: string } } }>
    }
  }
  /** Injectable: bound translator for this namespace. */
  t?: (key: string, params?: Record<string, string>) => string
}

/** The composer dock entry that offers the interpretation fallback. */
function VisionInterpretDock({
  sessionId, useInput, inputActions, conversation, api, t,
}: VisionDockProps): React.ReactElement | null {
  const inputState = useInput === undefined ? undefined : useInput((state) => state)
  const imageIds: string[] = (inputState as { imageIds?: string[] } | undefined)?.imageIds ?? []
  const draft: string = (inputState as { draft?: string } | undefined)?.draft ?? ''
  const [modelImageCapable, setModelImageCapable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const showFallback = imageIds.length > 0 && modelImageCapable === false && !busy

  const onInterpret = async (): Promise<void> => {
    if (inputActions === undefined || conversation === undefined || t === undefined) return
    setBusy(true)
    setError(null)
    try {
      const attachments = conversation.draftImages(imageIds)
      const dataUrls = await Promise.all(attachments.map((attachment) => fileToDataUrl(attachment.file)))
      const instruction = `${t('interpret.instruction')}\n\n${dataUrls.join('\n\n')}`
      inputActions.setDraft(draft === '' ? instruction : `${draft}\n\n${instruction}`)
      for (const id of imageIds) inputActions.removeImage(id)
      inputActions.submit()
    } catch (error) {
      setError(t('interpret.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  if (!showFallback && error === null) return null

  const bannerText = busy ? t?.('interpret.busy') : error ?? t?.('interpret.banner')
  return React.createElement(
    'div',
    {
      role: 'status',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        margin: '6px 10px 0',
        borderRadius: 8,
        background: 'var(--dsw-bg-soft, rgba(128,128,128,0.12))',
        color: 'var(--dsw-text-2, #888)',
        fontSize: 12,
      },
    },
    React.createElement('span', { style: { flex: 1 } }, bannerText),
    showFallback
      ? React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => { void onInterpret() },
          style: {
            border: 'none',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
            background: 'var(--dsw-accent, #3b82f6)',
            color: '#fff',
            fontSize: 12,
          },
        },
        t?.('interpret.action'),
      )
      : null,
  )
}

/**
 * Client plugin body: registers the composer dock entry.
 * @param ctx - client cordis context.
 */
// Hard dependencies: the slot/locale/connection services gate `apply` until
// they are ready, and the Guard rejects their Context access without this
// declaration (the browser-half analogue of the node half's `inject`).
export const inject = ['slots', 'locale', 'connection', 'conversation']

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
      conversation: ctx.get('conversation'),
      api: (ctx.get('connection') as { api?: unknown } | undefined)?.api,
      t,
    }),
  }, VisionInterpretDock))
}

export { modelSupportsImage, fileToDataUrl }
export type { DraftAttachment, VisionDockProps }
