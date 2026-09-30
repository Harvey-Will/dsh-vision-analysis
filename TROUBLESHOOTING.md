# 疑难杂症与解决方案

本文档记录 dsh-vision-analysis 插件开发过程中反复遇到的问题及其根因和解决方案。遇到异常时**先查此文档**，再开始排查。

---

## 1. 配置文件全量重写导致数据损坏

**症状**：settings.yaml 中的 provider 配置丢失、空对象 `{}` 变成字符串 `"{}"`、注释消失、字段名被改写。

**根因**：用不完整的自定义 YAML parser→serializer 对整个配置文件做 parse→modify→serialize 往返。parser 只理解 YAML 的子集——不理解的内容（注释、不熟悉的嵌套结构、空对象）被静默丢弃或转写为错误的格式。

**解决方案**：
- **永远不要全量重写配置文件**。改用外科手术式文本编辑：在原始文本上精确定位目标行，只修改需要改的部分，其余字节一个不动。
- 每次修改前写带时间戳的备份（`settings.yaml.bak-uva-<timestamp>`）。
- 写入后做完整性校验：重读文件，检查所有原始顶层 key 是否存活、空对象是否保持为 `{}`（非 `"{}"`）。校验失败则自动回滚。
- 备份保留最近 5 份，自动清理旧的。

**已造成的事故**：pi-ai 插件的 `resolveProfiles()` 校验器遇到字符串类型的 `compat: {chatTemplateKwargs: "{}"}` → 抛错 → 整个插件激活死亡 → openrouter/openai/opencode 三个供应商在模型设置页消失。

**预防**：任何涉及用户配置文件的写操作都使用 `src/modalities-sync.ts` 的 surgical 编辑器；测试用合成数据，不要从真实 settings.yaml 复制。

---

## 2. 桥接图片在平台层被拦截

**症状**：用户给桥接列表里的模型发图片，但 DSH 拒绝了——报错 `model "xxx" does not declare image input`。

**根因**：DSH 在平台层检查模型的 `inputModalities`——如果没有声明 `image`，图片根本不会进入对话，桥接连触碰图片的机会都没有。

**解决方案**：modalities-sync 模块在启动时自动把 `image` 加入 `bridgeModels` 里每个模型的 `inputModalities`（settings.yaml），并打上 `_visionBridge: true` 标记。移除模型时自动还原。重启 DSH 后生效。

**注意**：改了 settings.yaml 后需要重启——运行中的实例已经加载了旧的模型注册表，内存态不会实时更新。这是已知限制。

---

## 3. pnpm 11 拒装当日发布的包

**症状**：`pnpm install` 时新版 DSH 包被静默降级到旧版，控制台提示 `within the minimumReleaseAge cutoff`。

**根因**：pnpm 11 默认有一个 1440 分钟的发布年龄保护——当日发布的包会被拒绝，然后静默回退到满足条件的旧版本。

**解决方案**：在 `pnpm-workspace.yaml` 里设置：
```yaml
minimumReleaseAge: 0
```
放在 workspace 文件里而非 .npmrc——.npmrc 在重放时被排除，workspace 文件会被提交到开源仓，CI 也自动继承。

---

## 4. DSH 上游 `workspace:^` 发布转换 bug

**症状**：`pnpm install` 报 `ERR_PNPM_NO_MATCHING_VERSION: No matching version found for @deepseek-ai/dsh-session-projection@>=0.1.2 <0.2.0-0`。

**根因**：DSH monorepo 内部用 `workspace:^` 相互依赖。发布到 npm 时，上游工具把部分包的 `workspace:^` 转换成了只认正式版的范围（`>=0.1.2 <0.2.0-0`），但 `0.1.2-rc.1` 是 prerelease——按 semver 规则匹配不到。monorepo 内部用 workspace 协议所以没发现。

**解决方案**：在 `pnpm-workspace.yaml` 里用 overrides 钉版本：
```yaml
overrides:
  "@deepseek-ai/dsh-session-projection": "0.1.2-rc.1"
  "@deepseek-ai/dsh-session-projection-cache": "0.1.2-rc.1"
  "@deepseek-ai/dsh-storage-domain": "0.1.2-rc.1"
  "@deepseek-ai/dsh-storage": "0.1.2-rc.1"
```
按出现的坏包逐个添加。注释说明这是上游发布 bug 的临时绕过。

