# dsh-vision-analysis

A model-facing `analyze_image` tool for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It gives a text-only agent image understanding by asking any **OpenAI- or Anthropic-compatible vision endpoint** to analyze one or more images, and returns only the vision model's text answer — the image bytes never enter the conversation.

> ⚠️ This is a community plugin, not an official DeepSeek product. It targets DSH `0.1.0-rc.x`; the Harness API is in developer preview and may break between versions.

## Features

- **Eight analysis modes** with built-in instruction templates and output tuning: `describe`, `ocr`, `ui-review`, `chart-data`, `object-detect`, `compare`, `code-gen`, `debug`.
- **Provider-agnostic**: any OpenAI `chat/completions` or Anthropic `messages` endpoint — MiMo, Step, SiliconFlow, OpenRouter, Gemini (OpenAI-compat), OpenAI, Claude, Ollama, LM Studio, vLLM, or a custom endpoint.
- **Local paths, http(s) URLs, and base64 data URLs**, up to **4 images per call** (multi-image comparison included).
- **Web UI paste-image fallback**: paste an image into the composer of an image-incapable model and a `conversation.input.dock` banner offers "interpret with analyze_image and send" — the image is compressed to a data URL, the agent calls `analyze_image`, and the interpretation text enters the conversation. Models that accept images natively keep the untouched send path.
- **No image leaks into the log**: only the vision model's text crosses into the conversation.
- **Live configuration** through `Settings -> 插件配置` (Schemastery schema, secrets masked), overridable per mode (`maxTokens` / `temperature`).
- **Resilient HTTP**: per-call API key resolution (inline config → `UNIVERSAL_VISION_API_KEY` env), caller-cancellation aware, timeout, bounded image reads, structured error messages, and a `debug` mode that returns a connectivity report instead of failing.
- Dependency-light: only `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` at runtime.

## Install

Requires DSH `0.1.0-rc.x` and Node `^22.19 || >=24`.

```sh
# From npm (once published)
dsh plugin --profile web add dsh-vision-analysis

# From GitHub (author must ship a `prepare` build script — this repo does)
dsh plugin --profile web add github:<you>/dsh-vision-analysis
# pnpm ≥10 blocks git `prepare` scripts until allowed; add the printed key:
#   allowBuilds:
#     dsh-vision-analysis: true
# in the profile's pnpm-workspace.yaml, then re-run the add.

# From a local checkout
dsh plugin --profile web add link:<abs-path>/dsh-vision-analysis
```

Then restart the web profile (`dsh web`), open a session, and ask e.g. *"transcribe all text in /path/to/screenshot.png"* — the agent calls `analyze_image` automatically.

## Configuration

Configure through `cordis.yml` (the inserted row) or live in `Settings -> 插件配置`.

