/**
 * Bridge modalities sync: automatically manages each bridged model's
 * `inputModalities` in settings.yaml so DSH admits image prompts.
 *
 * When a model is added to `bridgeModels`, the plugin:
 *  1. reads the model's current `input` / `inputModalities` from settings.yaml;
 *  2. if `image` is absent, appends it and sets a `_visionBridge: true` marker
 *     so the plugin can distinguish "added by bridge" from "native multimodal";
 *  3. writes the file back (atomic: temp + rename).
 *
 * When a model is removed from `bridgeModels` (or the plugin is disabled), the
 * plugin reverts: strips `image` from `input`/`inputModalities` and removes the
 * `_visionBridge` marker — leaving the model exactly as it was before.
 *
 * The marker `_visionBridge: true` is the contract: any model carrying it is
 * plugin-configured and MUST be reverted on removal.  A model that already had
 * `image` before the plugin touched it (native multimodal) never receives the
 * marker and is never reverted.
 * @module dsh-vision-analysis/modalities-sync
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// YAML subset parser/writer — minimal, zero-dependency, handles the flat
// mapping structure of settings.yaml (top-level keys → objects/arrays/strings).
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

/**
 * Minimal YAML reader for settings.yaml.  Handles:
 *  - top-level `key: value` scalars and `key: [a, b]` flow sequences
 *  - nested `- id: ...` / `  key: value` block mappings under list items
 *  - quoted and unquoted scalars, `true`/`false`/`null`
 *
 * NOT a full YAML parser — sufficient for the DSH settings file structure.
 * Falls back to returning `undefined` on any parse ambiguity so the caller
 * can skip the sync rather than corrupt the file.
 */
function parseYamlMinimal(text: string): Record<string, unknown> | undefined {
  // Delegate to structured approach: split into top-level sections by
  // unindented keys, then parse each section's body.
  // This is intentionally conservative — if the structure is unexpected,
  // return undefined so the caller skips.
  try {
    const result: Record<string, unknown> = {}
    let currentKey: string | null = null
    let currentIndent = 0
    let currentLines: string[] = []

    const flush = () => {
      if (currentKey !== null) {
        result[currentKey] = parseYamlSection(currentLines, currentIndent)
      }
      currentLines = []
    }

    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      // Skip blank lines and comments at the top level
      if (line.trim() === '' || line.trim().startsWith('#')) {
        if (currentKey !== null) currentLines.push(line)
        continue
      }
      const indent = line.search(/\S/)
      // Top-level key: indent === 0 and looks like `key:`
      if (indent === 0 && /^[\w@./-]+:/.test(line)) {
        flush()
        currentKey = line.match(/^([\w@./-]+):/)![1]!
        currentIndent = 0
        // Capture the value on the same line (if any)
        const afterColon = line.slice(line.indexOf(':') + 1).trim()
        if (afterColon !== '') {
          currentLines.push(afterColon)
        }
      } else if (currentKey !== null) {
        currentLines.push(line)
      }
    }
    flush()
    return result
  } catch {
    return undefined
  }
}

/**
 * Parse a YAML section body (everything under a top-level key) into a JS
 * value.  Handles list-of-mappings (the LLM models structure) and plain
 * mappings.
 */
function parseYamlSection(lines: string[], _baseIndent: number): unknown {
  // Filter out comment-only and blank lines for the body
  const body = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  if (body.length === 0) return undefined

  // Determine the structure: if first non-blank line starts with '-', it's a list
  const first = body[0]!
  const firstTrimmed = first.trimStart()
  if (firstTrimmed.startsWith('- ')) {
    // For lists, pass the ORIGINAL lines (preserving relative indentation)
    // so parseYamlList can distinguish same-level vs deeper '- ' lines.
    return parseYamlList(body)
  }

  // For mappings, strip common indent so keys align to indent 0
  const minIndent = Math.min(...body.map((l) => l.length - l.trimStart().length))
  const stripped = body.map((l) => (l.trim() === '' ? '' : l.slice(minIndent)))
  return parseYamlMapping(stripped, 0)
}

