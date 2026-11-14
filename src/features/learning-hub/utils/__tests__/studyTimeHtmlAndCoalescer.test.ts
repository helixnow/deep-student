import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStudyHeatmap, computeHeatLevel, computeStudyTimeStats, formatLocalDateKey,
  MAX_TICK_MS, splitDurationByLocalMidnight, StudyTimeTracker, TICK_MS,
} from '../studyTimeTrackerAndHeatmap';
import {
  applyFencedProgressUpdate, prepareFaithfulHtmlMaterial, ProgressCommandCoalescer,
  progressFieldKey, translateIframeRectToViewport,
  type ProgressUpdate,
} from '../faithfulHtmlMaterialAndCoalescer';

const local = (year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0) =>
  new Date(year, month - 1, day, hours, minutes, seconds).getTime();
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('local study calendar and honest heat levels', () => {
  it('formats local early-morning calendar components rather than UTC dates', () => {
    const date = new Date(2026, 0, 2, 1, 5);
    expect(formatLocalDateKey(date)).toBe('2026-01-02');
    expect(formatLocalDateKey(date.getTime())).toBe('2026-01-02');
    // This fails immediately if the implementation tries to serialize a UTC date.
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw new Error('utc_forbidden'); });
    expect(formatLocalDateKey(date)).toBe('2026-01-02');
  });

  it('splits a 15-second heartbeat exactly at local midnight across a year boundary', () => {
    expect(splitDurationByLocalMidnight(local(2026, 12, 31, 23, 59, 50), local(2027, 1, 1, 0, 0, 5))).toEqual([
      { date: '2026-12-31', seconds: 10 }, { date: '2027-01-01', seconds: 5 },
    ]);
  });

  it('preserves subsecond precision and splits multi-day intervals without an arbitrary day limit', () => {
    const from = local(2026, 2, 27, 23, 59, 59) + 250;
    const to = local(2026, 3, 10, 0, 0, 1) + 125;
    const slices = splitDurationByLocalMidnight(from, to);
    expect(slices[0]).toEqual({ date: '2026-02-27', seconds: 0.75 });
    expect(slices.at(-1)).toEqual({ date: '2026-03-10', seconds: 1.125 });
    expect(slices.reduce((sum, slice) => sum + slice.seconds, 0)).toBe((to - from) / 1000);
    expect(slices).toHaveLength(12);
  });

  it('uses calendar midnights rather than fixed 24-hour steps at daylight-saving changes', () => {
    for (const [month, day] of [[3, 8], [11, 1]]) {
      const from = local(2026, month, day);
      const next = new Date(from);
      next.setDate(next.getDate() + 1);
      const to = next.getTime();
      expect(splitDurationByLocalMidnight(from, to)).toEqual([
        { date: formatLocalDateKey(from), seconds: (to - from) / 1000 },
      ]);
    }
  });

  it.each([[0, 1], [1, 1], [2, 1], [Number.NaN, 2], [0, Infinity]])('ignores invalid/reversed interval %s..%s', (from, to) => {
    if (from === 0 && to === 1) expect(splitDurationByLocalMidnight(from, to)[0].seconds).toBe(0.001);
    else expect(splitDurationByLocalMidnight(from, to)).toEqual([]);
  });

  it.each([[0, 0], [-1, 0], [1, 1], [899, 1], [900, 2], [2699, 2], [2700, 3], [5399, 3], [5400, 4]])(
    'uses absolute level for %s seconds', (seconds, level) => { expect(computeHeatLevel(seconds)).toBe(level); },
  );

  it('keeps yesterday streak alive before today starts, but breaks after an absent yesterday', () => {
    const rows = [{ date: '2026-09-16', seconds: 10 }, { date: '2026-09-17', seconds: 20 }, { date: '2026-09-18', seconds: 0 }];
    expect(computeStudyTimeStats(rows, '2026-09-18').currentStreak).toBe(2);
    expect(computeStudyTimeStats([...rows, { date: '2026-09-18', seconds: 1 }], '2026-09-18').currentStreak).toBe(3);
    expect(computeStudyTimeStats(rows, '2026-09-19').currentStreak).toBe(0);
  });

  it('separates lifetime active-day average from the seven-calendar-day window', () => {
    const stats = computeStudyTimeStats([
      { date: '2020-01-01', seconds: 9000 },
      { date: '2026-09-12', seconds: 210 },
      { date: '2026-09-18', seconds: 210 },
      { date: '2026-09-18', seconds: 280 },
      { date: '2026-09-19', seconds: 9999 },
    ], '2026-09-18');
    expect(stats).toMatchObject({ totalSeconds: 9700, activeDays: 3, todaySeconds: 490,
      last7DaysSeconds: 700, last7DaysActiveDays: 2, last7DaysAverageSeconds: 100,
      totalAverageSeconds: 9700 / 3, best: { date: '2020-01-01', seconds: 9000 } });
    expect(computeStudyTimeStats([], '2026-09-18')).toMatchObject({ totalAverageSeconds: 0, last7DaysAverageSeconds: 0, longestStreak: 0, best: null });
  });

  it('finds longest streak across month boundaries, merging duplicate daily deltas', () => {
    expect(computeStudyTimeStats([
      { date: '2026-08-30', seconds: 1 }, { date: '2026-08-31', seconds: 2 },
      { date: '2026-09-01', seconds: 3 }, { date: '2026-09-01', seconds: 2 },
      { date: '2026-09-18', seconds: 1 },
    ], '2026-09-18')).toMatchObject({ longestStreak: 3, currentStreak: 1, activeDays: 4 });
  });

  it('builds Sunday-first rectangular weeks with future placeholders and month-column metadata', () => {
    const heatmap = buildStudyHeatmap({ today: '2026-09-18', weeks: 4,
      seconds: new Map([['2026-09-18', 300], ['2026-09-19', 9000]]) });
    expect(heatmap.weeks).toHaveLength(4);
    expect(heatmap.weeks.every((week) => week.length === 7)).toBe(true);
    expect(heatmap.weeks[0][0].date).toBe('2026-08-23');
    expect(heatmap.weeks[3][5]).toEqual({ date: '2026-09-18', seconds: 300, level: 1, future: false });
    expect(heatmap.weeks[3][6]).toEqual({ date: '2026-09-19', seconds: 0, level: 0, future: true });
    expect(heatmap.months).toContainEqual({ index: 1, month: 9, year: 2026 });
    expect(buildStudyHeatmap({ today: '2026-09-18', weeks: 1, seconds: new Map() }).months[0]).toEqual({ index: 0, month: 9, year: 2026 });
  });
});

