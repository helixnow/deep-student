import { expect, it } from 'vitest';
import { BridgeHub } from '../src/bilibili-bridge-hub.ts';
import { BiliAttempt } from '../src/bilibili-attempt.ts';
import { BiliLookupClient, descriptorFromLookup } from '../src/bilibili-client.ts';
import { BiliTransportState } from '../src/bilibili-transport.ts';
import {
  DEFAULT_QN, INITIAL_CHUNK_BYTES, fetchCandidates, resolvePlayInfo,
  type BiliAttemptLike,
} from '../src/bilibili-stream.ts';
import { parseSubtitle } from '../src/subtitle.ts';

const live = process.env.DS_BILIBILI_LIVE === '1';

it.skipIf(!live)('live_native_playurl_and_range_share_one_attempt', async () => {
  const state = new BiliTransportState({ get: () => null, save: () => undefined });
  const attempt = await BiliAttempt.begin({
    state,
    hub: new BridgeHub(),
    nativeCookie: null,
  }, true);
  const client = new BiliLookupClient('https://api.bilibili.com', { attempt });
  const video = process.env.DS_BILIBILI_LIVE_VIDEO ?? 'BV1GJ411x7h7';
  const lookup = await client.lookup(video, null);
  const descriptor = descriptorFromLookup(lookup);
  const info = await resolvePlayInfo(client, descriptor, DEFAULT_QN);
  const adapter: BiliAttemptLike = {
    execute: request => attempt.execute({
      kind: request.kind ?? 'media',
      url: new URL(request.url),
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body ?? new Uint8Array(0),
      maxBytes: request.maxBytes ?? INITIAL_CHUNK_BYTES,
      deadlineMs: request.deadlineMs,
    }),
  };
  const [response] = await fetchCandidates(
    adapter, info, 0, INITIAL_CHUNK_BYTES - 1);
  expect(response.kind).toBe('ok');
  if (response.kind === 'ok') {
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.length).toBeLessThanOrEqual(INITIAL_CHUNK_BYTES);
    expect(response.contentRange).not.toBeNull();
  }
}, 120_000);

it.skipIf(!live)('live_lookup_fetches_real_subtitles', async () => {
  const state = new BiliTransportState({ get: () => null, save: () => undefined });
  const attempt = await BiliAttempt.begin({
    state,
    hub: new BridgeHub(),
    nativeCookie: null,
  }, true);
  const client = new BiliLookupClient('https://api.bilibili.com', { attempt });
  const video = process.env.DS_BILIBILI_LIVE_VIDEO ?? 'BV1GJ411x7h7';
  const lookup = await client.lookup(video, null);
  expect(lookup.tracks.length).toBeGreaterThan(0);
  const [track, bytes] = await client.subtitleBytes(lookup, null);
  const cues = parseSubtitle('bilibili.json', bytes);
  expect(cues.length).toBeGreaterThan(0);
  expect(track.lan.length).toBeGreaterThan(0);
}, 120_000);
