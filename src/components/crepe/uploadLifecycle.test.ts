import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import type { EditorView } from '@milkdown/prose/view';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { normalizeMarkdown } from './normalizeMarkdown';
import {
  bindBrowserImageUploads, createUploadLifecycle, dropTarget, handleNativeImageDrop, imageTarget, nativeDropPoint,
  type UploadLifecycle,
} from './uploadLifecycle';

const file = (name: string) => new File(['image'], name, { type: 'image/png' });
const source = (name: string) => ({ name, read: vi.fn(async () => file(name)) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const fixtures: Array<{ crepe: Crepe; root: HTMLElement; lifecycle: UploadLifecycle; cleanup?: () => void }> = [];
beforeAll(async () => { await i18next.init({ lng: 'zh-CN', resources: {} }); });
async function setup(upload = vi.fn(async (f: File) => `notes_assets/${f.name}`), validate = vi.fn(async (_: File) => {})) {
  const root = document.createElement('div');
  document.body.append(root);
  let current = true;
  let view: EditorView | null = null;
  const lifecycle = createUploadLifecycle({ container: root, getView: () => view, isCurrent: () => current, upload, validate });
  const crepe = new Crepe({
    root, defaultValue: 'abc\n\ndef',
    features: {
      [CrepeFeature.CodeMirror]: false, [CrepeFeature.Latex]: false,
      [CrepeFeature.Table]: false, [CrepeFeature.Toolbar]: false,
      [CrepeFeature.BlockEdit]: false, [CrepeFeature.LinkTooltip]: false,
    },
  });
  crepe.editor.config(ctx => ctx.update(uploadConfig.key, value => ({ ...value, uploadWidgetFactory: lifecycle.widgetFactory })));
  await crepe.create();
  view = crepe.editor.ctx.get(editorViewCtx);
  const originalUpdate = view.updateState.bind(view);
  view.updateState = state => { originalUpdate(state); lifecycle.pruneDeleted(); };
  const fixture = { root, crepe, lifecycle } as typeof fixtures[number];
  fixtures.push(fixture);
  return {
    ...fixture, view, upload, validate,
    stale: () => { current = false; },
    bind: (native = false, pickNative = vi.fn(async () => file('picked.png'))) => {
      fixture.cleanup = bindBrowserImageUploads({ container: root, view: view!, lifecycle, native, pickNative });
      return pickNative;
    },
  };
}
function images(view: EditorView) {
  const result: string[] = [];
  view.state.doc.descendants(node => { if (node.type.name === 'image-block' || node.type.name === 'image') result.push(node.attrs.src); });
  return result;
}
function emptyImage(view: EditorView) {
  const node = view.state.schema.nodes['image-block'].create({ src: '' });
  view.dispatch(view.state.tr.insert(5, node));
  return { pos: 5, node };
}
function eventWithFiles(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files, types: ['Files'] } });
  Object.defineProperties(event, { clientX: { value: 40 }, clientY: { value: 30 } });
  return event;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup?.();
    fixture.lifecycle.dispose();
    await fixture.crepe.destroy();
    fixture.root.remove();
  }
  vi.restoreAllMocks();
});

