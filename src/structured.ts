/**
 * Structured output for the data-heavy analysis modes: per-mode JSON shape
 * instructions appended to the vision prompt, tolerant extraction of the JSON
 * object from the model's answer, and a light shape check so callers can trust
 * the `data` field they receive.
 *
 * The feature degrades gracefully: when the endpoint rejects the
 * `response_format` parameter or the answer is not parseable, the caller just
 * gets plain text and no `data` field — exactly the pre-structured behavior.
 * @module dsh-vision-analysis/structured
 */

import type { VisionMode } from './modes.js'

/** Modes that support structured output. */
export const STRUCTURED_MODES: readonly VisionMode[] = ['chart-data', 'ocr']

/**
 * Whether structured output applies to this mode.
 * @param mode - the selected analysis mode.
 */
export function isStructuredMode(mode: VisionMode): boolean {
  return (STRUCTURED_MODES as readonly string[]).includes(mode)
}

/**
 * The JSON-shape instruction for one mode: tells the vision model to answer
 * with a single JSON object carrying exactly the documented keys, no prose
 * and no code fences. Appended after the mode template or custom prompt.
 * @param mode - a structured-capable mode.
 * @returns the instruction text.
 */
export function structuredInstruction(mode: VisionMode): string {
  if (mode === 'ocr') {
    return [
      'Return ONLY a single valid JSON object with exactly these keys:',
      '"language" (BCP-47 code of the dominant text language, or "" when unknown),',
      '"lines" (array of strings, one entry per transcribed line, in reading order),',
      '"uncertain" (array of strings naming illegible or ambiguous segments; empty array when none).',
      'No markdown, no code fences, no commentary before or after the object.',
    ].join(' ')
  }
  // chart-data
  return [
    'Return ONLY a single valid JSON object with exactly these keys:',
    '"title" (chart title string, or "" when none),',
    '"columns" (array of column-name strings),',
    '"rows" (array of arrays aligned with "columns"; write numbers as JSON numbers, not strings),',
    '"trend" (one-sentence description of the overall trend),',
    '"uncertain" (array of strings listing ambiguous or unreadable values; empty array when none).',
    'No markdown, no code fences, no commentary before or after the object.',
  ].join(' ')
}

/**
 * Append the structured-output instruction to a composed prompt.
 * @param prompt - the mode template or caller's custom instruction.
 * @param mode - a structured-capable mode.
 * @returns the extended prompt.
 */
export function appendStructured(prompt: string, mode: VisionMode): string {
  return `${prompt}\n\n${structuredInstruction(mode)}`
}

/**
 * Extract the first JSON object embedded in an answer: strips markdown code
 * fences and surrounding prose, then parses the outermost `{...}` span.
 * @param text - the raw answer text from the vision model.
 * @returns the parsed value, or `undefined` when nothing parseable is found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  let body = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fenced?.[1] !== undefined) body = fenced[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRowArray(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row))
}

/**
 * Light shape validation for one parsed answer. Checks that the keys promised
 * by the instruction exist with plausible types; extra keys are tolerated.
 * @param mode - the structured mode the answer came from.
 * @param data - the parsed JSON object.
 * @returns true when the shape matches the mode's contract.
 */
export function isValidShape(mode: VisionMode, data: Record<string, unknown>): boolean {
  if (mode === 'ocr') {
    // "lines" is the one key that must be present and correct; language and
    // uncertain are optional but must be well-typed when present.
    return isStringArray(data.lines)
      && (data.language === undefined || typeof data.language === 'string')
      && (data.uncertain === undefined || isStringArray(data.uncertain))
  }
  // chart-data
  return typeof data.title === 'string'
    && isStringArray(data.columns)
    && isRowArray(data.rows)
    && typeof data.trend === 'string'
    && (data.uncertain === undefined || isStringArray(data.uncertain))
}
