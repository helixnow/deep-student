import { expect, it } from 'vitest';
import {
  BridgeHub, parseBridgeControl, type BridgeAccount, type BridgeCancellation,
  type BridgeChannel, type BridgeRequest, type BridgeReply,
} from '../src/bilibili-bridge-hub.ts';
import { BiliRequestError } from '../src/bilibili-policy.ts';

class TestChannel implements BridgeChannel {
  readonly sent: string[] = [];
  closed = 0;
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closed += 1; }
}

function paired(): [BridgeHub, string, TestChannel] {
  const hub = new BridgeHub();
  const challenge = hub.startPairing(42);
  const channel = new TestChannel();
  const id = hub.authenticate(challenge, 42, '1.0.0', channel);
  return [hub, id, channel];
}

it('pairing_is_one_use_port_bound_and_requires_app_approval', () => {
  const hub = new BridgeHub();
  const challenge = hub.startPairing(42);
  expect(() => hub.authenticate(challenge, 43, '1.0.0', new TestChannel())).toThrow();
  const id = hub.authenticate(challenge, 42, '1.0.0', new TestChannel());
  expect(hub.approved(id)).toBe(false);
  expect(() => hub.authenticate(challenge, 42, '1.0.0', new TestChannel())).toThrow();
  expect(() => hub.approve('another-tab')).toThrow();
  hub.approve(id);
  hub.ready(id, { loggedIn: true, mid: 7, uname: null }, true);
  expect(() => hub.verifyAccount(id, { loggedIn: true, mid: 8, uname: null })).toThrow();
  expect(hub.status().parsing).toBe(false);
});

it('reconnect_rotates_token_and_requires_same_account', () => {
  const [hub, id] = paired();
  hub.approve(id);
  const token = hub.resumeToken(id);
  const account: BridgeAccount = { loggedIn: true, mid: 42, uname: null };
  hub.ready(id, account, true);
  hub.disconnect(id);
  const reconnected = hub.reconnect(token, new TestChannel());
  expect(() => hub.reconnect(token, new TestChannel())).toThrow();
  expect(() => hub.checkResumedAccount(account)).not.toThrow();
  expect(() => hub.checkResumedAccount({ loggedIn: false, mid: null, uname: null })).toThrow();
  const rotated = hub.resumeToken(reconnected);
  expect(rotated).not.toBe(token);
  hub.revoke();
  expect(() => hub.reconnect(rotated, new TestChannel())).toThrow();
});

it('live_approved_pairing_renews_the_idle_lease_but_disconnect_does_not', () => {
  const [hub, id] = paired();
  expect(hub.shouldRenewLease()).toBe(false);
  hub.approve(id);
  expect(hub.shouldRenewLease()).toBe(true);
  const token = hub.resumeToken(id);
  hub.ready(id, { loggedIn: false, mid: null, uname: null }, true);
  expect(hub.shouldRenewLease()).toBe(true);
  hub.disconnect(id);
  expect(hub.shouldRenewLease()).toBe(false);
  hub.reconnect(token, new TestChannel());
  expect(hub.shouldRenewLease()).toBe(true);
  hub.revoke();
  expect(hub.shouldRenewLease()).toBe(false);
});

it('probe_failure_remains_visible_without_leaving_an_authorized_connection', () => {
  const [hub, id] = paired();
  hub.approve(id);
  hub.failProbe(id, new BiliRequestError('redirect-unsupported', 'Manual redirect unavailable'));
  const status = hub.status();
  expect(status.lastError?.code).toBe('bilibili-redirect-unsupported');
  expect(status.parsing).toBe(false);
  expect(status.media).toBe(false);
  expect(status.connectionId).toBeNull();
  hub.startPairing(42);
  expect(hub.status().lastError).toBeNull();
});

