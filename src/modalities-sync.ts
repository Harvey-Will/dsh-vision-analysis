/**
 * Bridge modalities sync — SURGICAL text editing of settings.yaml.
 *
 * LESSON LEARNED (twice now): never rewrite a whole config file through a
 * parse→serialize round trip.  A partial parser silently drops what it does
 * not understand (providers, comments, field variants), and the write-back
 * corrupts the user's configuration.
 *
 * This module therefore edits the RAW TEXT only:
 *  1. locate the target model's entry block (`- id: <modelId>` … until the
 *     next list item / dedent),
 *  2. within that block, add or remove the `image` modality line and the
 *     `_visionBridge: true` marker line,
 *  3. write the file back with every other byte untouched.
 *
 * A timestamped backup (settings.yaml.bak-uva-<ts>) is written before every
 * modification, so any regression is user-recoverable.
 * @module dsh-vision-analysis/modalities-sync
 */

import { readFile, writeFile, rename, copyFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const VISION_BRIDGE_MARKER = '_visionBridge: true'

// ---------------------------------------------------------------------------
// Text-level entry block location
// ---------------------------------------------------------------------------

interface EntryBlock {
  /** Full text of the entry, from the `- ` line through the last content line. */
  text: string
  /** Index (in lines) where the entry starts. */
  startLine: number
  /** Index (in lines) one past the entry's last content line. */
  endLine: number
  /** Indent (spaces) of the `- ` line. */
  dashIndent: number
}

/** Indent (space count) of a line; blank lines return -1. */
function indentOf(line: string): number {
  if (line.trim() === '') return -1
  return line.length - line.trimStart().length
}

/**
 * Compute the exclusive end line of the entry block starting at `startLine`
 * (a `- id:` line with `dashIndent` indent).
 */
function blockEnd(lines: string[], startLine: number, dashIndent: number): number {
  let end = startLine + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.trim() === '') { end++; continue } // blank — tentatively inside
    const ind = indentOf(line)
    if (ind < dashIndent) break                        // dedent → section end
    if (ind === dashIndent && line.trimStart().startsWith('- ')) break // next item
    end++
  }
  // Trim trailing blank lines out of the block
  while (end > startLine + 1 && lines[end - 1]!.trim() === '') end--
  return end
}

/**
 * Find the entry block for `modelId` in the raw lines.  An entry starts at a
 * `- id: <modelId>` list line and extends until the next line that is a list
 * item (`- `) at the same indent, or any line at a shallower indent
 * (section boundary).  `fromLine` limits the search start (for finding
 * subsequent occurrences of the same id).  Returns null when not found.
 */
function findEntryBlock(lines: string[], modelId: string, fromLine = 0): EntryBlock | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const startRe = new RegExp(`^( *)- id: ?["']?${escaped}["']?\\s*$`)

  for (let i = fromLine; i < lines.length; i++) {
    const m = lines[i]!.match(startRe)
    if (m === null) continue
    const dashIndent = m[1]!.length
    const end = blockEnd(lines, i, dashIndent)
    return { text: lines.slice(i, end).join('\n'), startLine: i, endLine: end, dashIndent }
  }
  return null
}

/**
 * Whether the entry block declares `image` in its modalities.
 * Handles both flow style (`inputModalities: [ text, image ]`) and block
 * style (a `input:`/`inputModalities:` key whose following `- ` lines are
 * indented deeper than the key).
 */
function blockDeclaresImage(block: EntryBlock): boolean {
  const lines = block.text.split('\n')
  const modKeyRe = /^( *)(input|inputModalities):(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(modKeyRe)
    if (m === null) continue
    const inline = m[3]!.trim()
    if (inline !== '') {
      // Flow style: [ text, image ] / [image] / []
      return /\bimage\b/.test(inline)
    }
    // Block style: subsequent `- x` lines at the key's indent or deeper
    // (YAML allows sequence items at the same indent as their parent key)
    const keyIndent = m[1]!.length
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l.trim() === '') continue
      const ind = indentOf(l)
      const t = l.trim()
      if (t.startsWith('- ') && ind >= keyIndent) {
        if (/\bimage\b/.test(t.slice(2))) return true
      } else if (ind <= keyIndent) {
        break // next key or dedent — modalities list ended
      } else {
        break // deeper non-item line — unexpected, treat as end
      }
    }
  }
  return false
}

