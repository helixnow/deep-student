/**
 * llm-providers 回放 provider（`llmReplay`）的挂载点。只有发往回放源的请求、且回放已挂载时才交给它；
 * 其余请求，以及未挂载时的一切请求，都原样走 `fetcher`，行为与没有这一层时相同。
 * 判定在这里而不在回放服务里做：回放服务看不到发往真实供应商的请求（含 API key）。
 */
import { isLlmReplayUrl, type LlmReplayService } from '../../llm-providers/api.ts';

export function withLlmReplay(fetcher: typeof fetch, replay: () => LlmReplayService | undefined): typeof fetch {
  return (input, init) => {
    if (!isLlmReplayUrl(input)) return fetcher(input, init);
    const service = replay();
    return service === undefined ? fetcher(input, init) : service.fetch(input, init);
  };
}
