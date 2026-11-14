import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { JsonValue } from '../api.ts';
import plugin from '../index.ts';
import { AnthropicAdapter } from '../src/providers/anthropic.ts';

class MemorySettings implements SettingsStore {
  values = new Map<string, string>();
  save(key: string, value: string) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key) ?? null; }
  delete(key: string) { return this.values.delete(key); }
  listByPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string) { let n = 0; for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) { this.values.delete(key); n++; } return n; }
  async saveSecret(key: string, value: string) { this.save(key, value); }
  async getSecret(key: string) { return this.get(key); }
  async deleteSecret(key: string) { return this.delete(key); }
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const servers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of servers.splice(0)) await close(); });

async function imageServer() {
  const http = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  servers.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}/cat.png`;
}

async function createHost() {
  return createTestHost({
    plugins: [plugin],
    provide: { settings: new MemorySettings() },
    app: { version: '0.11.0' },
  });
}

const imageBody = (url: string): JsonValue => ({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url } },
    ],
  }],
});

describe('remote image production path', () => {
  it('downloads http(s) image parts through the llmAdapters service', async () => {
    const host = await createHost();
    try {
      const url = await imageServer();
      const prepared = await host.ctx.llmAdapters.prepareRemoteImages!(imageBody(url));
      const content = (prepared as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> })
        .messages[0]!.content[1]!;
      expect(content.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(Buffer.from(content.image_url!.url.split(',')[1]!, 'base64')).toEqual(png);
    } finally { await host.dispose(); }
  });

  it('keeps the downloaded bytes available to the synchronous adapter path', async () => {
    const host = await createHost();
    try {
      const url = await imageServer();
      await host.ctx.llmAdapters.prepareRemoteImages!(imageBody(url));

      // buildRequest still receives the original URL; the production-registered
      // cache reader inlines it exactly like Rust's fetch_binary_with_cache hit.
      const request = new AnthropicAdapter().buildRequest(
        'https://api.anthropic.com', 'key', 'claude-sonnet', imageBody(url),
      );
      const body = request.body as { messages: Array<{ content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }> };
      const image = body.messages[0]!.content.find(block => block.type === 'image')!;
      expect(image.source).toEqual({
        type: 'base64',
        media_type: 'image/png',
        data: png.toString('base64'),
      });
    } finally { await host.dispose(); }
  });

  it('keeps the Rust failure path when the download fails', async () => {
    const host = await createHost();
    try {
      const prepared = await host.ctx.llmAdapters.prepareRemoteImages!(imageBody('http://127.0.0.1:1/missing.png'));
      const content = (prepared as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> })
        .messages[0]!.content[1]!;
      expect(content.image_url?.url).toBe('http://127.0.0.1:1/missing.png');

      const request = new AnthropicAdapter().buildRequest(
        'https://api.anthropic.com', 'key', 'claude-sonnet', imageBody('http://127.0.0.1:1/missing.png'),
      );
      const body = request.body as { messages: Array<{ content: Array<{ type: string }> }> };
      expect(body.messages[0]!.content.some(block => block.type === 'image')).toBe(false);
    } finally { await host.dispose(); }
  });
});
