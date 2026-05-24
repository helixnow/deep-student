import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PlaygroundControlPanel blocking interaction source contract', () => {
  const controlPanelSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/dev/playground/PlaygroundControlPanel.tsx'),
    'utf-8',
  );
  const adapterSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/dev/playground/mockAdapter.ts'),
    'utf-8',
  );
  const mockDataSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/dev/playground/mockData.ts'),
    'utf-8',
  );

  it('exposes real blocking interaction controls for ask_user, tool approval, and tool limit', () => {
    expect(controlPanelSource).toContain('title="真实阻塞交互"');
    expect(controlPanelSource).toContain('真实 `ask_user`');
    expect(controlPanelSource).toContain('真实 `tool_approval`');
    expect(controlPanelSource).toContain('真实 `tool_limit`');
    expect(controlPanelSource).toContain('handleInjectBlockingAskUser');
    expect(controlPanelSource).toContain('handleInjectBlockingApproval');
    expect(controlPanelSource).toContain('handleInjectBlockingToolLimit');
  });

  it('routes the control panel to dedicated blocking interaction injectors', () => {
    expect(controlPanelSource).toContain('triggerBlockingAskUser');
    expect(controlPanelSource).toContain('triggerBlockingToolApproval');
    expect(controlPanelSource).toContain('triggerBlockingToolLimit');

    expect(adapterSource).toContain('export function triggerBlockingAskUser');
    expect(adapterSource).toContain('export function triggerBlockingToolApproval');
    expect(adapterSource).toContain('export function triggerBlockingToolLimit');
    expect(adapterSource).toContain('setBlockingInteraction(');
    expect(controlPanelSource).toContain('PLAYGROUND_BLOCKING_SAMPLES');
    expect(mockDataSource).toContain('export const PLAYGROUND_BLOCKING_SAMPLES');
    expect(mockDataSource).toContain('todo_init');
  });

  it('surfaces todo sample controls under a dedicated non-blocking task panel section', () => {
    expect(controlPanelSource).toContain('title="任务面板"');
    expect(controlPanelSource).toContain('Todo sample 数据');
    expect(controlPanelSource).toContain('handleInjectTodoSample');
    expect(controlPanelSource).toContain('triggerTodoSample');

    expect(adapterSource).toContain('export function triggerTodoSample');
  });
});
