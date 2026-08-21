# dsh-vision-analysis

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的模型面对工具 `analyze_image`：让纯文本 Agent 获得图像理解能力——通过任意 **OpenAI 或 Anthropic 兼容的视觉端点**分析一张或多张图片，并且只把视觉模型的文本答案带回对话，**图片字节永远不会进入会话**。

> ⚠️ 这是社区插件，非 DeepSeek 官方产品。目标 DSH 版本 `0.1.0-rc.x`；Harness API 处于开发者预览阶段，跨版本可能发生破坏性变更。

## 特性

- **8 种分析模式**，内置提示词模板与输出参数：`describe`（描述）、`ocr`（文字识别）、`ui-review`（UI 评审）、`chart-data`（图表取数）、`object-detect`（目标检测）、`compare`（对比）、`code-gen`（代码生成）、`debug`（连通性诊断）。
- **提供商无关**：任意 OpenAI `chat/completions` 或 Anthropic `messages` 端点——MiMo、Step、硅基流动、OpenRouter、Gemini（OpenAI 兼容）、OpenAI、Claude、Ollama、LM Studio、vLLM 或自定义端点。
- **本地路径、http(s) URL 与 base64 data URL**，每次调用最多 **4 张图**（含多图对比）。
- **Web UI 粘贴图片降级**：当会话模型不支持图片输入时，在输入框粘贴图片会显示"用 analyze_image 解读并发送"横幅——图片被压缩为 data URL，Agent 调用 `analyze_image` 后解读文本进入对话；支持图片的模型保持原生直发不受影响。
- **图片不泄漏进日志**：只有视觉模型的文本跨入对话。
- **配置实时生效**：通过 `设置 -> 插件配置` 编辑（Schemastery schema，密钥自动掩码），支持按模式覆盖 `maxTokens` / `temperature`。
- **健壮的 HTTP**：每次调用解析 API key（内联配置 → `UNIVERSAL_VISION_API_KEY` 环境变量 → 本地模型免鉴权）、响应调用方取消、超时、图片读取有界、结构化错误信息；`debug` 模式返回连通性报告而非直接失败。
- 依赖精简：运行时仅依赖 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings`。

## 安装

需要 DSH `0.1.0-rc.x` 与 Node `^22.19 || >=24`。

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-vision-analysis

# 从 GitHub（作者需提供 prepare 构建脚本——本仓库已提供）
dsh plugin --profile web add github:<you>/dsh-vision-analysis
# pnpm ≥10 默认阻止 git 依赖的 prepare 脚本，需先在 profile 的
# pnpm-workspace.yaml 中放行（按 pnpm 打印的 key 填写）：
#   allowBuilds:
#     dsh-vision-analysis: true
# 然后重新 add。

# 本地 checkout
dsh plugin --profile web add link:<绝对路径>/dsh-vision-analysis
```

重启 web profile（`dsh web`）后新建会话，例如问 *“把 /path/to/screenshot.png 里的文字全部转写出来”*——Agent 会自动调用 `analyze_image`。

## 配置

通过 `cordis.yml`（插入的行）或 `设置 -> 插件配置` 实时配置。

```yaml
- id: vision-analysis
  name: dsh-vision-analysis
  config:
    apiFormat: openai          # openai | anthropic
    baseURL: https://api.siliconflow.cn/v1
    apiKey: ''                # 留空 → 使用 UNIVERSAL_VISION_API_KEY 环境变量 → 本地模型
    model: Qwen/Qwen2.5-VL-72B-Instruct
    defaultMode: describe
    maxImages: 2              # 1-4
    maxBytes: 10485760        # 单图字节上限（10 MB）
    timeoutMs: 120000
    maxTokens: 2048           # 默认值；模式级覆盖优先
    temperature: 0.7
    modes:                    # 按模式覆盖
      ocr:
        temperature: 0.0
```

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `apiFormat` | `openai` \| `anthropic` | `openai` | 视觉端点的线协议格式 |
| `baseURL` | string | — | 端点地址；已含完整 `/chat/completions` 或 `/v1/messages` 后缀时原样保留 |
| `apiKey` | string（密钥） | `''` | 密钥；留空回退到 `UNIVERSAL_VISION_API_KEY`，再留空则不带鉴权（本地模型） |
| `model` | string | — | 视觉模型标识 |
| `defaultMode` | string | `describe` | 调用未传 `mode` 时使用的模式 |
| `maxImages` | integer | `2` | 每次调用最大图片数（1–4） |
| `maxBytes` | integer | `10485760` | 本地图片单文件字节上限 |
| `timeoutMs` | integer | `120000` | 请求超时（毫秒） |
| `maxTokens` | integer | `2048` | 默认最大输出 token 数 |
| `temperature` | number | `0.7` | 默认温度 |
| `modes` | object | `{}` | 按模式的 `{ maxTokens?, temperature? }` 覆盖 |

