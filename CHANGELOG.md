# Changelog

All notable changes to `dsh-vision-analysis` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Built-in default vision source: OVHcloud AI Endpoints free anonymous tier (Qwen2.5-VL-72B-Instruct), zero-config on first install.
- `fallbackModels`: rate-limit failover across same-endpoint models (HTTP 429 rotates to the next model; non-429 errors never rotate).
- `VisionRateLimitError` with user-facing recovery guidance when every model is limited; the image bridge surfaces it in conversation.
- Tool output reports the model that actually answered.
- `bugs.url` and `author` metadata in `package.json`.

### Changed
- README (en/zh): two clearly separated usage modes (`analyze_image` tool vs. image bridge setup), real OCR/chart/UI demo outputs, unified version references, fixed issue links.
- Repository topics widened for discoverability.

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