/** Whether the entry block carries the plugin's marker. */
function blockHasMarker(block: EntryBlock): boolean {
  return block.text.split('\n').some((l) => l.trim() === VISION_BRIDGE_MARKER)
}

// ---------------------------------------------------------------------------
// Edits (pure text → text)
// ---------------------------------------------------------------------------

/**
 * Add `image` to the entry's modalities and append the marker line.
 * Flow style → rewrite the bracket content; block style → insert a
 * `- image` line after the last modality item; no modalities key →
 * create block-style lines matching the entry's key indent.
 */
function addImageAndMarker(block: EntryBlock): string {
  const lines = block.text.split('\n')
  const modKeyRe = /^( *)(input|inputModalities):(.*)$/
  let modKeyIdx = -1
  let modKeyIndent = -1
  let modInline = ''
  let lastModItemIdx = -1 // last `- x` line of the block-style modality list

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(modKeyRe)
    if (m !== null) {
      modKeyIdx = i
      modKeyIndent = m[1]!.length
      modInline = m[3]!.trim()
      lastModItemIdx = -1
      continue
    }
    if (modKeyIdx !== -1 && modInline === '') {
      const t = lines[i]!.trim()
      const ind = indentOf(lines[i]!)
      if (t.startsWith('- ') && ind >= modKeyIndent) lastModItemIdx = i
      else if (ind <= modKeyIndent && t !== '') break
    }
  }

  if (modKeyIdx === -1) {
    // No modalities key — add `inputModalities:` block with image.
    const keyIndent = ' '.repeat(block.dashIndent + 2)
    lines.push(`${keyIndent}inputModalities:`)
    lines.push(`${keyIndent}  - image`)
  } else if (modInline !== '') {
    // Flow style — rewrite bracket content preserving order
    const inner = modInline.replace(/^\[/, '').replace(/\]$/, '').trim()
    const items = inner === '' ? [] : inner.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (!items.includes('image')) items.push('image')
    const keyName = lines[modKeyIdx]!.trimStart().split(':')[0]!
    lines[modKeyIdx] = `${' '.repeat(modKeyIndent)}${keyName}: [ ${items.join(', ')} ]`
  } else if (lastModItemIdx !== -1) {
    // Block style — insert `- image` after the last item, matching its indent
    const itemIndent = indentOf(lines[lastModItemIdx]!)
    lines.splice(lastModItemIdx + 1, 0, `${' '.repeat(itemIndent)}- image`)
  } else {
    // Key exists with empty block value (malformed) — add item under it
    lines.splice(modKeyIdx + 1, 0, `${' '.repeat(modKeyIndent + 2)}- image`)
  }

  if (!lines.some((l) => l.trim() === VISION_BRIDGE_MARKER)) {
    lines.push(`${' '.repeat(block.dashIndent + 2)}${VISION_BRIDGE_MARKER}`)
  }
  return lines.join('\n')
}

/**
 * Remove the plugin-added `image` modality and the marker line.
 * Only removes ONE `image` item (the last in the modality list) and only
 * when the marker is present — native multimodal entries never carry it.
 */
