/**
 * chat_v2/pipeline/llm_content_crash_tests.rs — simulated llm_content sidecar
 * crash windows. The Rust module is test-only and models DB rows/timeline with
 * plain structs; the port keeps the same simulation without touching a DB.
 */
import { describe, expect, it } from 'vitest';

interface BlockRow {
  content: string;
  llmContent: string | null;
}

class TurnTimeline {
  row: BlockRow;
  liveUserLlmContent: string;
  sentToProvider: string | null = null;

  constructor(bareContent: string, wrapped: string) {
    this.row = { content: bareContent, llmContent: null };
    this.liveUserLlmContent = wrapped;
  }

  /** `persist_replay_sidecar` user-block branch before the first network call. */
  earlyPersistUserLlmContent(): void {
    expect(this.sentToProvider).toBeNull();
    this.row.llmContent = this.liveUserLlmContent;
  }

  /** V20260806 not migrated: repo treats `no such column` as a silent no-op. */
  earlyPersistOnUnmigratedDb(): void {
    expect(this.sentToProvider).toBeNull();
  }

  sendToProvider(): void {
    this.sentToProvider = this.liveUserLlmContent;
  }

  /** `ON CONFLICT(id) DO UPDATE SET` keeps sidecar columns untouched. */
  rebuildRowAtSavePoint(): void {
    this.row = { content: this.row.content, llmContent: this.row.llmContent };
  }

  savePointPersistReplaySidecar(): void {
    this.row.llmContent = this.liveUserLlmContent;
  }

  crashBeforeSaveResults(): BlockRow {
    expect(this.sentToProvider).not.toBeNull();
    return this.row;
  }

  crashBeforeFirstSend(): BlockRow {
    expect(this.sentToProvider).toBeNull();
    return this.row;
  }
}

/** history.rs: non-empty llm_content wins over the bare user content. */
function replayUserContent(row: BlockRow): string {
  return row.llmContent !== null && row.llmContent !== '' ? row.llmContent : row.content;
}

/**
 * history.rs multi-block operator order: find_map stops at the first Some
 * (including Some("")), then the whole result is filtered for emptiness.
 */
function replayUserContentFromBlocks(bareFallback: string, blocks: readonly BlockRow[]): string {
  const first = blocks.find(block => block.llmContent !== null);
  const value = first === undefined ? null : first.llmContent;
  return value !== null && value !== '' ? value : bareFallback;
}

const BARE = '帮我总结这份周报';
const WRAPPED = '<user_query>\n帮我总结这份周报\n</user_query>\n\n'
  + '<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n'
  + '</injected_context>';

const BARE_EDITED = '帮我总结这份周报，并单独列出风险项';
const WRAPPED_EDITED = '<user_query>\n帮我总结这份周报，并单独列出风险项\n</user_query>\n\n'
  + '<injected_context>\n<runtime_facts>\n当前日期: 2026-08-27\n</runtime_facts>\n'
  + '</injected_context>';

const WRAPPED_MULTIBYTE = '<user_query>\n总结📝 café 週報\u200brésumé\n</user_query>\n\n'
  + '<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n'
  + '</injected_context>';

