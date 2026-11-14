import { describe, expect, it } from 'vitest';
import { GeneralToolExecutor } from '../src/tools/general-executor.ts';

describe('general_executor.rs', () => {
  it('test_can_handle', () => {
    const executor = new GeneralToolExecutor();

    expect(executor.canHandle('note_read')).toBe(false);
    expect(executor.canHandle('note_append')).toBe(false);
    expect(executor.canHandle('note_replace')).toBe(false);
    expect(executor.canHandle('note_set')).toBe(false);

    expect(executor.canHandle('web_search')).toBe(true);
    expect(executor.canHandle('mcp_brave_search')).toBe(true);
    expect(executor.canHandle('some_custom_tool')).toBe(true);
  });

  it('test_sensitivity_level', () => {
    const executor = new GeneralToolExecutor();

    expect(executor.sensitivityLevel('web_search')).toBe('low');
    expect(executor.sensitivityLevel('mcp_brave_search')).toBe('medium');
    expect(executor.sensitivityLevel('mcp_web_search')).toBe('medium');

    expect(executor.sensitivityLevel('some_custom_tool')).toBe('medium');

    expect(executor.sensitivityLevel('mcp_shell_execute')).toBe('high');
    expect(executor.sensitivityLevel('mcp_builtin-execute_command')).toBe('high');
    expect(executor.sensitivityLevel('mcp_builtin-file_write')).toBe('high');
  });

  it('test_name', () => {
    expect(new GeneralToolExecutor().name()).toBe('GeneralToolExecutor');
  });

  it('canvas names are source-preserving', () => {
    const executor = new GeneralToolExecutor();
    expect(executor.canHandle('builtin-note_read')).toBe(false);
    expect(executor.canHandle('mcp_note_search')).toBe(false);
    expect(executor.canHandle('builtin:note_read')).toBe(true);
  });

  it('dotted MCP namespace is external and per-server', () => {
    const executor = new GeneralToolExecutor();
    expect(executor.sensitivityLevel('mcp.tools.web_search')).toBe('medium');
    expect(executor.sensitivityLevel('mcp.tools.file_write')).toBe('high');
  });

  it('forwards cancellation_token and window safely and settles error event on abort without window throw', async () => {
    const executor = new GeneralToolExecutor();
    const controller = new AbortController();
    const seenContexts: Array<{ window: unknown; signal: unknown }> = [];
    const errors: string[] = [];
    const saved: unknown[] = [];

    const ctx = {
      session_id: 's1',
      block_id: 'blk_g',
      cancellation_token: controller.signal,
      isCancelled: () => controller.signal.aborted,
      tryWindow: () => null,
      windowRef: () => { throw new Error('should not call windowRef'); },
      emitToolCallStart: () => {},
      emitToolCallEnd: () => {},
      emitToolCallError: (msg: string) => { errors.push(msg); },
      saveToolBlock: (res: unknown) => { saved.push(res); },
      services: {
        logger: { debug: () => {}, warn: () => {} },
        app: { dataDir: '/tmp' },
      },
      tool_registry: {
        callTool: (_name: string, _args: unknown, toolCtx: { window?: unknown; signal?: unknown }) => {
          seenContexts.push({ window: toolCtx.window, signal: toolCtx.signal });
          return new Promise(() => {});
        },
      },
    } as never;

    const pending = executor.execute({ id: 'c_gen', name: 'mcp_demo', arguments: {} }, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(seenContexts).toEqual([{ window: null, signal: controller.signal }]);
    expect(result.success).toBe(false);
    expect(errors).toEqual(['工具调用已取消']);
    expect(saved).toEqual([result]);
  });
});