---

## 5. semver prerelease 范围不匹配

**症状**：`@deepseek-ai/dsh-tools@^0.1.1-rc.2` 装到了 0.1.1-rc.2，没有升级到 0.1.2-rc.1。

**根因**：semver prerelease 规则——`^0.1.1-rc.2` 只匹配 `[0,1,1]` 元组的 prerelease（即 0.1.1-rc.x），**不会**匹配不同元组的 0.1.2-rc.1。

**解决方案**：peer/dependency 范围加分支：
```
^0.1.0-rc.6 || >=0.1.1-rc.1 || >=0.1.2-alpha.1
```
devDeps 直接用 `^0.1.2-rc.1` 或精确钉版。

---

## 6. dsh-llm 双实例导致 branded type 冲突

**症状**：`Type 'ReasoningEffortId' is not assignable to type 'ReasoningEffortId | undefined'`——两个不同的 dsh-llm 包实例，branded type 的 `[BRAND]` 属性不同。

**根因**：`@deepseek-ai/dsh-host-apiproxy`（未随 0.1.2 线重发）的依赖拉了 `dsh-llm@0.1.1-rc.2`，与我们 devDeps 里的 `dsh-llm@0.1.2-rc.1` 冲突。

**解决方案**：pnpm overrides 强制统一：
```yaml
overrides:
  "@deepseek-ai/dsh-llm": "0.1.2-rc.1"
```

---

## 7. ctx.slots / JsonValue 类型增强搬包

**症状**：tsc 报 `Property 'slots' does not exist on type 'Context'` 或 `Module has no exported member 'JsonValue'`。

**根因**：DSH rc.1 把 `ctx.slots: SlotRegistry` 的 Context merge 从 `dsh-client-ui-slots` 移到了 `dsh-client-ui-renderer/client`；`JsonValue` 从 `dsh-session` 移到了 `dsh-util-values`。

**解决方案**：type-only import 换到新包：
```typescript
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
```

---

## 8. YAML parser 对同缩进序列项处理错误

**症状**：parser 把 `input:` 后面的 `- text`、`- image`（与 key 同缩进）当成了独立列表项，而不是 key 的 block sequence 值。

**根因**：YAML 允许序列项与父 key 同缩进（合法的 block style），但 parser 要求子项必须更深缩进。

**解决方案**：扫描时对 `- ` 开头的行，只要 `indent >= keyIndent` 就视为序列成员继续扫描，只有遇到非 `- ` 行且 `indent <= keyIndent` 时才 break。

---

## 9. 桥接静默降级无日志（M1）

**症状**：视觉端点调用失败（如订阅过期 400）时，桥接静默降级到占位符投影，用户什么错误提示都看不到。

**根因**：`catch` 块里只有 `VisionRateLimitError` 有用户提示，其他错误直接 `projectAndRedispatch`，无任何日志。

**当前状态**：F1 的 `VisionChainError` 路径已加日志（`logger.warn`），但单组非链错误仍然静默。完整的 M1 修复待定。

**临时缓解**：检查 `~/.dsh/settings.yaml` 里的 `bridgeModels` 对应模型是否有 `image` 声明；检查视觉端点是否存活（curl 测试）。

---

## 10. 隐私信息泄漏到测试 fixtures

**症状**：测试文件里出现了真实的端点 URL、API key、内网 IP。

**根因**：从真实 settings.yaml 复制内容到测试基准时未脱敏。

**解决方案**：
- 测试 fixtures 只用合成数据（`https://api.provider-one.test/v3`、`192.0.2.10`）。
- 提交前用 `git grep` 扫描：`git grep -l "ark-\|172\.25\.\|vvvox" -- '*.ts' '*.mjs' '*.md'`。
- 如果已提交：`git reset --soft <base>` + 重新分区提交，彻底清除历史。

---

## 11. pnpm add tgz 后 lockfile 解析残留旧 link

**症状**：`pnpm add file.tgz` 后 package.json 是 `file:` 依赖，但 lockfile 的 version 字段还是 `link:` 旧值，node_modules 还是旧软链接。

**根因**：pnpm 从 `link:` 切换到 `file:tgz` 时的 lockfile 更新缺陷——specifier 更新了但 resolution 没变。

