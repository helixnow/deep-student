import { describe, expect, it } from 'vitest';
import { foldHistoricalBrowserSnapshots } from '../api.ts';
import type { LegacyChatMessage } from '../src/microcompact.ts';

function wrapSnapshot(
  url: string,
  body: string,
  kind: 'browser_snapshot' | 'browser_extract' | 'browser_observe' = 'browser_snapshot',
): string {
  return `<untrusted_web_content source="${url}" fetched_at="2026-11-27T00:00:00.000Z" kind="${kind}">\n`
    + 'WARNING: untrusted data\n'
    + '---\n'
    + `${body}\n`
    + '---\n'
    + '</untrusted_web_content>';
}

function browserToolMessage(
  callId: string,
  payload: Record<string, unknown>,
): LegacyChatMessage {
  return {
    role: 'tool',
    content: JSON.stringify(payload),
    tool_result: {
      call_id: callId,
      ok: true,
      error: null,
      data_json: payload,
    },
  };
}

describe('foldHistoricalBrowserSnapshots', () => {
  it('keeps the latest 2 browser snapshots intact and folds older ones while preserving metadata', () => {
    const snap1 = wrapSnapshot('https://example.com/1', 'PAGE 1 CONTENT '.repeat(40));
    const snap2 = wrapSnapshot('https://example.com/2', 'PAGE 2 CONTENT '.repeat(40));
    const snap3 = wrapSnapshot('https://example.com/3', 'PAGE 3 CONTENT '.repeat(40));
    const snap4 = wrapSnapshot('https://example.com/4', 'PAGE 4 CONTENT '.repeat(40));

    const payload1 = {
      ok: true,
      action: 'click',
      ref: 'e12',
      url: 'https://example.com/1',
      title: 'Step 1',
      session_id: 'bs-1',
      ref_epoch: 1,
      snapshot: snap1,
    };
    const payload2 = {
      ok: true,
      action: 'snapshot',
      url: 'https://example.com/2',
      title: 'Step 2',
      session_id: 'bs-1',
      ref_epoch: 2,
      snapshot: snap2,
    };
    const payload3 = {
      ok: true,
      action: 'snapshot',
      url: 'https://example.com/3',
      title: 'Step 3',
      session_id: 'bs-1',
      ref_epoch: 3,
      snapshot: snap3,
    };
    const payload4 = {
      ok: true,
      action: 'snapshot',
      url: 'https://example.com/4',
      title: 'Step 4',
      session_id: 'bs-1',
      ref_epoch: 4,
      snapshot: snap4,
    };

    const messages: LegacyChatMessage[] = [
      { role: 'user', content: 'Browse four pages' },
      browserToolMessage('call_1', payload1),
      browserToolMessage('call_2', payload2),
      browserToolMessage('call_3', payload3),
      browserToolMessage('call_4', payload4),
    ];

    const folded = foldHistoricalBrowserSnapshots(messages);

    // Non-destructive: original messages and payloads are never mutated.
    expect(folded).not.toBe(messages);
    expect(JSON.parse(messages[1]!.content).snapshot).toBe(snap1);
    expect((messages[1]!.tool_result!.data_json as Record<string, unknown>).snapshot).toBe(snap1);

    // Older two snapshots are folded with 1-line summary and preserved metadata.
    const parsed1 = JSON.parse(folded[1]!.content) as Record<string, unknown>;
    expect(parsed1).toEqual({
      ok: true,
      action: 'click',
      ref: 'e12',
      url: 'https://example.com/1',
      title: 'Step 1',
      session_id: 'bs-1',
      ref_epoch: 1,
      snapshot: `[earlier browser snapshot folded: url=https://example.com/1, title=Step 1, epoch=1, chars=${snap1.length}; inspect latest snapshot for current page state]`,
    });
    expect(folded[1]!.tool_result!.data_json).toEqual(parsed1);

    const parsed2 = JSON.parse(folded[2]!.content) as Record<string, unknown>;
    expect(parsed2.snapshot).toBe(
      `[earlier browser snapshot folded: url=https://example.com/2, title=Step 2, epoch=2, chars=${snap2.length}; inspect latest snapshot for current page state]`,
    );

    // Latest two snapshots remain completely intact.
    expect(JSON.parse(folded[3]!.content).snapshot).toBe(snap3);
    expect(JSON.parse(folded[4]!.content).snapshot).toBe(snap4);
    expect(folded[3]).toBe(messages[3]);
    expect(folded[4]).toBe(messages[4]);
  });

  it('leaves non-browser tools and non-tool messages completely untouched', () => {
    const ragPayload = { ok: true, sources: [{ title: 'Lecture 1', content: 'Linear algebra' }] };
    const webFetchPayload = {
      ok: true,
      url: 'https://docs.example.com',
      content: '<untrusted_web_content source="https://docs.example.com" kind="web_fetch">hello</untrusted_web_content>',
    };
    const snap1 = wrapSnapshot('https://a.example', 'A');
    const snap2 = wrapSnapshot('https://b.example', 'B');
    const snap3 = wrapSnapshot('https://c.example', 'C');

    const messages: LegacyChatMessage[] = [
      { role: 'assistant', content: '<untrusted_web_content kind="browser_snapshot">quoted</untrusted_web_content>' },
      browserToolMessage('rag_1', ragPayload),
      browserToolMessage('fetch_1', webFetchPayload),
      { role: 'tool', content: 'plain non-json tool output' },
      browserToolMessage('snap_1', { ok: true, url: 'https://a.example', title: 'A', ref_epoch: 1, snapshot: snap1 }),
      browserToolMessage('snap_2', { ok: true, url: 'https://b.example', title: 'B', ref_epoch: 2, snapshot: snap2 }),
      browserToolMessage('snap_3', { ok: true, url: 'https://c.example', title: 'C', ref_epoch: 3, snapshot: snap3 }),
    ];

    const folded = foldHistoricalBrowserSnapshots(messages);

    expect(folded[0]).toBe(messages[0]);
    expect(folded[1]).toBe(messages[1]);
    expect(folded[2]).toBe(messages[2]);
    expect(folded[3]).toBe(messages[3]);
    expect(JSON.parse(folded[4]!.content).snapshot).toContain('[earlier browser snapshot folded:');
    expect(JSON.parse(folded[5]!.content).snapshot).toBe(snap2);
    expect(JSON.parse(folded[6]!.content).snapshot).toBe(snap3);
  });

  it('folds historical browser_extract payloads in content and markdown fields', () => {
    const extract1 = wrapSnapshot('https://wiki.example/1', '# Article 1\n'.repeat(30), 'browser_extract');
    const extract2 = wrapSnapshot('https://wiki.example/2', '# Article 2\n'.repeat(30), 'browser_extract');
    const extract3 = wrapSnapshot('https://wiki.example/3', '# Article 3\n'.repeat(30), 'browser_extract');

    const messages: LegacyChatMessage[] = [
      browserToolMessage('ext_1', {
        ok: true,
        action: 'extract_content',
        url: 'https://wiki.example/1',
        title: 'Wiki 1',
        session_id: 'bs-2',
        content: extract1,
      }),
      browserToolMessage('ext_2', {
        ok: true,
        action: 'extract_content',
        url: 'https://wiki.example/2',
        title: 'Wiki 2',
        session_id: 'bs-2',
        markdown: extract2,
      }),
      browserToolMessage('ext_3', {
        ok: true,
        action: 'extract_content',
        url: 'https://wiki.example/3',
        title: 'Wiki 3',
        session_id: 'bs-2',
        content: extract3,
      }),
    ];

    const folded = foldHistoricalBrowserSnapshots(messages, { keepRecentSnapshots: 1 });

    const parsed1 = JSON.parse(folded[0]!.content) as Record<string, unknown>;
    expect(parsed1.action).toBe('extract_content');
    expect(parsed1.content).toBe(
      `[earlier browser snapshot folded: url=https://wiki.example/1, title=Wiki 1, epoch=none, chars=${extract1.length}; inspect latest snapshot for current page state]`,
    );

    const parsed2 = JSON.parse(folded[1]!.content) as Record<string, unknown>;
    expect(parsed2.markdown).toBe(
      `[earlier browser snapshot folded: url=https://wiki.example/2, title=Wiki 2, epoch=none, chars=${extract2.length}; inspect latest snapshot for current page state]`,
    );

    const parsed3 = JSON.parse(folded[2]!.content) as Record<string, unknown>;
    expect(parsed3.content).toBe(extract3);

    // Folding again is idempotent (already-folded summaries are not re-folded).
    const foldedAgain = foldHistoricalBrowserSnapshots(folded, { keepRecentSnapshots: 1 });
    expect(foldedAgain[0]!.content).toBe(folded[0]!.content);
    expect(foldedAgain[1]!.content).toBe(folded[1]!.content);
    expect(foldedAgain[2]!.content).toBe(folded[2]!.content);
  });

  it('folds historical browser_observe observations while preserving recent ones and metadata', () => {
    const obs1 = wrapSnapshot('https://app.example/1', JSON.stringify({ console: ['err 1'.repeat(40)] }), 'browser_observe');
    const obs2 = wrapSnapshot('https://app.example/2', JSON.stringify({ network: ['500 '.repeat(40)] }), 'browser_observe');
    const obs3 = wrapSnapshot('https://app.example/3', JSON.stringify({ console: ['ok 3'] }), 'browser_observe');

    const messages: LegacyChatMessage[] = [
      browserToolMessage('obs_1', {
        ok: true,
        action: 'observe',
        kind: 'both',
        url: 'https://app.example/1',
        session_id: 'bs-obs',
        observations: obs1,
      }),
      browserToolMessage('obs_2', {
        ok: true,
        action: 'observe',
        kind: 'network',
        url: 'https://app.example/2',
        session_id: 'bs-obs',
        observations: obs2,
      }),
      browserToolMessage('obs_3', {
        ok: true,
        action: 'observe',
        kind: 'console',
        url: 'https://app.example/3',
        session_id: 'bs-obs',
        observations: obs3,
      }),
    ];

    const folded = foldHistoricalBrowserSnapshots(messages, { keepRecentSnapshots: 1 });
    const parsed1 = JSON.parse(folded[0]!.content) as Record<string, unknown>;
    expect(parsed1).toEqual({
      ok: true,
      action: 'observe',
      kind: 'both',
      url: 'https://app.example/1',
      session_id: 'bs-obs',
      observations: `[earlier browser observations folded: url=https://app.example/1, title=untitled, epoch=none, chars=${obs1.length}; inspect latest observation for current diagnostics]`,
    });
    expect(folded[0]!.tool_result!.data_json).toEqual(parsed1);

    const parsed2 = JSON.parse(folded[1]!.content) as Record<string, unknown>;
    expect(parsed2.observations).toContain('[earlier browser observations folded:');
    expect(JSON.parse(folded[2]!.content).observations).toBe(obs3);
    expect(folded[2]).toBe(messages[2]);

    // Idempotent on second pass.
    const foldedAgain = foldHistoricalBrowserSnapshots(folded, { keepRecentSnapshots: 1 });
    expect(foldedAgain[0]!.content).toBe(folded[0]!.content);
    expect(foldedAgain[1]!.content).toBe(folded[1]!.content);
  });
});