function removeImageAndMarker(block: EntryBlock): string {
  const lines = block.text.split('\n')
  // Remove the marker line first
  const markerIdx = lines.findIndex((l) => l.trim() === VISION_BRIDGE_MARKER)
  if (markerIdx === -1) return block.text
  lines.splice(markerIdx, 1)

  // Remove the last `- image` line inside a modality sub-block
  const modKeyRe = /^( *)(input|inputModalities):(.*)$/
  let modKeyIdx = -1
  let modKeyIndent = -1
  let modInline = ''
  let lastImageItemIdx = -1

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(modKeyRe)
    if (m !== null) {
      modKeyIdx = i
      modKeyIndent = m[1]!.length
      modInline = m[3]!.trim()
      lastImageItemIdx = -1
      continue
    }
    if (modKeyIdx !== -1 && modInline === '') {
      const t = lines[i]!.trim()
      const ind = indentOf(lines[i]!)
      if (t.startsWith('- ') && ind >= modKeyIndent) {
        // Sequence item — check if it's the image we want to remove.
        if (/\bimage\b/.test(t.slice(2))) lastImageItemIdx = i
        // Either way, continue scanning (there may be more items after).
      } else if (ind <= modKeyIndent && t !== '') {
        break // next key or dedent — modalities list ended
      }
    }
  }

  if (modKeyIdx !== -1 && modInline !== '') {
    // Flow style — remove 'image' from the bracket content
    const inner = modInline.replace(/^\[/, '').replace(/\]$/, '').trim()
    const items = inner === '' ? [] : inner.split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== 'image')
    const keyName = lines[modKeyIdx]!.trimStart().split(':')[0]!
    if (items.length === 0) {
      // Keep the key with an empty array — removing it changes semantics
      // (no input declared vs empty input declared).
      lines[modKeyIdx] = `${' '.repeat(modKeyIndent)}${keyName}: []`
    } else {
      lines[modKeyIdx] = `${' '.repeat(modKeyIndent)}${keyName}: [ ${items.join(', ')} ]`
    }
  } else if (lastImageItemIdx !== -1) {
    lines.splice(lastImageItemIdx, 1)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// File-level operations (read → patch lines → backup → verify → atomic write)
// ---------------------------------------------------------------------------

const BACKUP_KEEP_COUNT = 5

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = join(tmpdir(), `uva-settings-${randomBytes(6).toString('hex')}.yaml`)
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, filePath)
}

async function backupFile(filePath: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(dirname(filePath), `settings.yaml.bak-uva-${ts}`)
  await copyFile(filePath, backupPath)
  return backupPath
}

/**
 * Post-write integrity check.  Reads the written file back and verifies:
 *  1. the file is non-empty and contains expected top-level keys,
 *  2. no corrupted empty-object strings (`: "{}"` instead of `: {}`).
 *
 * Returns `null` if valid, or a human-readable reason if corrupted.
 */