## 工具

### `analyze_image`

**参数**

| 名称 | 类型 | 说明 |
|---|---|---|
| `image` | string | 本地绝对路径、http(s) URL 或 base64 data URL（`data:image/png;base64,…`）。未传 `images` 时必填。 |
| `images` | string[] | 多图调用时的图片源（最多 `maxImages` 张）；存在时覆盖 `image`。 |
| `mode` | string | `describe` / `ocr` / `ui-review` / `chart-data` / `object-detect` / `compare` / `code-gen` / `debug`。 |
| `prompt` | string | 自定义指令；覆盖模式默认模板。 |

**模式与内置参数**

| 模式 | 适用场景 | max_tokens | temperature |
|---|---|---|---|
| `describe` | 通用理解（默认） | 2048 | 0.7 |
| `ocr` | 截图/文档文字提取 | 2048 | 0.0 |
| `ui-review` | UI 稿、线框图、设计稿 | 2048 | 0.5 |
| `chart-data` | 图表、曲线、数据可视化 | 1536 | 0.0 |
| `object-detect` | 识别物体、人物、活动 | 1536 | 0.5 |
| `compare` | 两张及以上图片对比 | 2048 | 0.5 |
| `code-gen` | 由 UI 截图生成 HTML+CSS | 4096 | 0.3 |
| `debug` | 端点连通性诊断 | 2048 | 0.7 |

**输出** — JSON 对象 `{ text, mode, model, imageCount, httpStatus?, latencyMs?, truncated? }`；模型只看到 `text`。

**示例**

- OCR：`analyze_image(image: "/tmp/screenshot.png", mode: "ocr")`
- 对比：`analyze_image(images: ["a.png", "b.png"], mode: "compare")`
- 自定义：`analyze_image(image: "https://x.test/table.png", mode: "describe", prompt: "把表格提取成 CSV")`

## 安全说明

- 安装插件即在其权限下执行代码——安装前请审查源码。
- 本地图片由工具读取并以 base64 内嵌发送到你配置的端点；原始字节不会进入会话日志，也不会到达主模型。
- http(s) 图片 URL 会直接交给端点去抓取——只引用你信任该端点抓取的地址。
- 尽量不把 API key 写进 `cordis.yml`：优先使用 `UNIVERSAL_VISION_API_KEY` 环境变量，或使用 `设置 -> 插件配置` 中的掩码密钥字段。
- 工具审批不对端点做沙箱；只把工具指向你控制的端点。

## 真实验证记录

已针对真实 OpenAI 兼容端点（火山方舟，模型 `doubao-seed-2.0-lite`）做过端到端测试：

1. 直接多模态调用（OpenAI 协议）返回 HTTP 200，正确转写了测试图文字并描述其内容。
2. 将 bundle 真实装入 `headless` DSH profile（`dsh plugin --profile headless add <checkout>`），通过 profile 的 `cordis.patch.yml` 配置端点/模型，通过 `UNIVERSAL_VISION_API_KEY` 注入密钥。
3. 真实 Agent 运行（`dsh --profile headless "Use the analyze_image tool to OCR …"`）：模型真实调用了 `analyze_image`（`mode: ocr`），插件读取本地 PNG、以 base64 发送到端点，会话日志记录了调用与返回文本：

```
step 1: analyze_image args={"image": "…/test-card.png", "mode": "ocr", "prompt": "…"}
  -> result: DSH VISION TEST 1234
              Line two: HELLO
```

这次真实运行还抓出并修复了一个单元测试未覆盖的 bug：`callVision` 最初直接读原始 `config.apiKey` 而非解析后的 key，导致 `UNIVERSAL_VISION_API_KEY` 回退从未进入 `Authorization` 头（HTTP 401）。修复后所有调用统一走 `resolveApiKey()`，并有专门测试覆盖。

## 开发

```sh
pnpm install
pnpm build        # tsc → lib/
pnpm test         # node --test tests/smoke.test.mjs（无需网络）
```

在真实 profile 中验证（本地、可丢弃的 `DSH_HOME`）：

```sh
export DSH_HOME=$PWD/.dsh-test
dsh plugin --profile demo --store-dir ./.pnpm-store add <绝对路径>
dsh --profile demo --dump-config        # 确认 bundle 层
```

## 发布清单

1. 在 GitHub 仓库设置话题 **`dsh-plugin`**（[话题页](https://github.com/topics/dsh-plugin)）。
2. （可选）提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 *Tools & Capabilities* 类目。
3. （可选）发布到 npm（`pnpm publish`）或打 tarball（`pnpm pack`）；`prepare` 脚本会在 git 安装时从源码构建 `lib/`。

## License

MIT — 见 [LICENSE](LICENSE)。
