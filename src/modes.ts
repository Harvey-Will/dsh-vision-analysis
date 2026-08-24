/**
 * The eight analysis modes of the `analyze_image` tool: their identifiers,
 * per-mode output tuning defaults, and the instruction templates the vision
 * model receives when the caller does not supply a custom `prompt`.
 * @module dsh-vision-analysis/modes
 */

/** The eight analysis modes offered by the tool. */
export type VisionMode =
  | 'describe'
  | 'ocr'
  | 'ui-review'
  | 'chart-data'
  | 'object-detect'
  | 'compare'
  | 'code-gen'
  | 'debug'

/** All mode identifiers in catalog order (also the schema `enum` order). */
export const VISION_MODES: readonly VisionMode[] = [
  'describe',
  'ocr',
  'ui-review',
  'chart-data',
  'object-detect',
  'compare',
  'code-gen',
  'debug',
]

/** Output tuning a caller or deployment may override per mode. */
export interface ModeTuning {
  /** Maximum output tokens the vision model may produce for this mode. */
  maxTokens?: number
  /** Sampling temperature for this mode. */
  temperature?: number
}

/**
 * Default per-mode output tuning. `ocr` and `chart-data` use temperature 0 for
 * maximum fidelity; `code-gen` allows the largest token budget because a UI
 * reconstruction can be long.
 */
export const MODE_TUNING_DEFAULTS: Readonly<Record<VisionMode, ModeTuning>> = {
  describe: { maxTokens: 4096, temperature: 0.7 },
  ocr: { maxTokens: 4096, temperature: 0.0 },
  'ui-review': { maxTokens: 4096, temperature: 0.5 },
  'chart-data': { maxTokens: 4096, temperature: 0.0 },
  'object-detect': { maxTokens: 4096, temperature: 0.5 },
  compare: { maxTokens: 4096, temperature: 0.5 },
  'code-gen': { maxTokens: 4096, temperature: 0.3 },
  debug: { maxTokens: 4096, temperature: 0.7 },
}

/** One-line human label per mode, used in the tool schema and call cards. */
export const MODE_LABELS: Readonly<Record<VisionMode, string>> = {
  describe: 'Describe',
  ocr: 'OCR',
  'ui-review': 'UI review',
  'chart-data': 'Chart data',
  'object-detect': 'Object detection',
  compare: 'Compare',
  'code-gen': 'Code generation',
  debug: 'Debug',
}

/**
 * Default instruction templates. Each template asks for the same language as
 * the surrounding conversation rather than hard-coding one. The templates
 * reference the image(s) already attached by the caller; `{count}` is the
 * number of images in the call and is substituted by the caller.
 */
export const MODE_PROMPTS: Readonly<Record<VisionMode, string>> = {
  describe:
    'Describe the image(s) in detail: subject, colors and style, any visible text, '
    + 'key details, composition, and overall impression. '
    + 'Respond in the same language as the conversation.',
  ocr:
    'Transcribe all text in the image(s) exactly as written, preserving line breaks '
    + 'and original structure. Do not summarize, correct, or translate the text. '
    + 'Report the approximate line and character counts at the end. '
    + 'Respond in the same language as the conversation.',
  'ui-review':
    'Review the UI shown in the image(s) as a designer: layout, spacing, alignment, '
    + 'color contrast, typography, visual hierarchy, and responsiveness. '
    + 'List strengths, concrete issues, and a prioritized fix for each issue, '
    + 'then give an overall score out of 10. '
    + 'Respond in the same language as the conversation.',
  'chart-data':
    'Extract the data shown in the chart(s) or graph(s): title, axis labels, legend, '
    + 'and every data point as a table. Describe the overall trend in one short '
    + 'paragraph. If any value is ambiguous, say so instead of guessing. '
    + 'Respond in the same language as the conversation.',
  'object-detect':
    'Identify the objects, people, or activities visible in the image(s). '
    + 'List each element with its approximate location (e.g. top-left, center, '
    + 'bottom-right) and a one-line description, then give the total count. '
    + 'Respond in the same language as the conversation.',
  compare:
    'Compare the {count} images side by side: subject, colors, text, layout, and '
    + 'any other relevant aspect. Present a comparison table, then list the key '
    + 'differences and a short conclusion. '
    + 'Respond in the same language as the conversation.',
  'code-gen':
    'Generate HTML + CSS that recreates the UI shown in the image(s) as faithfully '
    + 'as possible. Output the code in a single fenced html block, then list layout '
    + 'and responsiveness notes. '
    + 'Respond in the same language as the conversation.',
  debug:
    'Run a connectivity diagnostic for the vision endpoint used by this tool and '
    + 'report the resolved configuration, endpoint, HTTP status, latency, and a '
    + 'masked response excerpt, with a pass/fail verdict for each check.',
}

/**
 * Resolve the effective output tuning for one mode: a per-mode override from
 * configuration when present, otherwise the built-in per-mode default.
 * @param mode - the selected analysis mode.
 * @param global - deployment-wide defaults (fallbacks when a mode lacks an override).
 * @param overrides - per-mode configuration overrides, keyed by mode.
 * @returns the effective maxTokens and temperature.
 */
export function resolveTuning(
  mode: VisionMode,
  global: { maxTokens: number; temperature: number },
  overrides: Readonly<Partial<Record<VisionMode, ModeTuning>>>,
): { maxTokens: number; temperature: number } {
  const builtIn = MODE_TUNING_DEFAULTS[mode]
  const override = overrides[mode]
  return {
    maxTokens: override?.maxTokens ?? builtIn?.maxTokens ?? global.maxTokens,
    temperature: override?.temperature ?? builtIn?.temperature ?? global.temperature,
  }
}

/**
 * Compose the final instruction for a call: the caller's custom `prompt` when
 * given, otherwise the mode template with `{count}` substituted.
 * @param mode - the selected analysis mode.
 * @param imageCount - number of images in the call.
 * @param customPrompt - caller-supplied instruction, when present.
 * @returns the text prompt sent to the vision model.
 */
export function composePrompt(mode: VisionMode, imageCount: number, customPrompt?: string): string {
  if (customPrompt !== undefined && customPrompt.trim() !== '') return customPrompt
  return MODE_PROMPTS[mode].replace('{count}', String(imageCount))
}
