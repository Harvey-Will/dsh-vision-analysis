/**
 * Harness-version compatibility shim for settings section registration.
 *
 * The DSH 0.1.2 prerelease line split here: the npm-published
 * `@deepseek-ai/dsh-settings@0.1.2-alpha.5` still exposes the standalone
 * `installSettingsSection(ctx, ns, schema, entry, hooks)`, while the GitHub
 * tag of the same version replaced it with a `SettingsProvider.installSection`
 * method. Node ESM named imports of a missing export throw at link time, so
 * this shim resolves the API at runtime instead of importing either name.
 *
 * Both call shapes are behaviorally identical (same hooks, same semantics);
 * only the carrier differs.
 * @module dsh-vision-analysis/settings-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'

/** Hooks accepted by both API generations. */
export interface SectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?: (value: T) => void
}

/**
 * Register a settings section on whichever API this Harness version exposes.
 * @param ctx - the consumer context (our plugin context).
 * @param ns - lowercase-hyphenated settings namespace.
 * @param schema - schemastery schema describing the section.
 * @param entry - the composition entry value.
 * @param hooks - setSource / onChange / optional validate.
 * @throws when neither API generation is available (unsupported Harness).
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: string,
  schema: unknown,
  entry: T,
  hooks: SectionHooks<T>,
): void {
  // Modern (GitHub tag 0.1.2+): a method on the SettingsProvider service.
  const provider = ctx.settings as unknown as {
    installSection?: (owner: Context, ns: string, schema: unknown, entry: T, hooks: SectionHooks<T>) => void
  }
  if (typeof provider?.installSection === 'function') {
    provider.installSection(ctx, ns, schema, entry, hooks)
    return
  }
  // Legacy (npm 0.1.2-alpha.5 and older): a standalone module function.
  const legacy = (dshSettings as unknown as {
    installSettingsSection?: (ctx: Context, ns: string, schema: unknown, entry: T, hooks: SectionHooks<T>) => void
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, ns, schema, entry, hooks)
    return
  }
  throw new Error('no settings section API on this Harness version (installSection/installSettingsSection both missing)')
}
