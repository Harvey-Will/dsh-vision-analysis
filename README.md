<div align="center">

<img src="assets/banner.svg" alt="DSH Vision Analysis — image understanding for the DeepSeek Harness" width="100%">

[![npm version](https://img.shields.io/npm/v/dsh-vision-analysis?label=npm&color=blue)](https://www.npmjs.com/package/dsh-vision-analysis)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH 0.1.0-rc.8](https://img.shields.io/badge/DSH-0.1.0--rc.8-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![tests: 27/27](https://img.shields.io/badge/tests-27%2F27-success)]
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-✔-black?logo=github)](https://github.com/topics/dsh-plugin)

**English** · [中文](README.zh.md)

</div>

---

## ✨ Why DSH Vision Analysis?

Your text-only agent can finally "see" — without swapping your model, without leaking image bytes into the conversation, and without depending on a single vendor.

- **8 analysis modes out of the box** — `describe`, `ocr`, `ui-review`, `chart-data`, `object-detect`, `compare`, `code-gen`, `debug` — each with a tuned instruction template.
- **Any vision endpoint** — OpenAI `chat/completions` **or** Anthropic `messages` wire formats. MiMo, Step, SiliconFlow, OpenRouter, Gemini (OpenAI-compat), GPT-4o, Claude, Qwen-VL, or a local Ollama / LM Studio / vLLM.
- **Any input** — absolute local path, `http(s)` URL, or base64 `data:` URL; up to 4 images per call with built-in comparison.
- **Privacy-first by design** — image bytes never enter the session log or reach your main model; only the vision model's text comes back. The `debug` report never reveals your API key (fully masked).
- **Live configuration** — edit endpoint, model, and per-mode tuning from `Settings → 插件配置` with secrets masked.
- **Web UI guidance** — when your active model can't take images, a composer hint tells you the reliable path: save locally → send the path → `analyze_image` parses it (native image routes stay untouched).
- **Dependency-light** — just `@deepseek-ai/schemastery` + `@deepseek-ai/dsh-settings` at runtime.

---

## 🚀 Quick start

```sh
# From npm (once published)
dsh plugin --profile web add dsh-vision-analysis

# From a local tarball (no registry needed)
dsh plugin --profile web add ./dsh-vision-analysis-0.1.0-rc.8.tgz
```

Then restart the web profile and ask your agent:

> *"Use analyze_image to OCR `/tmp/screenshot.png` and tell me what it says."*

That's it — the agent calls `analyze_image`, the vision model reads the file, and the text answer lands in your conversation.

---

## 🧭 Choose the right mode

| Mode | What it does | Built-in tokens / temp |
|---|---|---|
| `describe` | General understanding (default) | 4096 / 0.7 |
| `ocr` | Exact text extraction | 4096 / 0.0 |
| `ui-review` | Design review with score | 4096 / 0.5 |
| `chart-data` | Tables + trend from charts | 4096 / 0.0 |
| `object-detect` | Objects, people, activities | 4096 / 0.5 |
| `compare` | Two+ images side by side | 4096 / 0.5 |
| `code-gen` | HTML+CSS from a UI shot | 4096 / 0.3 |
| `debug` | Endpoint connectivity report | 4096 / 0.7 |

## 🔧 The tool

```
analyze_image(image?, images?, mode?, prompt?)
```

- `image` — absolute path, `http(s)` URL, or `data:image/...;base64,` URL
- `images` — up to `maxImages` (default 2, max 4) for multi-image calls
- `mode` — one of the eight above; `describe` by default
- `prompt` — your precise instruction overrides the mode template

> A targeted prompt beats a generic description: `prompt: "Extract the table as CSV"` >> `prompt: "Describe this"`.

## ⚙️ Configuration

```yaml
- id: vision-analysis
  name: dsh-vision-analysis
  config:
    apiFormat: openai          # openai | anthropic
    baseURL: https://api.siliconflow.cn/v1
    apiKey: ''                # empty → UNIVERSAL_VISION_API_KEY → local model
    model: Qwen/Qwen2.5-VL-72B-Instruct
    defaultMode: describe
    maxImages: 2              # 1-4
    maxBytes: 10485760        # per-image cap (10 MB)
    timeoutMs: 120000
    maxTokens: 4096
    temperature: 0.7
    modes:                    # per-mode overrides
      ocr:
        temperature: 0.0
```

All fields are editable live from `Settings → 插件配置` (API key field is masked).

---

## 🔒 Security & privacy

- **Your images stay private**: local files are read by the tool and sent base64-embedded only to *your* configured endpoint; the raw bytes never enter the session log or reach the main model.
- **Your key stays secret**: never embedded in requests to the main model; the `debug` report only says *configured / not configured* — no prefix, no characters.
- **Prefer the environment**: keep keys out of `cordis.yml` — use `UNIVERSAL_VISION_API_KEY` or the masked secret field in Settings.
- **Endpoints are not sandboxed** by tool approvals — only point the tool at endpoints you control, and only reference `http(s)` image URLs you trust the endpoint to fetch.
- Installing a plugin runs its code with your permissions — review the source before installing.

---

## 🧩 Compatibility

| | Supported |
|---|---|
| DeepSeek Harness | `0.1.0-rc.x` (verified on `rc.8`) |
| Node.js | `^22.19 \|\| >=24` |
| Vision wire formats | OpenAI `chat/completions`, Anthropic `messages` |
| Image formats | PNG, JPEG, GIF, WebP, BMP (local / URL / data URL) |

> ⚠️ Community plugin — not an official DeepSeek product. The Harness API is in developer preview and may break between versions.

---

<div align="center">

**Built for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community** · [dsh-plugin topic](https://github.com/topics/dsh-plugin) · [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

Found a bug or have an idea? [Open an issue](https://github.com/<your-org>/dsh-vision-analysis/issues) — PRs welcome.

[MIT License](LICENSE)

</div>