describe('chat_v2/pipeline/llm_content_crash_tests.rs', () => {
  it('crash_after_send_without_early_persist_replays_bare_user_content', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.sendToProvider();
    const liveSent = turn.sentToProvider!;
    const row = turn.crashBeforeSaveResults();

    expect(row.llmContent).toBeNull();
    const replayed = replayUserContent(row);
    expect(replayed).toBe(BARE);
    expect(replayed).not.toContain('<user_query>');
    expect(replayed).not.toContain('<injected_context>');
    expect(replayed).not.toBe(liveSent);
  });

  it('crash_after_send_with_early_persist_replays_live_wrapped_bytes', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.earlyPersistUserLlmContent();
    turn.sendToProvider();
    const liveSent = turn.sentToProvider!;
    const row = turn.crashBeforeSaveResults();

    expect(row.llmContent).toBe(WRAPPED);
    const replayed = replayUserContent(row);
    expect(replayed).toBe(liveSent);
    expect(replayed).toContain('<user_query>');
    expect(replayed).toContain('<injected_context>');
  });

  it('empty_llm_content_sidecar_falls_back_to_bare_content', () => {
    expect(replayUserContent({ content: BARE, llmContent: '' })).toBe(BARE);
  });

  it('whitespace_only_llm_content_sidecar_is_replayed_verbatim', () => {
    expect(replayUserContent({ content: BARE, llmContent: ' \n\t' })).toBe(' \n\t');
  });

  it('crash_before_first_send_is_harmless_no_cross_turn_drift', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    const row = turn.crashBeforeFirstSend();
    expect(row.llmContent).toBeNull();
    expect(replayUserContent(row)).toBe(BARE);
  });

  it('crash_after_early_persist_before_send_replays_persisted_wrapper', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.earlyPersistUserLlmContent();
    const row = turn.crashBeforeFirstSend();

    expect(row.llmContent).toBe(WRAPPED);
    const replayed = replayUserContent(row);
    expect(replayed).toBe(WRAPPED);
    expect(replayed).not.toBe(BARE);
  });

  it('save_point_rebuild_preserves_early_sidecar_and_rewrites_idempotently', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.earlyPersistUserLlmContent();
    turn.sendToProvider();
    const liveSent = turn.sentToProvider!;

    turn.rebuildRowAtSavePoint();
    expect(turn.row.llmContent).toBe(WRAPPED);

    turn.savePointPersistReplaySidecar();
    expect(turn.row.llmContent).toBe(WRAPPED);

    expect(replayUserContent(turn.crashBeforeSaveResults())).toBe(liveSent);
  });

  it('edit_resend_invalidates_stale_sidecar_then_early_persist_backfills', () => {
    const row: BlockRow = { content: BARE, llmContent: WRAPPED };

    // Edit transaction: new bare content, invalidate the old sidecar.
    row.content = BARE_EDITED;
    row.llmContent = null;

    const replayedPreEarly = replayUserContent(row);
    expect(replayedPreEarly).toBe(BARE_EDITED);
    expect(replayedPreEarly).not.toBe(WRAPPED);

    row.llmContent = WRAPPED_EDITED;
    const replayed = replayUserContent(row);
    expect(replayed).toBe(WRAPPED_EDITED);
    expect(replayed).not.toBe(WRAPPED);
  });

  it('unmigrated_db_early_persist_silently_skips_and_never_blocks_send', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.earlyPersistOnUnmigratedDb();
    expect(turn.row.llmContent).toBeNull();

    turn.sendToProvider();
    expect(turn.sentToProvider).toBe(WRAPPED);

    expect(replayUserContent(turn.crashBeforeSaveResults())).toBe(BARE);
  });

  it('legacy_multi_content_blocks_write_and_read_hit_same_first_row', () => {
    const blocks: BlockRow[] = [
      { content: BARE, llmContent: WRAPPED },
      { content: '孤儿块残留', llmContent: null },
    ];
    expect(replayUserContentFromBlocks(BARE, blocks)).toBe(WRAPPED);
  });

  it('legacy_multi_content_blocks_empty_first_sidecar_masks_later_wrapper', () => {
    const blocks: BlockRow[] = [
      { content: BARE, llmContent: '' },
      { content: '孤儿块残留', llmContent: WRAPPED },
    ];
    expect(replayUserContentFromBlocks(BARE, blocks)).toBe(BARE);
  });

  it('early_persist_preserves_multibyte_bytes_exactly', () => {
    const turn = new TurnTimeline(BARE, WRAPPED_MULTIBYTE);
    turn.earlyPersistUserLlmContent();
    turn.sendToProvider();
    const liveSent = turn.sentToProvider!;
    const row = turn.crashBeforeSaveResults();

    const replayed = replayUserContent(row);
    expect(Buffer.from(replayed, 'utf8').equals(Buffer.from(liveSent, 'utf8'))).toBe(true);
    expect(Buffer.byteLength(replayed, 'utf8')).toBe(Buffer.byteLength(WRAPPED_MULTIBYTE, 'utf8'));
  });

  it('multi_variant_fanout_without_early_persist_crash_window_remains', () => {
    const turn = new TurnTimeline(BARE, WRAPPED);
    turn.sendToProvider();
    const liveSent = turn.sentToProvider!;
    const row = turn.crashBeforeSaveResults();

    expect(row.llmContent).toBeNull();
    expect(replayUserContent(row)).not.toBe(liveSent);
  });
});
