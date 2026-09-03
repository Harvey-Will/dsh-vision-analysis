# Agent Instructions — dsh-vision-analysis

你是 dsh-vision-analysis 插件的开发 agent。以下是本项目的关键操作规范。

## 遇到问题时

**第一步：读 `TROUBLESHOOTING.md`**。

文档涵盖过去反复遇到的所有问题（配置文件损坏、pnpm/semver/DHS 上游 bug、桥接被拦截、沙箱限制、隐私泄漏等）以及根因和解决方案。先查文档，不要从零开始排查。

## 核心规则

1. **不全量重写配置文件**：settings.yaml 等用户配置文件只能用外科手术式文本编辑（精确定位目标行，只改需要改的部分）。永远不要 parse→modify→serialize 往返。详见 TROUBLESHOOTING.md 第 1 条。
2. **不主动推送**：没有用户明确指令，不执行 `git push` 或任何远程写入操作。
3. **不推送测试内容**：开源仓（dsh-vision-analysis）只含源码、构建、文档、资产。测试文件通过重放脚本排除。
4. **不推送用户隐私**：测试 fixtures 只用合成数据；提交前 `git grep` 扫描真实端点/key/IP。
5. **改动前先备份**：涉及 settings.yaml 的操作，先写带时间戳的备份（`settings.yaml.bak-uva-<ts>`）。

## 项目结构

- **开发仓**：`/home/hewei/Skills/dsh-universal-vision-analysis`（含测试，有 git remote）
- **开源仓**：`/home/hewei/Skills/dsh-vision-analysis`（重放产出，不含测试，remote = GitHub）
- **重放脚本**：`/home/hewei/Skills/.vision-test/replay-history.sh`
- **发布物**：`/home/hewei/Skills/.vision-test/dsh-vision-analysis-*.tgz`
- **详细上下文**：`PROJECT_MEMORY.md`（版本对齐、已知限制、DSH 版本关系）
- **问题解决方案**：`TROUBLESHOOTING.md`（12 个问题的根因和修复 + 7 项快速检查清单）

## 发布流程

1. 开发仓提交 → `bash replay-history.sh` 重放到开源仓 → 用户确认后推送
2. `npm pack` 产出 tgz → 验证包内容（screenshots.json 随包、tests 不随包）
3. 开发仓打 `vX.Y.Z` 标签 → 开源仓同步打标

## DSH 主环境

- 主环境：`~/.dsh/`（rc.1，npm 全局安装）
- 插件配置：`~/.dsh/cordis.patch.yml`（vision-analysis config 块）
- 桥接模型标记：`~/.dsh/settings.yaml` 里的 `_visionBridge: true`（modalities-sync 自动管理）