function parseYamlList(lines: string[]): unknown[] {
  const items: unknown[] = []
  let currentItemLines: string[] = []
  let listIndent = -1 // indent of the first '- ' line, set on first item

  const flushItem = () => {
    if (currentItemLines.length > 0) {
      // The first line starts with "- key: value" — strip the "- " prefix
      // and align the first key's indent with the rest of the item body.
      const first = currentItemLines[0]!
      const dashIdx = first.indexOf('- ')
      const rest = dashIdx >= 0 ? first.slice(dashIdx + 2) : first
      // The item's key indent = list indent + 2 (YAML increment after '- ')
      const itemKeyIndent = listIndent + 2
      const aligned = ' '.repeat(itemKeyIndent) + rest.trimStart()
      const bodyLines = [aligned, ...currentItemLines.slice(1)]
      // Strip common indent from body lines (relative to the item's key indent)
      const contentLines = bodyLines.filter((l) => l.trim() !== '')
      if (contentLines.length > 0) {
        const minIndent = Math.min(...contentLines.map((l) => l.length - l.trimStart().length))
        const stripped = bodyLines.map((l) => (l.trim() === '' ? '' : l.slice(minIndent)))
        // If the first line is a bare scalar (no colon), it's a scalar list item
        const firstTrimmed = stripped[0]!.trim()
        if (!firstTrimmed.includes(':') || firstTrimmed.startsWith('- ')) {
          items.push(parseYamlScalar(firstTrimmed))
        } else {
          items.push(parseYamlMapping(stripped, 0))
        }
      } else {
        items.push({})
      }
    }
    currentItemLines = []
  }

  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length
    if (trimmed.startsWith('- ')) {
      // Only treat as a new list item if at the same indent as the list base.
      // Deeper '- ' lines are children of the current item (e.g., block sequence
      // values of a mapping key inside the current list item).
      if (currentItemLines.length === 0) {
        // First item — set the list base indent
        listIndent = indent
        flushItem()
        currentItemLines.push(line)
      } else if (indent === listIndent) {
        // Same indent — new list item
        flushItem()
        currentItemLines.push(line)
      } else {
        // Deeper indent — child of current item (block sequence value)
        currentItemLines.push(line)
      }
    } else {
      currentItemLines.push(line)
    }
  }
  flushItem()
  return items
}

function parseYamlMapping(lines: string[], baseIndent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentKey: string | null = null
  let currentChildLines: string[] = []
  let keyIndent = baseIndent

  const flush = () => {
    if (currentKey !== null) {
      if (currentChildLines.length > 0) {
        // Detect the child indent from the first child line
        const childIndent = currentChildLines[0]!.length - currentChildLines[0]!.trimStart().length
        // Strip the common leading whitespace so children are relative to indent 0
        const stripped = currentChildLines.map((l) => {
          if (l.trim() === '') return ''
          return l.slice(childIndent)
        })
        result[currentKey] = parseYamlSection(stripped, 0)
      }
      currentChildLines = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) {
      if (currentKey !== null) currentChildLines.push(line)
      continue
    }
    const indent = line.length - line.trimStart().length
    const trimmed = line.trimStart()

    // A key at the SAME indent as baseIndent is a sibling at this level.
    // A key at a DEEPER indent is a child of the current key.
    // A key at a SHALLOWER indent belongs to a parent — stop processing.
    const keyMatch = trimmed.match(/^([\w@./_-]+):\s*(.*)/)

    if (indent === baseIndent && keyMatch) {
      // Sibling key at this level — flush previous and start new key
      flush()
      currentKey = keyMatch[1]!
      keyIndent = indent
      const value = keyMatch[2]!.trim()
      if (value !== '') {
        result[currentKey] = parseYamlScalar(value)
        currentKey = null
      }
    } else if (indent < baseIndent) {
      // Shallow indent — belongs to parent, stop
      break
    } else if (currentKey !== null) {
      // Deeper indent or non-key line — child of current key
      currentChildLines.push(line)
    }
  }
  flush()
  return result
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~' || value === '') return null
  // Flow sequence: [a, b, c] or []
  if (value === '[]') return []
  const flowSeq = value.match(/^\[(.+)\]$/)
  if (flowSeq) {
    return flowSeq[1]!.split(',').map((s) => parseYamlScalar(s.trim()))
  }
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

// ---------------------------------------------------------------------------
// YAML writer — produces the minimal output that matches settings.yaml style.
// ---------------------------------------------------------------------------

function serializeYamlValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (value === '' || /[:#{}[\],&*?|>!%@`]/.test(value) || value.startsWith('- ') || value.startsWith("'") || value.startsWith('"')) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    // Simple scalar arrays on one line
    if (value.every((v) => typeof v !== 'object' || v === null)) {
      return `[${value.map((v) => serializeYamlValue(v, 0)).join(', ')}]`
    }
    // Complex arrays as block sequences
    return '\n' + value.map((v) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const entries = Object.entries(v as Record<string, unknown>)
        if (entries.length === 0) return `${pad}  - {}`
        const first = entries[0]!
        const rest = entries.slice(1)
        let s = `${pad}  - ${first[0]}: ${serializeYamlValue(first[1], indent + 2)}`
        for (const [k, v2] of rest) {
          s += `\n${pad}    ${k}: ${serializeYamlValue(v2, indent + 2)}`
        }
        return s
      }
      return `${pad}  - ${serializeYamlValue(v, indent + 1)}`
    }).join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return '\n' + entries.map(([k, v]) => `${pad}  ${k}: ${serializeYamlValue(v, indent + 1)}`).join('\n')
  }
  return String(value)
}

