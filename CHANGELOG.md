# Changelog

All notable changes to `dsh-vision-analysis` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.1.7-rc.2] — 2026-09-24

Version aligned with the DeepSeek Harness `0.1.7-rc.2` release. No code changes
required — every upstream API this plugin uses was verified against the
installed 0.1.7-rc.2 runtime.

### Changed
- Dev dependencies aligned to `0.1.7-rc.2`; peer/dependency ranges extended with
  `>=0.1.7-rc.1` documenting 0.1.7-rc line support. The plugin-version
  compatibility gate introduced in 0.1.7-rc.1 (which checks `@deepseek-ai/dsh*`
  peer ranges against the runtime, prereleases participating) accepts this
  plugin on `0.1.7-rc.2` — verified against the gate's own predicate.
- Desktop variant (0.1.7-rc.2): the desktop app embeds the same web frontend —
  the plugin's client face (`platform: "web"`) loads there unchanged. No
  desktop-specific plugin surface exists in the runtime to adapt to.

### Verified
- `SettingsForms` third-generation settings path, `llm/stream` waterfall,
  `attachments.readImage`, and the `conversation.input.dock` slot are unchanged
  in 0.1.7-rc.2. 130/130 tests green; tsc 0 errors; client build OK.
- Upstream since 0.1.7-alpha.1 (alpha.2 / rc.1 / rc.2) touches plugin-adjacent
  surfaces we do not use (`spill-policy` token budgets, `agent/created` events,
  Session sync-history deprecations, PTC renames, `readBytes` migration) — none
  affect this plugin.

### Known limitations
- Unchanged from 0.1.7-alpha.1: modalities auto-sync is a no-op on 0.1.7+
  profile storage; `_visionBridge` declarations survive the upstream settings
  migration.

## [0.1.7-alpha.1] — 2026-09-22

Version aligned with the DeepSeek Harness `0.1.7-alpha.1` release. Three upstream
breaking changes handled; all plugin features remain functional.

