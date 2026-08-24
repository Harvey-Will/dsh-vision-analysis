/**
 * The bridge model registry: classifies every model the harness may route by
 * whether it is natively multimodal (direct send), bridged (a text-only model
 * the deployment declared image-capable and listed in `bridgeModels`), or
 * undeclared. Also owns the lifecycle copy that tells the user how to set up
 * and — importantly — how to restore a text-only model when bridging is off.
 *
 * The `bridgeModels` config list is the durable marker of "originally text-only,
 * routed through the plugin": a model that declares image input and is NOT in
 * that list is treated as natively multimodal and is never touched.
 * @module dsh-vision-analysis/model-registry
 */

import type { Config } from './config.js'

/** How one model's image content is routed. */
export type ModelRoute = 'native' | 'bridged' | 'undeclared'

/**
 * Classify one model route from the deployment's declared modalities and the
 * bridge list.
 * @param bridgeModels - the plugin's bridge list (`Config.bridgeModels`).
 * @param model - the model id.
 * @param declaredModalities - the model's declared `inputModalities`, when the
 *   adapter reports them.
 * @returns `bridged` for an image-capable model in the list, `native` for an
 *   image-capable model not in the list, `undeclared` otherwise.
 */
export function classifyModel(
  bridgeModels: readonly string[],
  model: string,
  declaredModalities?: readonly string[],
): ModelRoute {
  if (declaredModalities === undefined || !declaredModalities.includes('image')) return 'undeclared'
  return bridgeModels.includes(model) ? 'bridged' : 'native'
}

/** Whether a model id is listed for bridging. */
export function isBridged(bridgeModels: readonly string[], model: string): boolean {
  return bridgeModels.includes(model)
}

/**
 * The one-time notice shown when `bridgeModels` first becomes non-empty.
 * @param models - the newly bridged model ids.
 */
export function bridgeSetupNotice(models: readonly string[]): string {
  return [
    '图片桥接已启用：',
    `${models.join('、')} 的图片将由本插件交给配置的视觉模型分析（这些模型原本是纯文本）。`,
    '请确认已为这些模型在 settings.yaml 的 inputModalities 中声明 `image`，否则 harness 仍会拒绝图片消息。',
    '取消方法：从 bridgeModels 移除该模型，并同步从 settings.yaml 移除其 inputModalities 中的 `image`，恢复纯文本声明。',
  ].join('\n')
}

/**
 * The notice shown when one or more models are removed from `bridgeModels`.
 * @param models - the removed model ids.
 */
export function bridgeCancelNotice(models: readonly string[]): string {
  return [
    `已取消 ${models.join('、')} 的图片桥接。`,
    '请同步从 settings.yaml 移除这些模型 inputModalities 中的 `image`，恢复为纯文本声明；',
    '否则图片会按"支持图片"处理并原样发送给纯文本模型，可能导致请求失败。',
  ].join('\n')
}

/**
 * Reconcile a bridge list change against the plugin config so lifecycle
 * notices fire exactly on first setup and on removals.
 * @param config - the live configuration.
 * @param previous - the previous bridge list.
 * @returns the notice text to surface, or `undefined` when nothing changed.
 */
export function bridgeChangeNotice(config: Config, previous: readonly string[]): string | undefined {
  const current = config.bridgeModels ?? []
  const added = current.filter((model) => !previous.includes(model))
  const removed = previous.filter((model) => !current.includes(model))
  if (current.length > 0 && previous.length === 0) return bridgeSetupNotice(current)
  if (removed.length > 0) return bridgeCancelNotice(removed)
  if (added.length > 0) {
    // Adding to an already-active bridge: same setup rules apply.
    return bridgeSetupNotice(added)
  }
  return undefined
}
