import {
  executeAgentToolWithLifecycle,
  type AgentToolCall, type AgentToolResultInfo, type ExecutionContext,
} from '../../kernel/agent-api.ts';
import type { AgentToolExecutor } from '../../plugins/agent-skills/api.ts';
import { errorDisplay } from '../../kernel/error-model.ts';
import type { DiagnosticQuery } from './incidents.ts';

export function diagnosticTool(
  id: string, sensitivity: 'low' | 'medium',
  run: (args: Record<string, unknown>, context: ExecutionContext) => Promise<unknown>,
): AgentToolExecutor {
  return Object.freeze({
    name: () => id,
    canHandle: (name: string) => name.replace(/^builtin[-:]/, '') === id,
    sensitivityLevel: () => sensitivity,
    concurrencyClass: () => sensitivity === 'low' ? 'read_only' as const : 'serial' as const,
    execute(input: unknown, context: unknown): Promise<AgentToolResultInfo> {
      const call = input as AgentToolCall, ctx = context as ExecutionContext;
      const args = call.arguments as Record<string, unknown> | undefined;
      return executeAgentToolWithLifecycle(call, ctx, () => run(args ?? {}, ctx), {
        formatError: errorDisplay,
      });
    },
  });
}

export function diagnosticQuery(args: Record<string, unknown>): DiagnosticQuery {
  const read = (key: string) => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[\w.:|-]{1,160}$/.test(value)) throw new Error('Invalid diagnostic filter: ' + key);
    return value;
  };
  return { id: read('id'), operation: read('operation'), pluginId: read('pluginId') };
}
