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

- 当前插件版本：`0.1.2-rc.1`
- DSH 主环境版本：`0.1.2-rc.1`（npm dist-tag `alpha`）
- 关注 DSH 版本更新时的 API 变更：settings 服务、client UI 模块、类型增强可能在版本间搬家
- semver prerelease 范围陷阱：`^0.1.1-rc.2` 匹配不到 `0.1.2-rc.1`——需加 `>=0.1.2-alpha.1` 分支

## 已知限制

- 桥接修改 settings.yaml 后需要重启 DSH（运行时内存态不自动更新）
- 桥接在流层面工作，UI 里没有显式的工具调用块（这是设计行为，不是 bug）
- 桥接非限流失败时仍会静默降级（M1，部分修复）
- settings service API（mutate）理论上可解决双重启问题，但标记字段会被 schema 剥离——记录为后续方向
