import { expect, it } from 'vitest';
import { APP_EXECUTOR_ROSTER, orderExecutorsByRoster } from '../../../kernel/agent-roster.ts';
import { createChatAnkiExecutors, rosterChatAnkiExecutors } from '../src/executors.ts';

// chatanki_executor.rs:1732-1746 tool names, plus the FSRS / template-designer executors' tools.
const TOOLS = [
  'chatanki_run', 'chatanki_import_apkg', 'chatanki_start', 'chatanki_status', 'chatanki_wait',
  'chatanki_get_cards', 'chatanki_update_card', 'chatanki_batch_update_cards',
  'chatanki_delete_card', 'chatanki_delete_cards', 'chatanki_add_cards',
  'chatanki_enqueue_review', 'chatanki_review_stats', 'chatanki_undo_last_review',
  'chatanki_set_suspended', 'chatanki_list_library_cards', 'chatanki_update_library_card',
  'chatanki_enqueue_library_review', 'chatanki_set_library_suspended',
  'chatanki_undo_library_last_review', 'chatanki_delete_library_card', 'chatanki_retemplate',
  'chatanki_transform', 'chatanki_control', 'chatanki_export', 'chatanki_sync',
  'chatanki_list_templates', 'chatanki_analyze', 'chatanki_check_anki_connect',
];

it('registers every chatanki executor inside the Rust roster, none in the unlisted segment', () => {
  const units = rosterChatAnkiExecutors(createChatAnkiExecutors());
  const roster = new Set<string>(APP_EXECUTOR_ROSTER);
  expect(units.map((unit) => unit.name()).filter((name) => !roster.has(name))).toEqual([]);
  expect(new Set(units.map((unit) => unit.name())).size).toBe(units.length);
  expect(orderExecutorsByRoster(units, { workspace: true }).executors).toHaveLength(units.length);
});

it('the folded ChatAnkiToolExecutor dispatches and reports metadata like first-match over the split handlers', () => {
  const split = createChatAnkiExecutors();
  const units = rosterChatAnkiExecutors(split);
  const transformScript = { transform: { script: 'return cards;' } };
  for (const bare of TOOLS) {
    for (const tool of [bare, `builtin-${bare}`]) {
      const expected = split.find((executor) => executor.canHandle(tool));
      const actual = units.find((unit) => unit.canHandle(tool));
      expect(actual === undefined, tool).toBe(expected === undefined);
      if (expected === undefined || actual === undefined) continue;
      expect(actual.sensitivityLevel(tool), tool).toBe(expected.sensitivityLevel(tool));
      expect(actual.concurrencyClass(tool), tool).toBe(expected.concurrencyClass(tool));
      expect(actual.hasDynamicSensitivity?.(tool) ?? false, tool).toBe(expected.hasDynamicSensitivity?.(tool) ?? false);
      expect(actual.sensitivityLevelForCall?.(tool, transformScript), tool)
        .toBe(expected.sensitivityLevelForCall?.(tool, transformScript) ?? expected.sensitivityLevel(tool));
    }
  }
  expect(units.find((unit) => unit.canHandle('chatanki_transform'))!.sensitivityLevelForCall!('chatanki_transform', transformScript))
    .toBe('high');
  expect(units.some((unit) => unit.canHandle('note_read'))).toBe(false);
});

it('split handler names stay internal: only the first-match primary carries the roster name', () => {
  const split = createChatAnkiExecutors();
  expect(new Set(split.map((executor) => executor.name())).size).toBe(split.length);
  expect(split.filter((executor) => executor.name() === 'ChatAnkiToolExecutor').map((executor) => executor.constructor.name))
    .toEqual(['ChatAnkiExecutor']);
  expect(rosterChatAnkiExecutors(split).map((unit) => unit.name()))
    .toEqual(['FsrsSettingsExecutor', 'TemplateDesignerExecutor', 'ChatAnkiToolExecutor']);
});

it('the folded unit claims update/delete_library_card only while the L16 same-row read is published', () => {
  let published = false;
  const units = rosterChatAnkiExecutors(createChatAnkiExecutors({ libraryCardRead: () => published }));
  const gated = ['chatanki_update_library_card', 'builtin-chatanki_update_library_card',
    'chatanki_delete_library_card', 'builtin-chatanki_delete_library_card'];
  const ungated = ['builtin-chatanki_enqueue_library_review', 'builtin-chatanki_set_library_suspended',
    'builtin-chatanki_undo_library_last_review', 'builtin-chatanki_wait'];
  const claimants = (tool: string) => units.filter((unit) => unit.canHandle(tool)).map((unit) => unit.name());
  for (const tool of gated) expect(claimants(tool), tool).toEqual([]);
  for (const tool of ungated) expect(claimants(tool), tool).toEqual(['ChatAnkiToolExecutor']);
  published = true;
  for (const tool of [...gated, ...ungated]) expect(claimants(tool), tool).toEqual(['ChatAnkiToolExecutor']);
  const unit = units.find((candidate) => candidate.name() === 'ChatAnkiToolExecutor')!;
  for (const tool of gated) {
    expect(unit.sensitivityLevel(tool), tool).toBe('high');
    expect(unit.concurrencyClass(tool), tool).toBe('serial');
  }
});

it('the folded unit claims chatanki_control / chatanki_sync only while L16 publishes anki.pipeline / the sync facade', () => {
  let pipeline = false;
  let sync = false;
  const units = rosterChatAnkiExecutors(createChatAnkiExecutors({
    documentPipeline: () => pipeline, ankiConnectSync: () => sync,
  }));
  const claimants = (tool: string) => units.filter((unit) => unit.canHandle(tool)).map((unit) => unit.name());
  const control = ['chatanki_control', 'builtin-chatanki_control'];
  const syncTools = ['chatanki_sync', 'builtin-chatanki_sync'];
  for (const tool of [...control, ...syncTools]) expect(claimants(tool), tool).toEqual([]);
  pipeline = true;
  for (const tool of control) expect(claimants(tool), tool).toEqual(['ChatAnkiToolExecutor']);
  for (const tool of syncTools) expect(claimants(tool), tool).toEqual([]);
  sync = true;
  for (const tool of syncTools) expect(claimants(tool), tool).toEqual(['ChatAnkiToolExecutor']);
  const unit = units.find((candidate) => candidate.name() === 'ChatAnkiToolExecutor')!;
  for (const tool of control) expect(unit.sensitivityLevel(tool), tool).toBe('low');
  for (const tool of syncTools) expect(unit.sensitivityLevel(tool), tool).toBe('medium');
  for (const tool of [...control, ...syncTools]) expect(unit.concurrencyClass(tool), tool).toBe('serial');
});