async function verifyIntegrity(
  filePath: string,
  originalText: string,
): Promise<string | null> {
  let written: string
  try {
    written = await readFile(filePath, 'utf-8')
  } catch (err) {
    return `file unreadable after write: ${err}`
  }
  if (written.length === 0) return 'file is empty after write'
  // Extract top-level keys from the original and verify they survived.
  const origKeys = [...originalText.matchAll(/^([\w@./-]+):/gm)].map((m) => m[1])
  for (const key of origKeys) {
    const escaped = key!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^${escaped}:`, 'm').test(written)) {
      return `top-level key "${key}" was dropped during write`
    }
  }
  // Detect the known corruption pattern: empty objects written as quoted strings.
  const corruptedEmpties = (written.match(/: "{}"/g) || []).length
  const origEmpties = (originalText.match(/: "{}"/g) || []).length
  if (corruptedEmpties > origEmpties) {
    return `empty-object corruption detected (${origEmpties} → ${corruptedEmpties} occurrences of ": \\"{}\\"")`
  }
  return null
}

/**
 * Keep only the most recent `keep` backup files matching `settings.yaml.bak-uva-*`.
 */
async function cleanupBackups(dir: string, keep: number): Promise<void> {
  try {
    const entries = await readdir(dir)
    const backups = entries
      .filter((e) => e.startsWith('settings.yaml.bak-uva-'))
      .sort()
      .reverse() // newest first
    for (const old of backups.slice(keep)) {
      await unlink(join(dir, old)).catch(() => {})
    }
  } catch { /* best-effort — directory might not be readable */ }
}

/**
 * Patch the raw text for the given models.  `edit` returns the replacement
 * entry text, or null to leave the entry untouched.  After writing, the
 * file is re-read and verified; on any integrity failure the backup is
 * restored automatically.
 */
async function patchEntries(
  settingsPath: string,
  modelIds: readonly string[],
  edit: (block: EntryBlock) => string | null,
  log: (msg: string) => void,
): Promise<string[]> {
  if (modelIds.length === 0) return []
  const text = await readFile(settingsPath, 'utf-8')
  const lines = text.split('\n')
  const touched: string[] = []

  for (const modelId of modelIds) {
    let searchFrom = 0
    for (;;) {
      const block = findEntryBlock(lines, modelId, searchFrom)
      if (block === null) {
        if (searchFrom === 0) log(`model "${modelId}" not found in settings.yaml — skipping`)
        break
      }
      searchFrom = block.endLine
      const replacement = edit(block)
      if (replacement === null) continue
      const newLines = replacement.split('\n')
      lines.splice(block.startLine, block.endLine - block.startLine, ...newLines)
      searchFrom = block.startLine + newLines.length
      touched.push(modelId)
    }
  }

  if (touched.length > 0) {
    const backupPath = await backupFile(settingsPath)
    await atomicWrite(settingsPath, lines.join('\n'))

    // P1-2: post-write integrity verification — auto-rollback on failure.
    const issue = await verifyIntegrity(settingsPath, text)
    if (issue !== null) {
      log(`INTEGRITY CHECK FAILED: ${issue} — rolling back from backup`)
      await copyFile(backupPath, settingsPath)
      return []
    }

    log(`settings.yaml updated for: ${[...new Set(touched)].join(', ')} (backup written)`)

    // P1-3: clean up old backups (keep only the most recent N).
    await cleanupBackups(dirname(settingsPath), BACKUP_KEEP_COUNT)
  }
  return [...new Set(touched)]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure every model in `bridgeModels` declares `image` input, marked with
 * `_visionBridge: true`.  Native multimodal models (already had `image`,
 * no marker) are left untouched.  A backup is written before modification.
 * @returns model ids that were actually modified (deduplicated).
 */
export async function ensureBridgeModalities(
  settingsPath: string,
  bridgeModels: readonly string[],
  log: (msg: string) => void,
): Promise<string[]> {
  return patchEntries(settingsPath, bridgeModels, (block) => {
    if (blockHasMarker(block)) return null            // already configured by us
    if (blockDeclaresImage(block)) return null        // native multimodal
    return addImageAndMarker(block)
  }, log)
}

/**
 * Revert plugin-added image support for the given models (marker-gated).
 * @returns model ids that were actually reverted (deduplicated).
 */
export async function revertBridgeModalities(
  settingsPath: string,
  removedModels: readonly string[],
  log: (msg: string) => void,
): Promise<string[]> {
  return patchEntries(settingsPath, removedModels, (block) => {
    if (!blockHasMarker(block)) return null           // not plugin-configured
    return removeImageAndMarker(block)
  }, log)
}

/**
 * Revert EVERY entry carrying the `_visionBridge` marker — used when the
 * plugin is disabled or uninstalled.
 * @returns model ids that were actually reverted (deduplicated).
 */
export async function revertAllBridgeModalities(
  settingsPath: string,
  log: (msg: string) => void,
): Promise<string[]> {
  const text = await readFile(settingsPath, 'utf-8')
  const lines = text.split('\n')
  const touched: string[] = []
  // Collect patches against the ORIGINAL array first, then apply bottom-up —
  // splicing while scanning shifts indices and silently skips later entries.
  const patches: Array<{ start: number; end: number; replacement: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^( *)- id: ?["']?([\w@./-]+)["']?\s*$/)
    if (m === null) continue
    const dashIndent = m[1]!.length
    const end = blockEnd(lines, i, dashIndent)
    const block: EntryBlock = {
      text: lines.slice(i, end).join('\n'),
      startLine: i,
      endLine: end,
      dashIndent,
    }
    if (!blockHasMarker(block)) continue
    patches.push({ start: i, end, replacement: removeImageAndMarker(block) })
    touched.push(m[2]!)
  }

  if (patches.length > 0) {
    for (const p of patches.reverse()) {
      const newLines = p.replacement.split('\n')
      lines.splice(p.start, p.end - p.start, ...newLines)
    }
    await backupFile(settingsPath)
    await atomicWrite(settingsPath, lines.join('\n'))
    log(`reverted all bridge modalities: ${[...new Set(touched)].join(', ')} (backup written)`)
  }
  return [...new Set(touched)]
}
