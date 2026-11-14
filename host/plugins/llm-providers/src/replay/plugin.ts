import type { HostPlugin } from '../../../../kernel/api.ts';
import { createLlmReplay, type LlmReplayConfig } from './service.ts';

/**
 * 可挂载的 LLM 回放 provider，提供 `llmReplay`。官方 profile 只收录各插件目录的 `index.ts`，不含本插件：
 * 只有测试或回放工具显式安装时它才存在，llm 插件也只把发往回放源的请求交给它，其余请求照常走真实客户端。
 * 闭包可移植，移动端宿主同样可以安装。
 */
export const llmReplayPlugin: HostPlugin<LlmReplayConfig> = {
  name: 'dstu.llm-replay',
  meta: { id: 'dstu.llm-replay', lane: 'L01-llm-providers', provides: ['llmReplay'], platforms: ['desktop', 'mobile'] },
  apply(ctx, config) {
    const replay = createLlmReplay(config);
    ctx.effect(() => () => { void replay.stop(); });
    ctx.provide('llmReplay', replay);
  },
};
