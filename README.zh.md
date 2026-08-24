<div align="center">

<img src="assets/banner.svg" alt="DSH Vision Analysis — 为 DeepSeek Harness 提供图像理解能力" width="100%">

[![npm version](https://img.shields.io/npm/v/dsh-vision-analysis?label=npm&color=blue)](https://www.npmjs.com/package/dsh-vision-analysis)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH 0.1.0-rc.8](https://img.shields.io/badge/DSH-0.1.0--rc.8-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![tests: 27/27](https://img.shields.io/badge/tests-27%2F27-success)]
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-✔-black?logo=github)](https://github.com/topics/dsh-plugin)

[English](README.md) · **中文**

</div>

---

## ✨ 为什么选择 DSH Vision Analysis？

你的纯文本 Agent 终于能"看见"了——不用换模型、不让图片字节泄漏进会话、不绑定任何单一厂商。

- **开箱即用的 8 种分析模式** —— `describe`、`ocr`、`ui-review`、`chart-data`、`object-detect`、`compare`、`code-gen`、`debug`，每种都带调优过的指令模板与输出参数。
- **任意视觉端点** —— 支持 OpenAI `chat/completions` **与** Anthropic `messages` 两种线协议：MiMo、Step、硅基流动、OpenRouter、Gemini（OpenAI 兼容）、GPT-4o、Claude、Qwen-VL，或本地 Ollama / LM Studio / vLLM。
- **任意输入** —— 本地绝对路径、`http(s)` URL 或 base64 `data:` URL；单次最多 4 张图，内置多图对比。
- **隐私优先设计** —— 图片字节**永不进入会话日志**、**永不到达主模型**；只有视觉模型的文本答案回到对话。`debug` 报告对 API key **完全掩码**（连前缀都不显示）。
- **配置实时生效** —— 在 `设置 → 插件配置` 中在线修改端点、模型与按模式的输出参数，密钥自动掩码。
- **Web UI 粘贴引导** —— 当前模型不支持图片时，输入框会给出可靠路径提示：保存到本地 → 发送路径 → `analyze_image` 解析（支持原生图片的模型不受影响）。
- **依赖精简** —— 运行时仅依赖 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings`。

---

## 🖼️ 演示

粘贴图片、提出问题、得到真实回答——即使是纯文本模型也可以。图片会被路由到你配置的视觉端点，分析结果直接落进对话：

<p align="center">
  <img src="assets/demo.png" alt="dsh-vision-analysis 实际效果：在 DSH 对话中贴入一张 DeepSeek 娘化同人图，被准确识别并给出完整推理" width="640">
</p>

<sub>截图里：贴入图片 + 提问「这是谁？」——视觉端点识别出 DeepSeek 的娘化同人形象并逐步给出推理，全程无需切换模型、无需保存文件到本地。</sub>

---

## 🚀 快速开始

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-vision-analysis

# 从本地 tarball 安装（无需 registry）
dsh plugin --profile web add ./dsh-vision-analysis-0.1.0-rc.8.tgz
```

重启 web profile 后，直接对 Agent 说：

> "用 analyze_image 把 `/tmp/screenshot.png` 里的文字全部转写出来。"

就这么简单——Agent 调用 `analyze_image`，视觉模型读取文件，文本答案直接落进你的对话。

---

## 🧭 选对模式

| 模式 | 用途 | 内置 tokens / 温度 |
|---|---|---|
| `describe` | 通用理解（默认） | 4096 / 0.7 |
| `ocr` | 截图/文档文字精确提取 | 4096 / 0.0 |
| `ui-review` | 设计评审 + 打分 | 4096 / 0.5 |
| `chart-data` | 图表转表格 + 趋势 | 4096 / 0.0 |
| `object-detect` | 物体/人物/活动识别 | 4096 / 0.5 |
| `compare` | 两张及以上对比 | 4096 / 0.5 |
| `code-gen` | UI 截图转 HTML+CSS | 4096 / 0.3 |
| `debug` | 端点连通性诊断报告 | 4096 / 0.7 |

## 🔧 工具签名

```
analyze_image(image?, images?, mode?, prompt?)
```

- `image` — 本地绝对路径、`http(s)` URL 或 `data:image/...;base64,` URL
- `images` — 多图调用，最多 `maxImages` 张（默认 2，上限 4）
- `mode` — 上述八种之一，默认 `describe`
- `prompt` — 你的精确指令，覆盖模式默认模板

> 精确指令远胜泛泛描述：`prompt: "把表格提取成 CSV"` ≫ `prompt: "描述这张图"`。

## ⚙️ 配置

```yaml
- id: vision-analysis
  name: dsh-vision-analysis
  config:
    apiFormat: openai          # openai | anthropic
    baseURL: https://api.siliconflow.cn/v1
    apiKey: ''                # 留空 → UNIVERSAL_VISION_API_KEY → 本地模型免鉴权
    model: Qwen/Qwen2.5-VL-72B-Instruct
    defaultMode: describe
    maxImages: 2              # 1-4
    maxBytes: 10485760        # 单图字节上限（10 MB）
    timeoutMs: 120000
    maxTokens: 4096
    temperature: 0.7
    modes:                    # 按模式覆盖
      ocr:
        temperature: 0.0
```

所有字段均可在 `设置 → 插件配置` 中实时修改（密钥字段自动掩码）。

---

## 🔒 安全与隐私

- **图片保持私密**：本地文件由工具读取并以 base64 内嵌发送到*你自己配置的*端点；原始字节不会进入会话日志，也不会到达主模型。
- **密钥保持机密**：绝不嵌入发往主模型的请求；`debug` 报告只显示 *已配置 / 未配置*——无前缀、无字符。
- **优先用环境变量**：尽量别把 key 写进 `cordis.yml`——使用 `UNIVERSAL_VISION_API_KEY`，或设置页中的掩码密钥字段。
- **端点不受工具审批沙箱保护**——只把工具指向你控制的端点，且只引用你信任该端点抓取的 `http(s)` 图片地址。
- 安装插件即在其权限下执行代码——安装前请审查源码。

---

## 🧩 兼容性

| | 支持情况 |
|---|---|
| DeepSeek Harness | `0.1.0-rc.x`（已在 `rc.8` 实测） |
| Node.js | `^22.19 \|\| >=24` |
| 视觉线协议 | OpenAI `chat/completions`、Anthropic `messages` |
| 图片格式 | PNG、JPEG、GIF、WebP、BMP（本地 / URL / data URL） |

> ⚠️ 社区插件，非 DeepSeek 官方产品。Harness API 处于开发者预览阶段，跨版本可能存在破坏性变更。

---

<div align="center">

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区打造** · [dsh-plugin 话题](https://github.com/topics/dsh-plugin) · [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

发现 Bug 或有新想法？[提交 Issue](https://github.com/<your-org>/dsh-vision-analysis/issues)——欢迎 PR。

[MIT License](LICENSE)

</div>