function serializeYaml(data: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    const serialized = serializeYamlValue(value, 0)
    if (serialized.startsWith('\n')) {
      lines.push(`${key}:${serialized}`)
    } else {
      lines.push(`${key}: ${serialized}`)
    }
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Model modalities sync logic
// ---------------------------------------------------------------------------

const VISION_BRIDGE_MARKER = '_visionBridge'

interface ModelEntry {
  id: string
  input?: string[]
  inputModalities?: string[]
  [VISION_BRIDGE_MARKER]?: boolean
  [k: string]: unknown
}

/** Read the `input` or `inputModalities` array from a model entry. */
function getModelModalities(model: ModelEntry): string[] {
  return (model.input ?? model.inputModalities ?? []) as string[]
}

/** Set the `input` or `inputModalities` array on a model entry. */
function setModelModalities(model: ModelEntry, modalities: string[]): void {
  if ('input' in model) model.input = modalities
  else if ('inputModalities' in model) model.inputModalities = modalities
  else model.input = modalities // default to `input`
}

/**
 * Locate all model entries in a parsed settings.yaml that match a given
 * model id.  Searches all `llm-*` provider sections.
 * Returns the mutable entries (so the caller can modify them in place).
 */
function findModelEntries(settings: Record<string, unknown>, modelId: string): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith('llm') || typeof value !== 'object' || value === null) continue
    const section = value as Record<string, unknown>
    // providers: { providerName: { models: [...] } }
    const providers = section.providers as Record<string, unknown> | undefined
    if (providers && typeof providers === 'object') {
      for (const prov of Object.values(providers)) {
        if (typeof prov !== 'object' || prov === null) continue
        const models = (prov as Record<string, unknown>).models
        if (Array.isArray(models)) {
          for (const m of models) {
            if (typeof m === 'object' && m !== null && (m as ModelEntry).id === modelId) {
              entries.push(m as ModelEntry)
            }
          }
        }
      }
    }
    // Also check flat `models: [...]` at section level
    const models = section.models
    if (Array.isArray(models)) {
      for (const m of models) {
        if (typeof m === 'object' && m !== null && (m as ModelEntry).id === modelId) {
          entries.push(m as ModelEntry)
        }
      }
    }
  }
  return entries
}

/**
 * For each model in `bridgeModels`, ensure `image` is declared in its
 * inputModalities and the `_visionBridge` marker is set.  Skips models
 * that already have `image` (native multimodal — never touched).
 *
 * @returns model ids that were actually modified.
 */
