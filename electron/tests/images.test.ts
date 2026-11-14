/**
 * `plugin:image` 与 `resolveImage`：本构建的 Tauri 没开 `image-ico` / `image-png`，按路径或编码字节建图一律报 Tauri 的原文，
 * 不读文件、不解码，因而也不能借报错探测路径是否存在。RGBA 与资源 id 照常可用。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ShellCommandError } from '../shell/errors.ts';
import { ImageResource, imagePlugin, resolveImage } from '../shell/images.ts';
import { PathResolver } from '../shell/paths.ts';
import { ShellRuntime, type CommandContext } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

const tmp = mkdtempSync(join(tmpdir(), 'dstu-images-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function shell(): { runtime: ShellRuntime; ctx: CommandContext } {
  const runtime = new ShellRuntime({
    platform: 'linux',
    debug: false,
    config: {
      productName: 'image test', version: '0.0.0', identifier: 'test', devUrl: '', frontendDist: '', windows: [],
      assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
    },
    paths: new PathResolver({ platform: 'linux', env: {}, fallbackHome: '/tmp', identifier: 'test', tempDir: '/tmp', resourceDir: null }),
    assetScope: new FsScope({ platform: 'linux' }),
    fsScope: new FsScope({ platform: 'linux' }),
    appVersion: '0.0.0',
    localOrigin: 'tauri://localhost',
    log: () => undefined,
  });
  runtime.registerPlugin('image', imagePlugin());
  return { runtime, ctx: { runtime, windowLabel: 'main', webviewLabel: 'main' } };
}

function invoke({ runtime, ctx }: ReturnType<typeof shell>, command: string, json: Record<string, unknown>): Promise<unknown> {
  const result = runtime.runBuiltin(`plugin:image|${command}`, { json, raw: null, headers: {} }, ctx);
  if (result === undefined) throw new Error(`plugin:image|${command} is not registered`);
  return Promise.resolve(result);
}

const RED = { rgba: [255, 0, 0, 255], width: 1, height: 1 };
const PNG_BYTES = new ImageResource(Uint8Array.from(RED.rgba), 1, 1).png();
const PNG_FILE = join(tmp, 'red.png');
writeFileSync(PNG_FILE, PNG_BYTES);

describe('plugin:image without the image-ico / image-png features', () => {
  it('from_path and from_bytes always fail with the Tauri text, whatever the arguments', async () => {
    const s = shell();
    const fromPath = 'from_path is only supported if the `image-ico` or `image-png` Cargo features are enabled';
    const fromBytes = 'from_bytes is only supported if the `image-ico` or `image-png` Cargo features are enabled';
    for (const path of [PNG_FILE, join(tmp, 'missing.png'), '/etc/passwd']) {
      await expect(invoke(s, 'from_path', { path })).rejects.toHaveProperty('message', fromPath);
    }
    await expect(invoke(s, 'from_path', {})).rejects.toHaveProperty('message', fromPath);
    await expect(invoke(s, 'from_bytes', { bytes: Array.from(PNG_BYTES) })).rejects.toHaveProperty('message', fromBytes);
    await expect(invoke(s, 'from_bytes', {})).rejects.toHaveProperty('message', fromBytes);
  });

  it('new / rgba / size still work on straight RGBA', async () => {
    const s = shell();
    const rid = await invoke(s, 'new', RED);
    expect(typeof rid).toBe('number');
    expect(await invoke(s, 'rgba', { rid })).toEqual(RED.rgba);
    expect(await invoke(s, 'size', { rid })).toEqual({ width: 1, height: 1 });
  });
});

describe('resolveImage (JsImage arguments of set_icon, write_image, …)', () => {
  it('accepts a resource id and RGBA data; refuses a path or encoded bytes with the Tauri text, without reading or decoding them', async () => {
    const s = shell();
    const rid = await invoke(s, 'new', RED) as number;
    expect(resolveImage(rid, s.ctx).rgba).toEqual(Uint8Array.from(RED.rgba));
    expect(resolveImage(RED, s.ctx)).toMatchObject({ width: 1, height: 1, rgba: Uint8Array.from(RED.rgba) });
    for (const path of [PNG_FILE, join(tmp, 'missing.png')]) {
      expect(() => resolveImage(path, s.ctx)).toThrow(new ShellCommandError('expected RGBA image data, found a file path'));
    }
    expect(() => resolveImage(Array.from(PNG_BYTES), s.ctx)).toThrow(new ShellCommandError('expected RGBA image data, found raw bytes'));
    for (const bad of [null, true, {}, [256], [-1], ['a'], [1.5]]) {
      expect(() => resolveImage(bad, s.ctx)).toThrow(new ShellCommandError('data did not match any variant of untagged enum JsImage'));
    }
  });
});