describe('Crepe registered upload lifecycle', () => {
  it('normalization preflight leaves pending upload anchors, live state and view ownership intact', async () => {
    const pending = deferred<string>();
    const { view, root, crepe, lifecycle, upload } = await setup(vi.fn(() => pending.promise));
    lifecycle.start([source('pending.png')], { pos: 7 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const state = view.state;
    const dispatch = vi.spyOn(view, 'dispatch');
    expect(crepe.editor.action(ctx => normalizeMarkdown(ctx, '* item\n'))).toContain('item');
    expect(() => crepe.editor.action(ctx => normalizeMarkdown(ctx, '```js metadata\nx\n```'))).toThrow();
    expect(view.state).toBe(state);
    expect(crepe.editor.ctx.get(editorViewCtx)).toBe(view);
    expect(dispatch).not.toHaveBeenCalled();
    expect(root.textContent).toContain('图片上传中');
    pending.resolve('notes_assets/pending.png');
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/pending.png']));
  });

  it('uses one registered plugin, creates an anchor before IO and maps a batch through edits', async () => {
    const pending = deferred<string>();
    const upload = vi.fn(async (f: File) => f.name === 'one.png' ? pending.promise : `notes_assets/${f.name}`);
    const { view, root, lifecycle } = await setup(upload);
    expect(view.state.plugins.filter(p => (p as unknown as { key: string }).key.startsWith('MILKDOWN_UPLOAD$'))).toHaveLength(1);
    const one = source('one.png');
    one.read.mockImplementation(async () => {
      expect(root.textContent).toContain('图片上传中');
      return file('one.png');
    });
    lifecycle.start([one, source('two.png'), source('three.png')], { pos: 7 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    view.dispatch(view.state.tr.insertText('before-', 1));
    root.scrollTop = 700;
    pending.resolve('notes_assets/one.png');
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/one.png', 'notes_assets/two.png', 'notes_assets/three.png']));
    expect(view.state.doc.textContent).toBe('before-abcdef');
    // The drop was inside the second paragraph, so the first paragraph remains intact.
    expect(view.state.doc.firstChild?.textContent).toBe('before-abc');
  });

  it('keeps the batch pending on failure and retries only the failed file', async () => {
    const upload = vi.fn(async (f: File) => `notes_assets/${f.name}`);
    upload.mockResolvedValueOnce('notes_assets/one.png').mockResolvedValueOnce('');
    const { view, root, lifecycle } = await setup(upload);
    lifecycle.start([source('one.png'), source('two.png')], { pos: 5 });
    await vi.waitFor(() => expect(root.textContent).toContain('上传失败'));
    expect(images(view)).toEqual([]);
    const retry = [...root.querySelectorAll('button')].find(button => button.textContent === '重试')!;
    retry.click();
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/one.png', 'notes_assets/two.png']));
    expect(upload.mock.calls.map(([f]) => f.name)).toEqual(['one.png', 'two.png', 'two.png']);
  });

  it.each(['cancel', 'stale', 'dispose', 'destroy', 'delete'] as const)('does not insert after %s while upload is pending', async action => {
    const pending = deferred<string>();
    const upload = vi.fn(() => pending.promise);
    const { view, lifecycle, stale, crepe } = await setup(upload);
    const id = lifecycle.start([source('one.png')], { pos: 7 })!;
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    if (action === 'cancel') lifecycle.cancel(id);
    if (action === 'stale') stale();
    if (action === 'dispose') lifecycle.dispose();
    if (action === 'destroy') await crepe.destroy();
    if (action === 'delete') view.dispatch(view.state.tr.delete(5, 10));
    const doc = view.state.doc;
    pending.resolve('notes_assets/late.png');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.state.doc).toBe(doc);
    expect(images(view)).toEqual([]);
  });

  it('tracks the exact empty node, and deleting it never fills another empty image', async () => {
    const pending = deferred<File | null>();
    const { view, lifecycle, upload } = await setup();
    const target = emptyImage(view);
    view.dispatch(view.state.tr.insert(6, target.node));
    lifecycle.start([{ name: 'picker', read: () => pending.promise }], target);
    view.dispatch(view.state.tr.delete(5, 6));
    pending.resolve(file('late.png'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upload).not.toHaveBeenCalled();
    expect(images(view)).toEqual(['']);
  });

  it('maps an empty image before the native picker resolves and preserves its attributes', async () => {
    const pending = deferred<File | null>();
    const { view, root, bind } = await setup();
    const target = emptyImage(view);
    const pick = vi.fn(() => pending.promise);
    bind(true, pick);
    await vi.waitFor(() => expect(root.querySelector('label.uploader')).not.toBeNull());
    root.querySelector<HTMLElement>('label.uploader')!.click();
    expect(pick).toHaveBeenCalledTimes(1);
    view.dispatch(view.state.tr.insertText('prefix', 1));
    pending.resolve(file('chosen.png'));
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/chosen.png']));
    expect(view.state.doc.nodeAt(target.pos + 6)?.attrs.src).toBe('notes_assets/chosen.png');
  });

  it('rejects validation failures visibly and cancels without uploading', async () => {
    const validate = vi.fn(async () => { throw new Error('corrupt'); });
    const { view, root, lifecycle, upload } = await setup(undefined, validate);
    lifecycle.start([source('broken.png')], { pos: 5 });
    await vi.waitFor(() => expect(root.textContent).toContain('corrupt'));
    [...root.querySelectorAll('button')].find(button => button.textContent === '取消')!.click();
    expect(upload).not.toHaveBeenCalled();
    expect(images(view)).toEqual([]);
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('isolates two real Crepe instances and converts physical coordinates before hit testing', async () => {
    const first = await setup();
    const second = await setup();
    const hit = vi.fn(() => second.view.dom);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
    const coords = vi.spyOn(second.view, 'posAtCoords').mockReturnValue({ pos: 5, inside: -1 });
    const point = nativeDropPoint({ x: 120, y: 80 }, 2);
    expect(point).toEqual({ left: 60, top: 40 });
    expect(dropTarget(first.view, first.root, point)).toBeNull();
    const target = dropTarget(second.view, second.root, point)!;
    expect(coords).toHaveBeenCalledWith(point);
    expect(hit).toHaveBeenCalledWith(60, 40);
    second.lifecycle.start([source('second.png')], target);
    first.lifecycle.start([source('first.png')], { pos: 5 });
    await vi.waitFor(() => expect(images(second.view)).toEqual(['notes_assets/second.png']));
    expect(images(first.view)).toEqual(['notes_assets/first.png']);
  });

  it('routes browser drop and paste into the same lifecycle without duplicate uploads', async () => {
    const { view, root, bind, upload } = await setup();
    bind();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => view.dom });
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 5, inside: -1 });
    const drop = eventWithFiles('drop', [file('a.png'), file('b.png')]);
    view.dom.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/a.png', 'notes_assets/b.png']));
    const paste = eventWithFiles('paste', [file('c.png')]);
    view.dom.dispatchEvent(paste);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(paste.defaultPrevented).toBe(true);
    expect(root.textContent).not.toContain('上传失败');
  });

  it('handles the native payload batch in order, hit-tests once and aborts a cancelled read', async () => {
    const { view, root, lifecycle, upload } = await setup();
    const readGate = deferred<File>();
    const coords = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 7, inside: -1 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => view.dom });
    const read = vi.fn((path: string, _signal: AbortSignal) => path.endsWith('first.png') ? readGate.promise : Promise.resolve(file('last.png')));
    handleNativeImageDrop({
      payload: { type: 'drop', paths: ['/tmp/first.png', '/tmp/ignore.txt', '/tmp/last.png'], position: new PhysicalPosition(80, 60) },
      pixelRatio: 2, view, container: root, lifecycle, read,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(coords).toHaveBeenCalledWith({ left: 40, top: 30 });
    expect(root.textContent).toContain('图片上传中');
    view.dispatch(view.state.tr.insertText('edited-', 1));
    coords.mockImplementation(() => { throw new Error('stale screen coordinate reused'); });
    readGate.resolve(file('first.png'));
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/first.png', 'notes_assets/last.png']));
    expect(coords).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.map(([path]) => path)).toEqual(['/tmp/first.png', '/tmp/last.png']);
    expect(upload).toHaveBeenCalledTimes(2);

    const pending = deferred<File | null>();
    let signal!: AbortSignal;
    const id = lifecycle.start([{ name: 'cancelled.png', read: s => { signal = s; return pending.promise; } }], { pos: 1 })!;
    lifecycle.cancel(id);
    expect(signal.aborted).toBe(true);
    pending.resolve(file('cancelled.png'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('anchors the browser picker before it opens and cancels cleanly if the user dismisses it', async () => {
    const { view, root, bind, upload } = await setup();
    emptyImage(view);
    bind();
    await vi.waitFor(() => expect(root.querySelector('label.uploader')).not.toBeNull());
    const open = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      expect(root.querySelector('[role="status"]')).not.toBeNull();
      this.dispatchEvent(new Event('cancel'));
    });
    root.querySelector<HTMLElement>('label.uploader')!.click();
    expect(open).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')).toBeNull());
    expect(upload).not.toHaveBeenCalled();
    expect(images(view)).toEqual(['']);
  });

  it('cancels during validation, prevents readonly uploads and suppresses duplicate DOM drops in Tauri', async () => {
    const validation = deferred<void>();
    const validate = vi.fn(() => validation.promise);
    const { view, lifecycle, upload, bind } = await setup(undefined, validate);
    const id = lifecycle.start([source('validating.png')], { pos: 5 })!;
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    lifecycle.cancel(id);
    validation.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upload).not.toHaveBeenCalled();
    view.setProps({ editable: () => false });
    expect(lifecycle.start([source('readonly.png')], { pos: 5 })).toBeNull();
    view.setProps({ editable: () => true });
    bind(true);
    const drop = eventWithFiles('drop', [file('native.png')]);
    view.dom.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('intercepts browser file input changes before the component async setLink path', async () => {
    const { view, root, bind, upload } = await setup();
    emptyImage(view);
    bind();
    await vi.waitFor(() => expect(root.querySelector('input[type="file"]')).not.toBeNull());
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(imageTarget(view, root, input)?.pos).toBe(5);
    Object.defineProperty(input, 'files', { value: [file('browser.png')] });
    const change = new Event('change', { bubbles: true });
    const componentHandler = vi.fn();
    input.addEventListener('change', componentHandler);
    input.dispatchEvent(change);
    await vi.waitFor(() => expect(images(view)).toEqual(['notes_assets/browser.png']));
    expect(componentHandler).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
