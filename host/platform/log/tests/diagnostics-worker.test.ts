import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

// F4-V2-04: Rust diagnostics.rs runs redaction + ZIP inside spawn_blocking; the Host event loop must stay responsive.
it('F4-V2-04 export_diagnostics_bundle redacts and compresses off the event loop', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const line = `${JSON.stringify({ level: 'info', content: '用户内容'.repeat(20), token: 'private-secret-value', url: 'https://example.com/a?q=1' })}\n`;
    await writeFile(join(host.ctx.log.logDir, 'big.log'), line.repeat(Math.floor(18 * 1024 * 1024 / Buffer.byteLength(line))));
    const destination = join(host.app.dataDir, 'out', 'bundle.zip');

    let maxGap = 0, ticks = 0, last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 10);
    const started = performance.now();
    let result;
    try { result = await host.invoke('export_diagnostics_bundle', { options: { destination, includeDebugLogs: false } }); }
    finally { clearInterval(timer); }
    const elapsed = performance.now() - started;

    expect(result).toMatchObject({ path: destination, skippedCount: 0 });
    // Same redaction as before the worker move.
    const zip = await JSZip.loadAsync(await readFile(destination));
    const text = await zip.file('current/big.log')!.async('string');
    expect(text).not.toContain('private-secret-value');
    expect(text).not.toContain('用户内容');
    expect(text).toContain('https://example.com/a"');
    expect(JSON.parse(await zip.file('manifest.json')!.async('string'))).toMatchObject({ file_count: (result as { fileCount: number }).fileCount, include_debug_logs: false });
    // 18 MiB of JSON lines takes well over a second to sanitize; the timer must keep firing meanwhile.
    expect(ticks).toBeGreaterThan(elapsed / 50);
    expect(maxGap).toBeLessThan(Math.max(500, elapsed / 3));
  } finally { await host.dispose(); }
}, 120_000);