class Cancellation implements BridgeCancellation {
  private cancelled = false;
  private readonly listeners: Array<() => void> = [];
  get isCancelled(): boolean { return this.cancelled; }
  whenCancelled(): Promise<'cancelled'> {
    if (this.cancelled) return Promise.resolve('cancelled');
    return new Promise(resolve => this.listeners.push(() => resolve('cancelled')));
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

function mediaRequest(id: number, maxBytes = 4): BridgeRequest {
  return {
    id,
    attemptId: 'attempt-1',
    kind: 'media',
    method: 'GET',
    url: new URL('https://a.bilivideo.com/v'),
    headers: {},
    body: new Uint8Array(0),
    maxBytes,
    deadlineMs: Date.now() + 24_000,
    cancel: new Cancellation(),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
}

it('stream_ack_sequence_limit_and_drop_cancellation', async () => {
  const [hub, id, channel] = paired();
  hub.approve(id);
  const request = mediaRequest(123);
  const execution = hub.executeOn(id, request, false);
  await until(() => channel.sent.some(text => text.includes('"type":"request"')));

  const sentRequest = JSON.parse(channel.sent[0]!) as Record<string, unknown>;
  expect(sentRequest.id).toBe(123);
  expect(hub.deliver('different-tab', 123, { type: 'end' })).toBe(false);
  expect(hub.deliver(id, 123, {
    type: 'head', status: 206,
    headers: { 'content-length': '4', 'set-cookie': 'secret' },
    finalUrl: 'https://a.bilivideo.com/v',
  })).toBe(true);
  await until(() => channel.sent.some(text => text.includes('"type":"credit"')));
  expect(hub.deliver(id, 123, { type: 'chunk', sequence: 0, bytes: Buffer.from('bili') }))
    .toBe(true);
  await until(() => channel.sent.filter(text => text.includes('"type":"credit"')).length >= 2);
  expect(hub.deliver(id, 123, { type: 'end' })).toBe(true);

  const result = await execution;
  expect(Buffer.from(result.body).toString()).toBe('bili');
  expect(result.headers['set-cookie']).toBeUndefined();
  await until(() => channel.sent.some(text => text.includes('"type":"cancel"')));
  expect(hub.pendingCount()).toBe(0);
});

it('cancelled_requests_release_slots_and_send_abort', async () => {
  const [hub, id, channel] = paired();
  hub.approve(id);
  const request = mediaRequest(124);
  const execution = hub.executeOn(id, request, false);
  await until(() => channel.sent.some(text => text.includes('"type":"request"')));
  expect(hub.mediaSlots.available()).toBe(1);
  (request.cancel as Cancellation).cancel();

  let failure: unknown;
  try { await execution; }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(BiliRequestError);
  expect((failure as BiliRequestError).payload.code).toBe('bilibili-cancelled');
  expect(hub.pendingCount()).toBe(0);
  expect(hub.mediaSlots.available()).toBe(2);
  await until(() => channel.sent.some(text => text.includes('"type":"cancel"')));
});

it('parse_control only accepts the three browser control frame shapes', () => {
  expect(parseBridgeControl({ type: 'response_end', id: 7 }))
    .toEqual({ id: 7, reply: { type: 'end' } satisfies BridgeReply });
  expect(parseBridgeControl({
    type: 'response_head', id: 8, status: 200, headers: { etag: 'x' },
    finalUrl: 'https://a.bilivideo.com/v',
  })).toEqual({
    id: 8,
    reply: {
      type: 'head', status: 200, headers: { etag: 'x' },
      finalUrl: 'https://a.bilivideo.com/v',
    },
  });
  expect(parseBridgeControl({ type: 'error', id: 9, code: 'timeout' }))
    .toEqual({ id: 9, reply: { type: 'error', code: 'timeout' } });
  expect(parseBridgeControl({ type: 'response_head', id: 1, status: '200', headers: {}, finalUrl: '' }))
    .toBeNull();
  expect(parseBridgeControl({ type: 'unknown', id: 1 })).toBeNull();
});
