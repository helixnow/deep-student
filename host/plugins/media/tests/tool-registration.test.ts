/**
 * Rust `agent_wiring/roster.rs` → L07 `agentTools.registerToolExecutors`: media
 * publishes only executors that can run (`execute` present), in roster order,
 * and withdraws its contribution when the plugin unloads.
 */
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { APP_EXECUTOR_ROSTER } from '../../../kernel/agent-roster.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

const MEDIA_EXECUTORS = [
  'MediaToolExecutor', 'OfficeFidelityExecutor', 'TextbookPdfToolExecutor', 'DocxToolExecutor',
  'PptxToolExecutor', 'XlsxToolExecutor', 'ImageGenerationExecutor', 'DocumentProcessingExecutor',
];

it('registers the L18 executors with execute() in roster order and disposes them on unload', async () => {
  const registered: AgentToolExecutor[][] = [];
  const disposed: AgentToolExecutor[][] = [];
  const host = await createTestHost({
    plugins: [media],
    provide: {
      storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: process.cwd() },
      agentTools: {
        registerToolExecutors(executors: readonly AgentToolExecutor[]) {
          const batch = [...executors];
          registered.push(batch);
          return { dispose: () => { disposed.push(batch); } };
        },
      },
    },
  });
  try {
    expect(registered).toHaveLength(1);
    const names = registered[0]!.map(executor => executor.name());
    expect(names).toEqual(MEDIA_EXECUTORS);
    const rosterOrder = (APP_EXECUTOR_ROSTER as readonly string[]).filter(name => MEDIA_EXECUTORS.includes(name));
    expect(names).toEqual(rosterOrder);
    for (const executor of registered[0]!) expect(typeof executor.execute).toBe('function');

    const xlsx = registered[0]!.find(executor => executor.name() === 'XlsxToolExecutor')!;
    expect(xlsx.canHandle('builtin-xlsx_edit_cells')).toBe(true);
    expect(xlsx.sensitivityLevel?.('builtin-xlsx_edit_cells')).toBe('medium');

    const textbook = registered[0]!.find(executor => executor.name() === 'TextbookPdfToolExecutor') as AgentToolExecutor & {
      hasDynamicSensitivity?(toolName: string): boolean;
      sensitivityLevelForCall?(toolName: string, args: unknown): string;
    };
    expect(textbook.canHandle('builtin-pdf_page_image')).toBe(true);
    expect(textbook.hasDynamicSensitivity?.('builtin-textbook_highlights')).toBe(true);
    expect(textbook.sensitivityLevelForCall?.('builtin-textbook_highlights', { action: 'get' })).toBe('low');
    expect(textbook.concurrencyClass?.('builtin-pdf_page_image')).toBe('read_only');
  } finally {
    await host.dispose();
  }
  expect(disposed).toEqual(registered);
});