**解决方案**：先 `pnpm remove <pkg>` 干净删除，再 `pnpm add <tgz>` 重新添加。不要直接在 link→file 间切换。

---

## 12. 沙箱环境下 git push 受限

**症状**：SSH push 报 `Host key verification failed`（~/.ssh 为空），HTTPS push 超时（github.com:443 被沙箱出口过滤拦住）。

**根因**：沙箱环境限制了网络出口——api.github.com 通，github.com:443 不通；~/.ssh 无密钥。

**解决方案**：
1. 用 HTTPS remote + `gh auth git-credential` 凭证（gh CLI 已认证时可用）
2. 需要 `sandbox_permissions: danger-full-access` 提权（github.com:443 被拦）
3. 不要假设 SSH 可用——始终准备 HTTPS 备用方案

---

## 13. pnpm 沿用 lockfile 旧解析，devDeps 静默停在旧版

**症状**：package.json 的 devDeps 已升到新版（如 `^0.2.0-rc.1`），`pnpm install` 成功，但 `pnpm ls` 显示解析结果还是旧版（如 0.1.7-rc.2）。

**根因**：两个叠加因素——(1) pnpm 倾向保留 lockfile 中仍满足范围的既有解析（prefer-frozen），即使新版也在范围内；(2) 同名包同时出现在 `dependencies` 和 `devDependencies` 时，pnpm 合并解析，宽的那条（dependencies 的 OR 范围）可能赢。0.2.0-rc.1 升级时 `@deepseek-ai/dsh-settings` 就这样停在了 0.1.7-rc.2。

**解决方案**：`CI=true pnpm update <pkg>` 强制重解析该包；升级后必查 `pnpm ls <pkg>` 确认每个 edge 都落在目标版本。别依赖 install 的默认解析。

**⚠️ 陷阱续集（两次实锤）**：`pnpm update <pkg>` 会顺手把该包在 package.json 里的**范围改写成解析出的精确版本**（`^0.1.0-rc.6 || ... || >=0.2.0-rc.2` 被压平成 `"0.2.0-rc.2"`），把我们为跨版本兼容设计的 OR 范围毁掉。所以 update 之后必须 `git diff package.json` 检查并恢复范围——先 update 解析，再手工恢复范围（范围恢复不影响已解析的 node_modules）。

---

## 14. 客户端槽位「幽灵 prop / 幽灵字段」静默失效

**症状**：client 面槽位组件注册成功但从不渲染（或从不执行某些逻辑），无报错、无日志。

**根因**：槽位组件解构的 props / 读取的 state 字段名来自旧版契约，运行时根本不注入/不存在。实例：dock 读 `input.imageIds`（实际是 `InputState.attachmentIds`）、解构 `sessionId` prop（实际 owner props 是 `InputZone { session, input }`，会话 id 在 `session.sessionId` 或 `inject(sessionId)` 第一个参数里）。类型是结构性宽松断言（`as { imageIds?: ... }`），编译期发现不了。

**解决方案**：写 client 面之前先到运行时的 `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` 查目标槽位的**正式契约类型**（owner props、inject 签名），并 grep 运行时源码确认字段真实存在（`grep -rn "imageIds" <runtime>/` 零命中就是红旗）。把可见性/决策逻辑抽成纯函数写单测。每次 DSH 升级做「契约漂移检查」：对我们读的每个字段名在新运行时 grep 一遍。

---

## 快速检查清单

遇到异常时按此顺序排查：

1. [ ] settings.yaml 是否被全量重写过？（检查空对象是否为 `"{}"`）
2. [ ] pnpm install 是否有 `minimumReleaseAge` 警告？
3. [ ] semver prerelease 范围是否覆盖目标版本？（`>=0.1.2-alpha.1` 覆盖 0.1.2-rc.1）
4. [ ] 类型增强 import 是否指向正确的包/子路径？（rc.1 有搬家）
5. [ ] 测试 fixtures 是否用了合成数据？（不从真实配置复制）
6. [ ] 提交前是否 `git grep` 扫描了隐私信息？
7. [ ] bridge 不工作时：模型 inputModalities 有没有 `image`？视觉端点是否存活？
8. [ ] DSH 升级后：client 面读取的字段名/props 在新运行时 grep 还存在吗？`pnpm ls` 的解析版本和目标版本一致吗？
