/**
 * AL-16: `runToolCall` shows a thrown error the way Rust's `Err(String)` / `AppError` Display does — the message
 * of a bare `AppError.*` value instead of `[object Object]`.
 */
import { expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import { runToolCall, type MediaToolContext } from '../src/tools/runtime.ts';

function recordingContext(saveError?: unknown) {
  const events: Array<[string, unknown]> = [];
  const saved: ToolResultInfo[] = [];
  const context: MediaToolContext = {
    session_id: 'sess_w04', block_id: 'blk_w04', vfs_db: null, skill_package_roots: null, cancellation_token: null,
    emitToolCallStart: () => { events.push(['start', null]); },
    emitToolCallEnd: (result) => { events.push(['end', result]); },
    emitToolCallError: (error) => { events.push(['error', error]); },
    saveToolBlock: (result) => {
      if (saveError !== undefined) throw saveError;
      saved.push(result);
    },
  };
  return { context, events, saved };
}

const call = { id: 'call_1', name: 'builtin-media_probe', arguments: {} };

it.each([
  ['a bare AppError value', AppError.validation('bad'), 'bad'],
  ['an Error', new Error('boom'), 'boom'],
  ['a string', 'plain failure', 'plain failure'],
])('a body that throws %s fails the call with its display text', async (_kind, thrown, text) => {
  const { context, events, saved } = recordingContext();
  const result = await runToolCall('MediaProbe', call, context, { warn() {}, debug() {} }, async () => { throw thrown; });
  expect(result).toMatchObject({ success: false, output: null, error: text });
  expect(events.at(-1)).toEqual(['error', text]);
  expect(saved).toEqual([result]);
});

it('a failed tool-block save only warns, with the AppError message', async () => {
  const { context } = recordingContext(AppError.database('database is locked'));
  const warnings: string[] = [];
  const result = await runToolCall('MediaProbe', call, context,
    { warn: (message) => { warnings.push(message); }, debug() {} }, async () => ({ ok: true }));
  expect(result).toMatchObject({ success: true, output: { ok: true } });
  expect(warnings).toEqual(['[MediaProbe] Failed to save tool block: database is locked']);
});