describe('study heartbeat state machine', () => {
  function tracker(options: Partial<ConstructorParameters<typeof StudyTimeTracker>[0]> = {}) {
    return new StudyTimeTracker({ persist: vi.fn().mockResolvedValue(undefined), now: () => 0, isPageVisible: true, ...options });
  }

  it('requires visibility and recent activity, exempting playing media even when idle', () => {
    const t = tracker({ idleThresholdMs: 1000 });
    expect(t.shouldCount(999)).toBe(true);
    expect(t.shouldCount(1000)).toBe(false);
    t.setMediaPlaying(true, 1000);
    expect(t.shouldCount(999_999)).toBe(true);
    t.setPageVisible(false, 1001);
    expect(t.shouldCount(1002)).toBe(false);
    t.setPageVisible(true, 2000);
    t.clearMediaPlaying(3000);
    expect(t.isMediaPlaying).toBe(false);
    expect(t.shouldCount(3001)).toBe(false);
  });

  it('caps sleep at 30 seconds and always advances the tick while idle', () => {
    const t = tracker();
    t.setMediaPlaying(true, 0);
    t.tick(4 * 3600_000);
    expect(t.getRealtimeDays()[0].seconds).toBe(MAX_TICK_MS / 1000);
    t.clearMediaPlaying(4 * 3600_000);
    t.tick(5 * 3600_000);
    expect(t.lastTickMs).toBe(5 * 3600_000);
    t.recordUserInteraction(5 * 3600_000);
    t.tick(5 * 3600_000 + TICK_MS);
    expect(t.getRealtimeDays().reduce((sum, row) => sum + row.seconds, 0)).toBe(45);
  });

  it('does not bill hidden time on resume', async () => {
    const t = tracker();
    t.setPageVisible(false, 1000);
    t.setPageVisible(true, 300_000);
    t.tick(315_000);
    expect(t.getRealtimeDays().reduce((sum, row) => sum + row.seconds, 0)).toBe(16);
    await t.flush();
  });

  it('splits tracker pending at midnight using the same local dates', () => {
    const t = tracker({ now: () => local(2026, 9, 18, 23, 59, 50) });
    t.tick(local(2026, 9, 19, 0, 0, 5));
    expect([...t.pendingByDate]).toEqual([['2026-09-18', 10], ['2026-09-19', 5]]);
  });

  it('keeps UI totals steady until commit and preserves deltas accrued during the write', async () => {
    const commit = deferred();
    const persist = vi.fn().mockReturnValueOnce(commit.promise).mockResolvedValue(undefined);
    const date = formatLocalDateKey(0);
    const t = tracker({ persist, persistedDays: [{ date, seconds: 100 }] });
    t.tick(15_000);
    const flushed = t.flush();
    await Promise.resolve();
    expect(t.pendingByDate.get(date)).toBe(15);
    expect(t.getRealtimeSeconds(date)).toBe(115);
    t.tick(30_000);
    expect(t.getRealtimeSeconds(date)).toBe(130);
    commit.resolve();
    await flushed;
    expect(t.pendingByDate.get(date)).toBe(15);
    expect(t.getRealtimeSeconds(date)).toBe(130);
    await t.flush();
    expect(t.pendingByDate.size).toBe(0);
    expect(t.getRealtimeSeconds(date)).toBe(130);
  });

  it('retains failed deltas, retries safely and serializes overlapping flush requests', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk_full')).mockResolvedValue(undefined);
    const t = tracker({ persist });
    t.tick(15_000);
    await t.flush();
    expect(t.pendingByDate.size).toBe(1);
    await Promise.all([t.flush(), t.flush(), t.flush()]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(t.pendingByDate.size).toBe(0);
    expect(t.getRealtimeSeconds(formatLocalDateKey(0))).toBe(15);
  });

  it('owns a single 15-second timer, flushes each minute and clears media/listeners on stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 9, 18, 10));
    const persist = vi.fn().mockResolvedValue(undefined);
    const t = new StudyTimeTracker({ persist });
    t.start(); t.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toEqual([{ date: '2026-09-18', seconds: 60 }]);
    t.setMediaPlaying(true);
    await t.stop();
    expect(t.isMediaPlaying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const interaction = t.lastUserInteractionMs;
    vi.setSystemTime(Date.now() + 1000);
    window.dispatchEvent(new Event('pointerdown'));
    expect(t.lastUserInteractionMs).toBe(interaction);
  });

  it('does not turn frequent playback-state changes into extra database heartbeats', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const t = tracker({ persist });
    for (let i = 0; i < 8; i++) t.setMediaPlaying(i % 2 === 0, i * 100);
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    t.tick(15_000); t.tick(30_000); t.tick(45_000); t.tick(60_000);
    await t.flush();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('faithful sandbox HTML and same-source material anchors', () => {
  it('preserves layout/style and generates merged heading anchors and blocks in one order', () => {
    const prepared = prepareFaithfulHtmlMaterial(`<!doctype html><html><head><title>Original</title>
      <style>.layout{display:grid;color:rgb(1,2,3)}</style></head><body>
      <div class="layout" data-mr-unit="999"><h1>Heading</h1><h2>Subheading</h2>
      <p style="font-size:18px">First <strong>body</strong></p><table><tr><td>Cell</td></tr></table>
      <blockquote><p>Nested quotation</p></blockquote><h3>Trailing title</h3></div></body></html>`, { allowRemoteResources: true });
    const doc = parse(prepared.html);
    expect(doc.title).toBe('Original');
    expect(doc.querySelector('style')?.textContent).toContain('display:grid');
    expect(doc.querySelector('p')?.getAttribute('style')).toBe('font-size:18px');
    expect(doc.querySelector('.layout')?.hasAttribute('data-mr-unit')).toBe(false);
    expect(prepared.materialBlocks.map((block) => block.text)).toEqual([
      'Heading\n\nSubheading\n\nFirst body', 'Cell', 'Nested quotation', 'Trailing title',
    ]);
    expect([...doc.querySelectorAll('[data-mr-unit]')].map((node) => Number(node.getAttribute('data-mr-unit')))).toEqual([1, 1, 1, 2, 3, 4]);
    for (const block of prepared.materialBlocks) {
      const nodes = [...doc.querySelectorAll(`[data-mr-unit="${block.unit}"]`)];
      expect(nodes.map((node) => node.textContent?.trim()).join('\n\n')).toBe(block.text);
      expect(parse(block.html).body.querySelector('[data-mr-unit]')?.getAttribute('data-mr-unit')).toBe(String(block.unit));
    }
  });

  it('extracts leaf div and plain text fallback without marking shared containers or hidden content', () => {
    const prepared = prepareFaithfulHtmlMaterial('<main><div>One</div><div>Two</div><p hidden>Hidden</p><section aria-hidden="true"><p>Also hidden</p></section></main>', { allowRemoteResources: false });
    const doc = parse(prepared.html);
    expect(prepared.materialBlocks.map((block) => block.text)).toEqual(['One', 'Two']);
    expect(doc.querySelector('main')?.hasAttribute('data-mr-unit')).toBe(false);
    expect(doc.querySelector('[hidden]')?.hasAttribute('data-mr-unit')).toBe(false);
    expect(prepareFaithfulHtmlMaterial('Only text', { allowRemoteResources: false }).materialBlocks[0].text).toBe('Only text');
    expect(prepareFaithfulHtmlMaterial('', { allowRemoteResources: false }).materialBlocks).toEqual([]);
  });

  it('removes executable/form nodes, refresh, spoofed CSP, event handlers and obfuscated javascript URLs', () => {
    const prepared = prepareFaithfulHtmlMaterial(`<head><meta http-equiv="refresh" content="0;url=/escape">
      <meta http-equiv="Content-Security-Policy" content="script-src *"><base href="https://bad.test/"></head>
      <body onload="evil()"><script>evil()</script><noscript>no</noscript><template><p>fake</p></template>
      <iframe srcdoc="bad"></iframe><frame><object></object><embed><form><p>fake</p><input></form>
      <button>submit</button><select><option>fake</option></select><textarea>fake</textarea>
      <svg><script>evil()</script><a xlink:href="java&#10;script:evil()">svg</a></svg>
      <p onclick="evil()">Safe <a href="javascript:evil()" onfocus="evil()">text</a></p></body>`, { allowRemoteResources: true });
    const doc = parse(prepared.html);
    expect(doc.querySelector('script,noscript,template,iframe,frame,object,embed,form,input,button,select,textarea,base')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect([...doc.querySelectorAll('*')].flatMap((node) => [...node.attributes]).some((attr) => attr.name.startsWith('on') || /javascript:/i.test(attr.value))).toBe(false);
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1);
    expect(doc.head.firstElementChild?.getAttribute('content')).toContain("script-src 'none'");
    expect(prepared.sandboxAttribute).toBe('allow-same-origin');
    expect(prepared.sandboxAttribute).not.toContain('allow-scripts');
  });

  it('blocks and counts relative image/styles/CSS resources while retaining safe absolute/data/fragment references', () => {
    const prepared = prepareFaithfulHtmlMaterial(`<head><link rel="stylesheet" href="assets/x.css">
      <style>@import "relative.css"; @import url("https://fonts.test/x.css");
      .a{background:url('./a.png')} .b{background:url(https://cdn.test/b.png)}
      .c{background:url(data:image/png;base64,abcd)}</style></head><body>
      <img src="./a.png" srcset="a.png 1x, b.png 2x"><img src="/host.png"><img src="https://cdn.test/image.png">
      <img src="data:image/png;base64,abcd"><p style="background:url(assets/inline.png)">body</p>
      <a href="#target">Jump</a><link rel="preload" href="https://bad.test/preload"></body>`, { allowRemoteResources: true });
    const doc = parse(prepared.html);
    expect(prepared.blockedRelativeResourceCount).toBe(6);
    expect(doc.querySelector('link[rel="stylesheet"]')?.hasAttribute('href')).toBe(false);
    expect([...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([null, null, 'https://cdn.test/image.png', 'data:image/png;base64,abcd']);
    expect(doc.querySelector('[srcset]')).toBeNull();
    expect(doc.querySelector('style')?.textContent).not.toContain('@import');
    expect(doc.querySelector('style')?.textContent).toContain('url(about:invalid)');
    expect(doc.querySelector('style')?.textContent).toContain('url(https://cdn.test/b.png)');
    expect(doc.querySelector('p')?.getAttribute('style')).toContain('url(about:invalid)');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('#target');
    expect(doc.querySelector('link[rel="preload"]')).toBeNull();
  });

  it.each([true, false])('uses independent first-head CSP and remote-resource policy: %s', (allowRemoteResources) => {
    const prepared = prepareFaithfulHtmlMaterial('<head><link rel="stylesheet" href="https://cdn.test/x.css"><style>.x{background:url(//cdn.test/x.png)}</style></head><body><p>body</p><img src="https://cdn.test/x.png"></body>', { allowRemoteResources });
    const doc = parse(prepared.html);
    const csp = doc.head.firstElementChild?.getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp?.includes('https: http:')).toBe(allowRemoteResources);
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(allowRemoteResources);
    expect(doc.querySelector('link')?.hasAttribute('href')).toBe(allowRemoteResources);
    expect(doc.querySelector('style')?.textContent?.includes('url(//cdn.test/x.png)')).toBe(allowRemoteResources);
  });

  it('translates selection coordinates by the iframe viewport offset', () => {
    expect(translateIframeRectToViewport({ left: 12, top: 20, width: 100, height: 18 }, { left: 235, top: 80 })).toEqual({
      left: 247, top: 100, x: 247, y: 100, right: 347, bottom: 118, width: 100, height: 18,
    });
  });
});

describe('400/1000ms progress command coalescing and field fences', () => {
  const input = (value: number, field = 'readingPosition', resourceId = 'resource', scopeId = 'scope') => ({ value, field, resourceId, scopeId });

  it('debounces unsent same-field updates for 400ms, retaining the latest replacement', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const c = new ProgressCommandCoalescer<number>({ send });
    expect(c.enqueue(input(1)).sequenceFence).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(c.enqueue(input(2)).sequenceFence).toBe(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ ...input(2), sequenceFence: 2 });
    await c.dispose();
  });

  it('enforces the 1000ms maximum delay under continuous input and starts the next window anew', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const c = new ProgressCommandCoalescer<number>({ send });
    c.enqueue(input(0));
    for (let i = 1; i <= 3; i++) { await vi.advanceTimersByTimeAsync(300); c.enqueue(input(i)); }
    await vi.advanceTimersByTimeAsync(99);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledWith({ ...input(3), sequenceFence: 4 });
    c.enqueue(input(4));
    await vi.advanceTimersByTimeAsync(400);
    expect(send).toHaveBeenLastCalledWith({ ...input(4), sequenceFence: 5 });
  });

  it('isolates sequences and timers by scope/resource/field, flushing last positions on dispose', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const c = new ProgressCommandCoalescer<number>({ send });
    c.enqueue(input(1));
    c.enqueue(input(2, 'playbackPosition'));
    c.enqueue(input(3, 'readingPosition', 'other'));
    c.enqueue(input(4, 'readingPosition', 'resource', 'other-scope'));
    c.enqueue(input(5));
    await c.dispose();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(([update]) => update.sequenceFence)).toEqual([2, 1, 1, 1]);
    expect(vi.getTimerCount()).toBe(0);
    expect(progressFieldKey({ scopeId: 'a/b', resourceId: 'c', field: 'd' })).not.toBe(progressFieldKey({ scopeId: 'a', resourceId: 'b/c', field: 'd' }));
  });

  it('drops delayed old network replies while permitting intentional newer backwards seeks', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const state = new Map<string, ProgressUpdate<number>>();
    const send = vi.fn(async (update: ProgressUpdate<number>) => {
      if (update.sequenceFence === 1) await first.promise;
      applyFencedProgressUpdate(state, update);
    });
    const c = new ProgressCommandCoalescer<number>({ send });
    c.enqueue(input(80, 'playbackPosition'));
    await vi.advanceTimersByTimeAsync(400);
    c.enqueue(input(90, 'playbackPosition'));
    await vi.advanceTimersByTimeAsync(400);
    expect([...state.values()][0].value).toBe(90);
    first.resolve();
    await c.flush();
    expect([...state.values()][0]).toMatchObject({ value: 90, sequenceFence: 2 });
    c.enqueue(input(10, 'playbackPosition'));
    await c.flush();
    expect([...state.values()][0]).toMatchObject({ value: 10, sequenceFence: 3 });
  });

  it('accepts fences independently for each field and rejects duplicates/invalid sequences atomically', () => {
    const state = new Map<string, ProgressUpdate<number>>();
    const newest = { ...input(20), sequenceFence: 5 };
    expect(applyFencedProgressUpdate(state, newest)).toBe(true);
    for (const sequenceFence of [5, 4, 0, -1, NaN, Infinity, 1.5]) {
      expect(applyFencedProgressUpdate(state, { ...input(99), sequenceFence })).toBe(false);
    }
    expect(applyFencedProgressUpdate(state, { ...input(4, 'playbackPosition'), sequenceFence: 1 })).toBe(true);
    expect(state.get(progressFieldKey(newest))).toEqual(newest);
    expect(state.size).toBe(2);
  });

  it('reports send failures without blocking unrelated fields or resetting their fences', async () => {
    vi.useFakeTimers();
    const error = new Error('offline');
    const onError = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const c = new ProgressCommandCoalescer<number>({ send, onError });
    const failed = c.enqueue(input(1));
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledWith(error, failed);
    expect(c.enqueue(input(2)).sequenceFence).toBe(2);
    await c.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
