/**
 * 模型适配器选项（`src/cmd/anki_cards.rs:19-75`、`src/commands.rs:3894-3908`）。
 *
 * 选项列表由 L02 的适配器注册表动态生成；L02 已在 main 发布
 * `llmAdapterInfos.listAdapterInfos`，这里只声明最小结构接口。
 */
import type { Context } from '@deepseek-ai/cordis';

/** `dstu-llm/src/llm_manager/adapters/mod.rs:68-72` 的 `AdapterInfo`。 */
export interface AdapterInfo {
  value: string;
  label: string;
  description: string;
}

/** L02 适配器注册表的只读视图（按注册表顺序返回去重后的主 ID）。 */
export interface AdapterInfoProvider {
  listAdapterInfos(): AdapterInfo[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmAdapterInfos: AdapterInfoProvider;
  }
}

export function adapterInfoProvider(ctx: Context): AdapterInfoProvider | undefined {
  return ctx.get('llmAdapterInfos') as AdapterInfoProvider | undefined;
}

/** `default_model_adapter_options` 的 JSON 投影（`commands.rs:3894-3908`）。 */
export function defaultModelAdapterOptions(
  infos: readonly AdapterInfo[],
): Array<AdapterInfo & { is_default: true }> {
  return infos.map((info) => ({
    value: info.value,
    label: info.label,
    description: info.description,
    is_default: true,
  }));
}

/** `save_model_adapter_options` 的逐项格式校验（`anki_cards.rs:36-48`）。 */
export function validateAdapterOptions(options: readonly unknown[]): void {
  for (const [index, option] of options.entries()) {
    if (typeof option !== 'object' || option === null || Array.isArray(option)
      || !('value' in option) || !('label' in option)) {
      throw new Error(`模型适配器选项 ${index} 格式无效，必须包含 'value' 和 'label' 字段`);
    }
  }
}
