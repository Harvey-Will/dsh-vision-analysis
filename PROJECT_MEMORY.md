# 项目记忆

本文件是 dsh-vision-analysis 插件的项目级持久记忆。每次新会话开始时读取此文件，了解项目上下文和关键约定。

---

## 项目概况

- **插件**：dsh-vision-analysis — DeepSeek Harness 的视觉分析插件，为纯文本模型提供图像理解能力
- **仓库**：https://github.com/Harvey-Will/dsh-vision-analysis （开源）
- **开发仓**：/home/hewei/Skills/dsh-universal-vision-analysis（本地，含测试）
- **开源仓**：/home/hewei/Skills/dsh-vision-analysis（重放产出，不含测试）
- **重放脚本**：/home/hewei/Skills/.vision-test/replay-history.sh（dev→开源仓同步，排除 tests/ 和 .npmrc）
- **发布物**：/home/hewei/Skills/.vision-test/dsh-vision-analysis-*.tgz

## 关键约定

1. **不推送测试内容**：开源仓只含源码、构建产物、文档、资产。测试文件从不进入开源仓。
2. **不推送用户隐私**：测试 fixtures 只用合成数据；提交前 `git grep` 扫描真实端点/key/IP。
3. **不主动推送**：没有用户明确指令，不执行 `git push`。
4. **不全量重写配置文件**：用外科手术式文本编辑（参见 TROUBLESHOOTING.md 第 1 条）。
5. **改动前先备份**：涉及 settings.yaml 的操作，先写带时间戳的备份。

## 遇到问题时

**先读 `TROUBLESHOOTING.md`**。文档涵盖：
- 配置文件损坏的根因与修复
- pnpm / semver / DSH 上游发布 bug 的绕过方案
- 桥接在平台层被拦截的原因
- 沙箱环境下的 git push 策略
- 隐私泄漏的检查方法
- 快速检查清单（7 项）

## DSH 版本对齐

- 当前插件版本：`0.2.1-rc.1`
- DSH 主环境版本：`0.2.1-rc.1`（npm `latest` 0.2.0-rc.2 / `next` 0.2.1-rc.2；0.2.10-rc.1 不存在，用户所说即 0.2.1-rc.1）
- 关注 DSH 版本更新时的 API 变更：settings 服务、client UI 模块、类型增强可能在版本间搬家
- semver prerelease 范围陷阱：`^0.1.1-rc.2` 匹配不到 `0.1.2-rc.1`；`>=0.1.7-rc.1`（严格模式）也匹配不到 `0.2.0-rc.1`——每个 prerelease 线需加显式分支（`|| >=0.2.1-rc.1` 依此类推）
- **门禁（0.2.1-alpha.4 起）：manifest 声明 `engines.dsh` 则独裁判定，否则回退 `@deepseek-ai/dsh*` peer 规则**；两者都用 `semver.satisfies(..., { includePrerelease: true })`（宽松）。我们两个都声明：`engines.dsh: ">=0.1.0-rc.6"` + peer OR 范围（老门禁只读 peer）。pnpm/npm 解析依赖走严格模式——两套语义都要满足
- **`pnpm update <pkg>` 会把该包在 package.json 的范围改写成解析出的精确版本**（三次踩坑：OR 范围被压平成 pin）——update 后必须检查 `git diff package.json` 并恢复范围
- **同名包同时在 dependencies 和 devDependencies 时 pnpm 合并解析（prod 边赢）**，devDep 精确 spec 会被无视——重复声明直接删 devDep
- API 审计结论：0.1.7-rc.2 → 0.2.0-rc.1 插件所用上游面**逐字节相同**；0.2.0-rc.1 → 0.2.0-rc.2 零破坏（typert 消息源增量、renderer useMemo、conversation 增量）；0.2.0-rc.2 → 0.2.1-rc.1 零破坏（dsh-llm 仅 adapter 级新增字段 + 新增 `file` 内容块，message.ts/llm-stream 不变；dsh-tools 加可选 `meta`；InputZone 契约/attachmentIds/resolveDraftAttachments 原样；其余增量）
- 0.2.1-alpha.1 破坏项核查均与本插件无关：`./invariant` 导出移除（我们从未引用，devDep 已删、transitive 用 override 钉 0.2.0-rc.2）、子路径插件元数据改走导出（我们是主入口 bundle）、`stats` 槽位拆分、工具展示 `both` 模式移除
- 设置变更事件名是 `settings/document-updated`（0.1.7-rc.2 起一致）；`settings/updated` 是不存在的历史误写
- `conversation.input.dock` 契约：owner props = `InputZone { session: SessionSnapshot, input: InputState }`；草稿附件在 `input.attachmentIds`（`imageIds` 字段不存在）；`inject(sessionId, actions)` 的第一个参数是会话 id；附件 kind（image/file）经可选的 `uiConversation.resolveDraftAttachments` 解析
- pi-ai 模型目录（0.87.1 起移除部分旧 ID）只影响 DSH 模型选择 UI；插件零 pi-ai 耦合，`IMAGE_CAPABLE_MODEL_HINTS` 是刻意保守的白名单（目录自称 677 个视觉模型，不可照抄）

## 已知限制

- 桥接修改 settings.yaml 后需要重启 DSH（运行时内存态不自动更新）；0.1.7+ 配置已迁移到 profile，modalities 自动同步为空操作（新增桥接模型需手动配 `inputModalities`）
- 桥接在流层面工作，UI 里没有显式的工具调用块（这是设计行为，不是 bug）
- 桥接非限流失败时仍会静默降级（M1，部分修复）
- settings service API（mutate）理论上可解决双重启问题，但标记字段会被 schema 剥离——记录为后续方向
- `dsh.client.inject` 里保留了停更包 `@deepseek-ai/dsh-client-runtime`（0.1.1-rc.2）——历史遗留、两版行为相同，清理候选
