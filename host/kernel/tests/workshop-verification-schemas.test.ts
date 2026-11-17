import { expect, it, vi } from 'vitest';
import { WorkbenchChatToolExecutor } from '../../plugins/agent-skills/src/tools/workbench-chat-executor.ts';
import { schemaToolRegistry } from '../../plugins/chat-pipeline/src/tool-runtime.ts';
import { VERIFICATION_TOOLS } from '../../plugins/plugin-workshop/src/generation.ts';

it('advertises the five read-only workshop schemas through the Host executor registry', () => {
  const executor = new WorkbenchChatToolExecutor({ events: () => { throw new Error('No bridge call expected'); },
    gates: () => null, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } });
  const registry = schemaToolRegistry([executor]);
  const schemas = registry.getSchemas(VERIFICATION_TOOLS) as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>;
  expect(schemas.map(schema => schema.function.name)).toEqual([
    'workbench_get_capabilities', 'workbench_observe', 'workbench_wait_for', 'workbench_list_windows', 'workbench_query_state',
  ]);
  expect(schemas.find(schema => schema.function.name === 'workbench_observe')?.function.parameters.properties).toHaveProperty('windowId');
  expect(schemas.find(schema => schema.function.name === 'workbench_wait_for')?.function.parameters.properties).toHaveProperty('condition');
  expect(registry.getSchemas(['workbench_act', 'workbench_open_app'])).toEqual([]);
});
