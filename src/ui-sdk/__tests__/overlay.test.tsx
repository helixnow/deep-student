/**
 * createPluginOverlay：插件自己的浮层（选区旁的小卡片等没有槽位承载的临时界面）。
 * 内容带插件作用域；浮层不占位置；渲染出错计入插件错误预算；插件卸载时浮层随之移除。
 */
import { act } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UiKernel } from '../../ui-kernel/kernel';
import { memoryStorageBackend } from '../../ui-kernel/services/storage';
import { createPluginOverlay, definePlugin, useT, type PluginOverlay } from '../index';

const overlayHost = () => document.querySelector<HTMLDivElement>('[data-plugin-overlay="acme.mnemonic"]');

function Card({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return <div role="dialog"><p>{t('title')}：{text}</p><button onClick={() => setCopied(true)}>{copied ? 'copied' : 'copy'}</button></div>;
}
function Broken(): never { throw new Error('overlay render failed'); }

async function setup() {
  let overlay: PluginOverlay | undefined;
  const kernel = new UiKernel({ navigate: vi.fn(), storage: memoryStorageBackend(), i18n: { addBundle: () => () => {}, languages: () => ['zh-CN'] } });
  const plugin = definePlugin({
    meta: { id: 'acme.mnemonic', version: '1.0.0' },
    apply(ctx) {
      ctx.ui.i18n.addBundles({ 'zh-CN': { title: '编成口诀' } });
      overlay = createPluginOverlay(ctx);
    },
  });
  await kernel.install(plugin);
  return { kernel, overlay: overlay! };
}

describe('createPluginOverlay', () => {
  it('mounts lazily into a zero-sized layer, keeps state across updates, clears on null and leaves with the plugin', async () => {
    const { kernel, overlay } = await setup();
    expect(overlayHost()).toBeNull();

    act(() => overlay.render(<Card text="特征向量" />));
    const host = overlayHost()!;
    expect(host.parentElement).toBe(document.body);
    expect(host.style.width).toBe('0px');
    expect(host.style.height).toBe('0px');
    expect(host.textContent).toContain('编成口诀：特征向量'); // plugin scope: useT resolves the plugin's namespace

    act(() => host.querySelector('button')!.click());
    act(() => overlay.render(<Card text="相似对角化" />));
    expect(host.textContent).toContain('编成口诀：相似对角化');
    expect(host.querySelector('button')!.textContent).toBe('copied'); // same component instance: state survived the update

    act(() => overlay.render(null));
    expect(host.textContent).toBe('');

    act(() => overlay.render(<Card text="再来" />));
    await act(() => kernel.unload('acme.mnemonic'));
    expect(overlayHost()).toBeNull();
    act(() => overlay.render(<Card text="卸载之后" />));
    expect(overlayHost()).toBeNull();
    await kernel.dispose();
  });

  it('contains a render error: the layer is cleared, the app keeps running and the next render works', async () => {
    const { kernel, overlay } = await setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => overlay.render(<Broken />));
    expect(overlayHost()!.textContent).toBe('');
    act(() => overlay.render(<Card text="恢复" />));
    expect(overlayHost()!.textContent).toContain('恢复');
    consoleError.mockRestore();
    await kernel.dispose();
    expect(overlayHost()).toBeNull();
  });

  it('must be created inside a plugin', () => {
    const kernel = new UiKernel({ navigate: vi.fn(), storage: memoryStorageBackend(), i18n: { addBundle: () => () => {}, languages: () => ['zh-CN'] } });
    expect(() => createPluginOverlay(kernel.root)).toThrow('createPluginOverlay: call it inside a UI plugin apply()');
  });
});
