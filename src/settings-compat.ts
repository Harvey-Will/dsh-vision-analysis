/**
 * Harness-version compatibility shim for settings section registration.
 *
 * Three API generations, detected at runtime:
 *  1. `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`
 *     (0.1.2–0.1.5): method on the settings service.
 *  2. Standalone `installSettingsSection(ctx, ns, schema, entry, hooks)`
 *     (≤0.1.2-alpha.5): module-level function.
 *  3. `SettingsForms` (0.1.7+): schema is auto-discovered from the plugin's
 *     `Config` export — no explicit registration needed. Config lives in the
 *     profile patch (cordis.patch.yml). The shim wires a lazy config reader
 *     via `describe()` and attempts best-effort change notification.
 *
 * Node ESM named imports of a missing export throw at link time, so this
 * shim resolves the API at runtime instead of importing either name.
 * @module dsh-vision-analysis/settings-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'

/** Hooks accepted by all API generations. */
export interface SectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?: (value: T) => void
}

/**
 * Register a settings section on whichever API this Harness version exposes.
 * @param ctx - the consumer context (our plugin context).
 * @param ns - lowercase-hyphenated settings namespace (profile entry id).
 * @param schema - schemastery schema describing the section.
 * @param entry - the composition entry value.
 * @param hooks - setSource / onChange / optional validate.
 * @throws when no API generation is available (unsupported Harness).
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: string,
  schema: unknown,
  entry: T,
  hooks: SectionHooks<T>,
): void {
  // ── Generation 1 (0.1.2–0.1.5): SettingsProvider.installSection ──────────
  const provider = ctx.settings as unknown as {
    installSection?: (owner: Context, ns: string, schema: unknown, entry: T, hooks: SectionHooks<T>) => void
  }
  if (typeof provider?.installSection === 'function') {
    provider.installSection(ctx, ns, schema, entry, hooks)
    return
  }

  // ── Generation 2 (≤0.1.2-alpha.5): standalone module function ────────────
  const legacy = (dshSettings as unknown as {
    installSettingsSection?: (ctx: Context, ns: string, schema: unknown, entry: T, hooks: SectionHooks<T>) => void
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, ns, schema, entry, hooks)
    return
  }

  // ── Generation 3 (0.1.7+): SettingsForms — schema auto-discovered ────────
  // The forms system reads the plugin's Config export from the profile; no
  // explicit registration is needed.  We only wire a lazy config reader and
  // best-effort change notification so `current()` always returns the live
  // value from the profile patch.
  const forms = ctx.settings as unknown as {
    describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; value?: unknown }>
  }
  if (typeof forms?.describe === 'function') {
    hooks.setSource(() => {
      const descriptors = forms.describe!({ redactSecrets: true })
      const desc = descriptors.find((d) => d.ns === ns)
      return (desc?.value ?? entry) as T
    })
    // Best-effort change notification: `settings/updated` may not exist in
    // every 0.1.x build; if it does, trigger onChange on updates.  Wrapped
    // so a missing event never breaks plugin boot.
    try {
      ctx.effect(
        () => (ctx.on as (ev: string, cb: () => void) => () => void)('settings/updated', () => hooks.onChange()),
        'uva: settings change listener',
      )
    } catch { /* event unavailable — config changes take effect on next call */ }
    return
  }

  throw new Error('no settings section API on this Harness version (installSection / installSettingsSection / SettingsForms all missing)')
}
