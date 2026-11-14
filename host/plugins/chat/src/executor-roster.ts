/** The app roster order is F1-owned; L04 consumes actual L07 contributions and dispatches. */
import { composePipelineExecutorRoster } from '../../../kernel/api.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ToolExecutor } from '../api.ts';
import { ToolExecutorRegistry, type ToolApprovalPolicyPort } from './executor-registry.ts';
import type { ChatLogger } from './logger.ts';

export function assembleExecutorRegistry(contributions: readonly AgentToolExecutor[], additional: readonly ToolExecutor[],
  approval: ToolApprovalPolicyPort, workspace: boolean, log: ChatLogger): ToolExecutorRegistry {
  const catalog = new Map<string, ToolExecutor>();
  for (const executor of [...contributions, ...additional]) {
    // L07 permits routing-only metadata. Such an entry is not an executable
    // contribution and must remain missing from the complete runtime roster.
    if (typeof executor.execute === 'function') catalog.set(executor.name(), executor as ToolExecutor);
  }
  return new ToolExecutorRegistry(composePipelineExecutorRoster(catalog, { workspace }), approval, log);
}
