# Changelog

All notable changes to `dsh-vision-analysis` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.1.2-rc.1] — 2026-09-03

Version aligned with the DeepSeek Harness `0.1.2-rc.1` release (installed via the npm `alpha` → `0.1.2-rc.1` dist-tag).

### Added
- **Multi-endpoint priority groups (F1)**: `endpoints: [{ baseURL, apiKey, model, fallbackModels? }, …]` — additional vision provider groups tried in priority order when the groups before them fail (rate limits, auth errors, endpoint 404/subscription errors, network failures). Each group carries its own key and model ids (ids never cross groups). The stock OVHcloud free group automatically demotes to last-resort fallback once any own group is configured. Chain exhaustion reports every attempt (`组N [model @ baseURL]: error`); pure rate-limit exhaustion keeps the existing quota notice. Bridge and `analyze_image` both fail over across groups; a single-group deployment behaves exactly as before.
- Bridge modalities sync hardening: post-write integrity verification with automatic backup rollback, backup retention (5 most recent), and a surgical text editor that never rewrites the whole settings.yaml.

### Changed
- Dev dependencies aligned to `0.1.2-rc.1` so typecheck and the client-face build run against the same package set the rc.1 host ships.
- Peer/dependency ranges verified to accept `0.1.2-rc.1` (`>=0.1.2-alpha.1` branch; SemVer prerelease tuples mean `^0.1.1-rc.2` alone does NOT match it).
- Settings registration runs through the rc.1 `SettingsProvider.installSection` method with an automatic fallback to the legacy standalone `installSettingsSection` for older hosts.

### Known limitations
- `@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-web-react` and
  `@deepseek-ai/dsh-host-apiproxy` were not republished in the `0.1.2` line;
  dev-installed copies stay at their latest versions. They resolve only at
  build time — at runtime the host frontend still serves these module ids
  (active community plugins declare the same injects).
- The image bridge requires per-deployment setup (`bridgeModels` plus an
  `image` declaration in the model's `inputModalities`) and is not zero-config.
- Failover fallback model ids are endpoint-specific and must be adjusted when
  pointing away from the default provider.

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