export async function ensureBridgeModalities(
  settingsPath: string,
  bridgeModels: readonly string[],
  log: (msg: string) => void,
): Promise<string[]> {
  if (bridgeModels.length === 0) return []

  const text = await readFile(settingsPath, 'utf-8')
  const settings = parseYamlMinimal(text)
  if (!settings) {
    log('modalities-sync: could not parse settings.yaml — skipping auto-configure')
    return []
  }

  const modified: string[] = []
  for (const modelId of bridgeModels) {
    const entries = findModelEntries(settings, modelId)
    if (entries.length === 0) {
      // Model not found in settings — create a minimal entry? No — the model
      // must already be known to the harness.  Log and skip.
      log(`modalities-sync: model "${modelId}" not found in settings.yaml — cannot auto-configure bridge`)
      continue
    }
    for (const entry of entries) {
      const modalities = getModelModalities(entry)
      if (modalities.includes('image')) {
        // Already image-capable.  If it was added by US in a previous run,
        // the marker should already be set; if not, it's native — don't touch.
        continue
      }
      // Add image + marker
      modalities.push('image')
      setModelModalities(entry, modalities)
      entry[VISION_BRIDGE_MARKER] = true
      modified.push(modelId)
    }
  }

  if (modified.length > 0) {
    await atomicWrite(settingsPath, serializeYaml(settings))
    log(`modalities-sync: declared image input for bridge models: ${modified.join(', ')}`)
  }
  // Deduplicate: a model may appear in multiple providers
  return [...new Set(modified)]
}

/**
 * For each model in `removedModels`, revert the bridge configuration:
 * strip `image` from inputModalities and remove the `_visionBridge` marker.
 * Only touches models that carry the marker (plugin-configured, not native).
 *
 * @returns model ids that were actually reverted.
 */
export async function revertBridgeModalities(
  settingsPath: string,
  removedModels: readonly string[],
  log: (msg: string) => void,
): Promise<string[]> {
  if (removedModels.length === 0) return []

  const text = await readFile(settingsPath, 'utf-8')
  const settings = parseYamlMinimal(text)
  if (!settings) {
    log('modalities-sync: could not parse settings.yaml — skipping revert')
    return []
  }

  const reverted: string[] = []
  for (const modelId of removedModels) {
    const entries = findModelEntries(settings, modelId)
    for (const entry of entries) {
      if (!entry[VISION_BRIDGE_MARKER]) continue // not plugin-configured
      const modalities = getModelModalities(entry)
      const filtered = modalities.filter((m) => m !== 'image')
      setModelModalities(entry, filtered)
      delete entry[VISION_BRIDGE_MARKER]
      reverted.push(modelId)
    }
  }

  if (reverted.length > 0) {
    await atomicWrite(settingsPath, serializeYaml(settings))
    log(`modalities-sync: reverted image input for: ${reverted.join(', ')}`)
  }
  return [...new Set(reverted)]
}

/**
 * Revert ALL models that carry the `_visionBridge` marker — used when the
 * plugin is disabled or uninstalled.
 */
export async function revertAllBridgeModalities(
  settingsPath: string,
  log: (msg: string) => void,
): Promise<string[]> {
  const text = await readFile(settingsPath, 'utf-8')
  const settings = parseYamlMinimal(text)
  if (!settings) return []

  const reverted: string[] = []

  // Scan every model entry in every llm-* section
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith('llm') || typeof value !== 'object' || value === null) continue
    const section = value as Record<string, unknown>
    const scanModels = (models: unknown) => {
      if (!Array.isArray(models)) return
      for (const m of models) {
        if (typeof m !== 'object' || m === null) continue
        const entry = m as ModelEntry
        if (!entry[VISION_BRIDGE_MARKER]) continue
        const modalities = getModelModalities(entry)
        const filtered = modalities.filter((mod) => mod !== 'image')
        setModelModalities(entry, filtered)
        const id = entry.id ?? 'unknown'
        delete entry[VISION_BRIDGE_MARKER]
        reverted.push(id as string)
      }
    }
    const providers = section.providers
    if (providers && typeof providers === 'object') {
      for (const prov of Object.values(providers as Record<string, unknown>)) {
        if (typeof prov === 'object' && prov !== null) {
          scanModels((prov as Record<string, unknown>).models)
        }
      }
    }
    scanModels(section.models)
  }

  if (reverted.length > 0) {
    await atomicWrite(settingsPath, serializeYaml(settings))
    log(`modalities-sync: reverted all bridge modalities: ${reverted.join(', ')}`)
  }
  return [...new Set(reverted)]
}

// ---------------------------------------------------------------------------
// Atomic file write (temp + rename)
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = join(tmpdir(), `uva-settings-${randomBytes(6).toString('hex')}.yaml`)
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, filePath)
}
