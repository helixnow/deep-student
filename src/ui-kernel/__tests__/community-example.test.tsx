// @vitest-environment node
// 内核测试宿主需要 Node 的 file: URL（jsdom 环境下 import.meta.url 不是 file:），渲染所需的 DOM 在用例内手动建立。
/**
 * 社区插件示例（examples/plugins/community-word-of-day）的端到端测试：
 * Host 半跑在真实内核测试宿主上，UI 半跑在真实 UI 内核上，二者经 plugin:host|call 通道连接。
 * 验证 FRONTEND.md 的完整链路：清单 → UI 半安装 → 贡献物 → 远程调用放行/拒绝 → 卸载撤销。
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile } from '../../../host/kernel/profile';
import { createTestHost } from '../../../host/kernel/testing';
import hostHalf from '../../../examples/plugins/community-word-of-day/index';
import uiHalf from '../../../examples/plugins/community-word-of-day/ui';
import { wordForDate } from '../../../examples/plugins/community-word-of-day/words';
import { defineUiPlugin, UiKernel, type RemoteHost } from '../kernel';
import { useSlotEntry, UiKernelProvider } from '../react';

const ID = uiHalf.meta.id;
/** Slot entries take `<plugin id>/<localId>` (host/kernel/plugin-id.ts pluginSlotId); commands `<plugin id>.<action>`. */
const VIEW_ID = `${ID}/today`;
const OPEN_COMMAND_ID = `${ID}.open`;
/** The one service the Host half opens to its UI half (its name derives from the plugin id). */
const SERVICE = Object.keys(hostHalf.meta.remote ?? {})[0]!;
const APP_VERSION = (JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

async function setup() {
  // 与生产相同：经 profile 按模块路径加载 Host 半（清单需要模块文件位置），engines 按应用版本（package.json）检查。
  const host = await createTestHost({ app: { version: APP_VERSION } });
  await loadProfile(host.runtime, path.resolve('examples/plugins/community-word-of-day/test.profile.json'));
  const commands = new Map<string, unknown>();
  const kernel = new UiKernel({
    invoke: (cmd, args) => host.invoke(cmd, args),
    commands: { register: (c) => (commands.set(c.id, c), () => commands.delete(c.id)) },
    i18n: { addBundle: () => () => undefined },
  });
  dispose = async () => {
    await kernel.dispose();
    await host.dispose();
  };
  return { host, kernel, commands };
}

describe('community plugin example: word of day', () => {
  it('appears in the host UI manifest with an absolute module path', async () => {
    const { host } = await setup();
    const manifest = (await host.invoke('plugin:ui|manifest', {})) as { id: string; file: string; version?: string }[];
    const entry = manifest.find((e) => e.id === ID);
    expect(entry).toBeDefined();
    expect(path.isAbsolute(entry!.file)).toBe(true);
    expect(entry!.file.endsWith(path.join('community-word-of-day', 'dist', 'ui.js'))).toBe(true);
    expect(entry!.version).toBe('1.0.0');
  });

  it('installs the UI half, renders the view with data from the host half, and revokes everything on unload', async () => {
    const { kernel, commands } = await setup();
    await kernel.install(uiHalf);
    expect(kernel.slots.list('nav').map((e) => [e.id, e.owner])).toEqual([[VIEW_ID, ID]]);
    expect(commands.has(OPEN_COMMAND_ID)).toBe(true);

    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
    const { render, within } = await import('@testing-library/react');
    function Host() {
      const view = useSlotEntry<{ component: () => JSX.Element }>('views', VIEW_ID);
      const View = view?.value.component;
      return View ? <View /> : null;
    }
    const { container } = render(
      <UiKernelProvider kernel={kernel}>
        <Host />
      </UiKernelProvider>,
    );
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(await within(container).findByRole('heading', { name: wordForDate(date).word })).toBeTruthy();

    await kernel.unload(ID);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.slots.get('views', VIEW_ID)).toBeUndefined();
    expect(commands.size).toBe(0);
  });

  it('only exposes methods declared in meta.remote to the UI half (calls carry it as caller)', async () => {
    const { kernel } = await setup();
    let host: RemoteHost | undefined;
    await kernel.install(defineUiPlugin({ ...uiHalf, apply: (ctx, config) => ((host = ctx.ui.host), uiHalf.apply(ctx, config)) }));
    expect(hostHalf.meta.remote).toEqual({ [SERVICE]: ['today', 'history'] });
    await expect(host![SERVICE]!.history!(['2026-11-03'])).resolves.toEqual([wordForDate('2026-11-03')]);
    await expect(host![SERVICE]!.secret!()).rejects.toMatchObject({
      error_type: 'Validation',
    });
  });
});