```yaml
- id: vision-analysis
  name: dsh-vision-analysis
  config:
    apiFormat: openai          # openai | anthropic
    baseURL: https://api.siliconflow.cn/v1
    apiKey: ''                # empty → UNIVERSAL_VISION_API_KEY env var → local model
    model: Qwen/Qwen2.5-VL-72B-Instruct
    defaultMode: describe
    maxImages: 2              # 1-4
    maxBytes: 10485760        # per-image cap (10 MB)
    timeoutMs: 120000
    maxTokens: 2048           # default; per-mode override wins
    temperature: 0.7
    modes:                    # per-mode overrides
      ocr:
        temperature: 0.0
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `apiFormat` | `openai` \| `anthropic` | `openai` | Wire format of the vision endpoint |
| `baseURL` | string | — | Endpoint base; a full `/chat/completions` or `/v1/messages` suffix is accepted and kept |
| `apiKey` | string (secret) | `''` | Key; empty falls back to `UNIVERSAL_VISION_API_KEY`, then no auth (local models) |
| `model` | string | — | Vision model identifier |
| `defaultMode` | string | `describe` | Mode when a call omits `mode` |
| `maxImages` | integer | `2` | Max images per call (1–4) |
| `maxBytes` | integer | `10485760` | Per-image byte cap for local files |
| `timeoutMs` | integer | `120000` | Request timeout |
| `maxTokens` | integer | `2048` | Default max output tokens |
| `temperature` | number | `0.7` | Default temperature |
| `modes` | object | `{}` | Per-mode `{ maxTokens?, temperature? }` overrides |

## Tool

### `analyze_image`

**Arguments**

| Name | Type | Description |
|---|---|---|
| `image` | string | Absolute local path, http(s) URL, or base64 data URL (`data:image/png;base64,…`) of the image. Required when `images` is omitted. |
| `images` | string[] | Up to `maxImages` sources for a multi-image call; overrides `image`. |
| `mode` | string | One of `describe`, `ocr`, `ui-review`, `chart-data`, `object-detect`, `compare`, `code-gen`, `debug`. |
| `prompt` | string | Custom instruction; overrides the mode's default template. |

**Modes and built-in tuning**

| Mode | Use case | max_tokens | temperature |
|---|---|---|---|
| `describe` | General understanding (default) | 2048 | 0.7 |
| `ocr` | Text extraction from screenshots/documents | 2048 | 0.0 |
| `ui-review` | UI mockups, wireframes, design files | 2048 | 0.5 |
| `chart-data` | Charts, graphs, data visualizations | 1536 | 0.0 |
| `object-detect` | Objects, people, activities | 1536 | 0.5 |
| `compare` | Two or more images side by side | 2048 | 0.5 |
| `code-gen` | HTML+CSS from UI screenshots | 4096 | 0.3 |
| `debug` | Endpoint connectivity diagnostic | 2048 | 0.7 |

**Output** — a JSON object `{ text, mode, model, imageCount, httpStatus?, latencyMs?, truncated? }`; the model sees only `text`.

**Examples**

- OCR: `analyze_image(image: "/tmp/screenshot.png", mode: "ocr")`
- Compare: `analyze_image(images: ["a.png", "b.png"], mode: "compare")`
- Custom: `analyze_image(image: "https://x.test/table.png", mode: "describe", prompt: "Extract the table as CSV")`

## Security notes

- Installing a plugin runs its code with your permissions — review the source before installing.
- Local image files are read by the tool and sent base64-embedded to your configured endpoint; the raw bytes never enter the session log or reach the model.
- http(s) image URLs are passed to the endpoint, which fetches them — only reference URLs you trust to be fetched by the endpoint.
- Keep the API key out of `cordis.yml` where possible: rely on the `UNIVERSAL_VISION_API_KEY` environment variable, or use the masked secret field in `Settings -> 插件配置`.
- The endpoint is not sandboxed by tool approvals; only point it at endpoints you control.

## Real-world verification

Tested end-to-end against a real OpenAI-compatible endpoint (Volcengine Ark, model `doubao-seed-2.0-lite`):

1. Direct multimodal call over the OpenAI protocol returned HTTP 200 and correctly transcribed the test image's text and described its contents.
2. The bundle was mounted into a `headless` DSH profile (`dsh plugin --profile headless add <checkout>`) with the endpoint/model configured via the profile `cordis.patch.yml` and the key via `UNIVERSAL_VISION_API_KEY`.
3. A real agent run (`dsh --profile headless "Use the analyze_image tool to OCR …"`) had the model call `analyze_image` with `mode: ocr`; the plugin loaded the local PNG, sent it base64-embedded to the endpoint, and the session log recorded the tool call and its text result:

```
step 1: analyze_image args={"image": "…/test-card.png", "mode": "ocr", "prompt": "…"}
  -> result: DSH VISION TEST 1234
              Line two: HELLO
```

This real run also caught and fixed a bug the unit tests missed: `callVision` initially read the raw `config.apiKey` instead of the resolved key, so the `UNIVERSAL_VISION_API_KEY` fallback never reached the `Authorization` header (HTTP 401). The fix routes all calls through `resolveApiKey()` and is covered by a dedicated test.

## Development

```sh
pnpm install
pnpm build        # tsc → lib/
pnpm test         # node --test tests/smoke.test.mjs (no network required)
```

Verify inside a real profile (local, disposable `DSH_HOME`):

```sh
export DSH_HOME=$PWD/.dsh-test
dsh plugin --profile demo --store-dir ./.pnpm-store add <abs-path>
dsh --profile demo --dump-config        # confirm the bundle layer
```

## Publishing checklist

1. Set the repo topic **`dsh-plugin`** on GitHub ([topic page](https://github.com/topics/dsh-plugin)).
2. (Optional) Submit to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) under *Tools & Capabilities*.
3. (Optional) Publish to npm (`pnpm publish`) or ship a tarball (`pnpm pack`); the `prepare` script builds `lib/` from source for git installs.

## License

MIT — see [LICENSE](LICENSE).