### Changed
- **Settings API third generation** (`SettingsProvider.installSection` removed
  upstream): the compatibility shim now detects `SettingsForms` (0.1.7+) and
  wires lazy config reading through `describe()` plus a best-effort
  `settings/updated` change listener. Schema registration is automatic (derived
  from the plugin's `Config` export).
- **Message types** (`Message` → `RequestMessage = Message | RequestUserInput`):
  bridge helpers now use `RequestMessage` throughout.
- **ContentBlock vocabulary** (`tool-result` removed → `tool-call` /
  `tool-addition` / `tool-removal`): image projection recurses into both legacy
  `tool-result` and new `tool-call` nested content, keeping the bridge-specific
  placeholder format (not the upstream `projectImagesForTextModel` default).
- Bridge modalities sync degrades gracefully when `settings.yaml` is absent
  (0.1.7 migrates it into the profile) instead of failing plugin boot.
- Dev dependencies aligned to `0.1.7-alpha.1`; `dsh-code-runtime` pinned to
  `0.1.5-rc.3` (not republished in the 0.1.7 line). Peer/dependency ranges
  extended with `>=0.1.7-alpha.1`.

### Known limitations
- Modalities auto-sync is a no-op on 0.1.7+ (model config storage moved from
  settings.yaml into the profile patch). Existing `_visionBridge` declarations
  survive the upstream migration; new bridge models need their `image`
  inputModalities configured via the profile until sync is ported.
- Session format V4 in 0.1.7 is read-only for this plugin (no session I/O).

## [0.1.5-rc.1] — 2026-09-10

Version aligned with the DeepSeek Harness `0.1.5-rc.1` release. API-compatible upgrade from 0.1.2-rc.1 — no plugin code changes required; all upstream APIs used by the plugin (`SettingsProvider.installSection`, `llm/stream` waterfall, `attachments.readImage`, `conversation.input.dock` slot, `ctx.slots.inject/register`) are unchanged.

### Changed
- Dev dependencies aligned to `0.1.5-rc.1` (26 packages updated; 3 stale packages — dsh-client-runtime, dsh-client-web-react, dsh-host-apiproxy — remain at their latest published versions).
- Peer/dependency ranges extended with `>=0.1.5-alpha.1` to cover the 0.1.5 minor (SemVer prerelease tuple rule).
- pnpm-workspace.yaml overrides updated to `0.1.5-rc.1`.
- Plugin benefits from upstream improvements without code changes: HTTP_PROXY support for vision API calls, `read_image` results rendered directly in Web tool cards, pi-ai 0.85.1 upgrade (catalog-changed validator fix).

### Known limitations
- Session format V3 migration is irreversible — users who upgrade cannot downgrade to 0.1.2-rc.1 session logs.
- `@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-web-react` and `@deepseek-ai/dsh-host-apiproxy` were not republished in the 0.1.5 line; dev-installed copies stay at their latest versions. They resolve only at build time — at runtime the host frontend still serves these module ids.
- The image bridge requires per-deployment setup (`bridgeModels` plus an `image` declaration in the model's `inputModalities`) and is not zero-config. The modalities auto-sync removes the manual settings.yaml step; a restart is still needed for the running harness to reload the model registry.

## [0.1.2-rc.1] — 2026-09-03

Version aligned with the DeepSeek Harness `0.1.2-rc.1` release (installed via the npm `alpha` → `0.1.2-rc.1` dist-tag).

### Added
- **Bridge modalities auto-sync**: models listed in `bridgeModels` are configured automatically — the plugin adds `image` to the model's `inputModalities` in settings.yaml and marks the entry with `_visionBridge: true`, so the harness admits image prompts without manual editing. Removing a model from `bridgeModels` (or deactivating the plugin) reverts every marked entry to its pre-bridge state; native multimodal models are never touched. Edits are surgical (raw-text line patches — the whole file is never rewritten) and every modification is preceded by a timestamped backup.
- **Multi-endpoint priority groups (F1)**: `endpoints: [{ baseURL, apiKey, model, fallbackModels? }, …]` — additional vision provider groups tried in priority order when the groups before them fail (rate limits, auth errors, endpoint 404/subscription errors, network failures). Each group carries its own key and model ids (ids never cross groups). The stock OVHcloud free group automatically demotes to last-resort fallback once any own group is configured. Chain exhaustion reports every attempt (`组N [model @ baseURL]: error`); pure rate-limit exhaustion keeps the existing quota notice. Bridge and `analyze_image` both fail over across groups; a single-group deployment behaves exactly as before.
- Client-side composer dock entry, settings section, and `analyze_image` tool all registered through the rc.1 settings/tool APIs (see Changed).

### Changed
- Dev dependencies aligned to `0.1.2-rc.1` so typecheck and the client-face build run against the same package set the rc.1 host ships.
- Peer/dependency ranges verified to accept `0.1.2-rc.1` (`>=0.1.2-alpha.1` branch; SemVer prerelease tuples mean `^0.1.1-rc.2` alone does NOT match it).
- Settings registration runs through the rc.1 `SettingsProvider.installSection` method with an automatic fallback to the legacy standalone `installSettingsSection` for older hosts; the client `ctx.slots` Context merge now loads from `dsh-client-ui-renderer/client`, and `JsonValue` from `dsh-util-values` (both moved upstream in rc.1).
- Sync hardening (P1): post-write integrity verification with automatic backup rollback (top-level key loss and empty-object corruption both trigger restore), backup retention (5 most recent), and byte-for-byte round-trip fidelity tests over a real-structure settings.yaml benchmark.

### Known limitations
- `@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-web-react` and
  `@deepseek-ai/dsh-host-apiproxy` were not republished in the `0.1.2` line;
  dev-installed copies stay at their latest versions. They resolve only at
  build time — at runtime the host frontend still serves these module ids
  (active community plugins declare the same injects).
- The image bridge requires per-deployment setup (`bridgeModels` plus an
  `image` declaration in the model's `inputModalities`) and is not zero-config.
  The modalities auto-sync removes the manual settings.yaml step; a restart is
  still needed for the running harness to reload the model registry.
- Failover fallback model ids are endpoint-specific and must be adjusted when
  pointing away from the default provider (each `endpoints` group carries its own).

## [0.1.2-alpha.5] - 2026-08-28

Version aligned with the DeepSeek Harness `dsh-v0.1.2-alpha.5` prerelease line.

### Added
- Built-in default vision source: OVHcloud AI Endpoints free anonymous tier (Qwen2.5-VL-72B-Instruct), zero-config on first install.
- `fallbackModels`: rate-limit failover across same-endpoint models (HTTP 429 rotates to the next model; non-429 errors never rotate).
- `VisionRateLimitError` with user-facing recovery guidance when every model is limited; the image bridge surfaces it in conversation.
- Tool output reports the model that actually answered.
- In-repo `screenshots.json` declaration per the awesome-dsh-plugin convention.
- `bugs.url` and `author` metadata in `package.json`.

### Changed
- README (en/zh): two clearly separated usage modes (`analyze_image` tool vs. image bridge setup), real OCR/chart/UI demo outputs, unified version references, fixed issue links.
- Repository topics widened for discoverability.

### Known limitations
- The image bridge requires per-deployment setup (`bridgeModels` plus an
  `image` declaration in the model's `inputModalities`) and is not zero-config.
- Failover fallback model ids are endpoint-specific and must be adjusted when
  pointing away from the default provider.

## [0.1.1-rc.2] — 2026-08-22

### Added
- Image bridge: route pasted/sent images to the configured vision endpoint for models listed in `bridgeModels` (originally text-only models declared image-capable).
- Structured output: `chart-data` / `ocr` return machine-readable `data` (JSON) alongside text, with automatic fallback when the endpoint lacks `response_format` support.
- Result caching (`cacheTtlMs`, `cacheMaxEntries`) and retry with exponential backoff (`retryCount`, `retryBackoffMs`) on HTTP 429 / transient 5xx.
- Bilingual README with demo screenshot; composer hint for image-incapable models.

## [0.1.0-rc.8] — 2026-08-21

### Added
- `analyze_image` tool with 8 modes (describe, ocr, ui-review, chart-data, object-detect, compare, code-gen, debug).
- OpenAI and Anthropic wire formats; local path / http(s) URL / data URL input; up to 4 images per call.
- Privacy-first design: image bytes never enter the session log or the main model; `debug` report masks API keys entirely.
- Web UI composer guidance for image-incapable models.
