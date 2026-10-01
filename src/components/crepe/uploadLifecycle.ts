import type { EditorView } from '@milkdown/prose/view';
import { Decoration, type DecorationSet } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { Plugin } from '@milkdown/prose/state';
import type { UploadOptions } from '@milkdown/kit/plugin/upload';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import i18next from '@/i18n';

export interface UploadSource {
  name: string;
  read: (signal: AbortSignal) => Promise<File | null>;
}

export type UploadTarget = { pos: number; node?: ProseNode };
interface UploadTask {
  id: symbol;
  target: UploadTarget;
  sources: UploadSource[];
  urls: Array<string | undefined>;
  abort: AbortController;
  running: boolean;
  row: HTMLElement;
  status: HTMLElement;
  retry: HTMLButtonElement;
}

const imageSelector = '.milkdown-image-block, .milkdown-image-inline';
export const isImageName = (name: string) => /\.(jpe?g|png|gif|bmp|webp|svg|heic|heif|avif)$/i.test(name);
export const isImageFile = (file: File) => file.type.startsWith('image/') || isImageName(file.name);

/** Tauri 2 DragDropEvent.position is webview-relative PhysicalPosition.
 * Read DPR synchronously at drop time (also reflects webview zoom / monitor changes).
 * Never await scaleFactor() and then hit-test an already changed document.
 */
export function nativeDropPoint(position: { x: number; y: number }, pixelRatio: number) {
  return { left: position.x / pixelRatio, top: position.y / pixelRatio };
}

export function imageTarget(view: EditorView, container: HTMLElement, element: Element): UploadTarget | null {
  if (!container.contains(element) || !view.dom.contains(element)) return null;
  const image = element.closest(imageSelector);
  if (!image) return null;
  let target: UploadTarget | null = null;
  view.state.doc.descendants((node, pos) => {
    if (target) return false;
    if (!['image', 'image-block'].includes(node.type.name)) return true;
    const dom = view.nodeDOM(pos);
    if (dom && (dom === image || dom.contains(image) || image.contains(dom))) {
      target = { pos, node };
    }
    return false;
  });
  return target;
}

export function dropTarget(view: EditorView, container: HTMLElement, point: { left: number; top: number }): UploadTarget | null {
  const element = container.ownerDocument.elementFromPoint(point.left, point.top);
  // A global '.milkdown' match would route the same native event into every editor.
  if (!element || !container.contains(element) || !view.dom.contains(element)) return null;
  const image = imageTarget(view, container, element);
  if (image && !image.node?.attrs.src) return image;
  const hit = view.posAtCoords(point);
  return hit ? { pos: hit.pos } : null;
}

/** Uses the ONE upload plugin already installed by Crepe 7.21.3.
 * Its public $prose.key() accessor is module-global and can point at another
 * editor's plugin. Resolve the registered instance from this view instead.
 */
function registeredUploadPlugin(view: EditorView): Plugin<DecorationSet> {
  const plugin = view.state.plugins.find((candidate) =>
    (candidate as Plugin & { key: string }).key.startsWith('MILKDOWN_UPLOAD$'));
  if (!plugin) throw new Error('Crepe upload plugin is not registered');
  return plugin;
}

export function createUploadLifecycle(options: {
  getView: () => EditorView | null;
  isCurrent: () => boolean;
  container: HTMLElement;
  validate: (file: File) => Promise<void>;
  upload: (file: File) => Promise<string>;
}) {
  const tasks = new Map<symbol, UploadTask>();
  const reviewLeases = new Set<symbol>();
  let restoreReviewInteraction: (() => void) | undefined;
  let disposed = false;
  const panel = document.createElement('div');
  panel.className = 'sticky bottom-0 z-10 rounded border bg-background p-2 text-sm shadow';
  panel.setAttribute('aria-label', i18next.t('notes:upload.tasks', { defaultValue: '图片上传' }));
  panel.hidden = true;

  const currentView = () => {
    if (disposed || !options.isCurrent()) return null;
    const view = options.getView();
    return view && !view.isDestroyed ? view : null;
  };
  const find = (view: EditorView, id: symbol) =>
    registeredUploadPlugin(view).getState(view.state)?.find(undefined, undefined, spec => spec.id === id)[0];
  const finish = (task: UploadTask) => {
    task.abort.abort();
    tasks.delete(task.id);
    task.row.remove();
    panel.hidden = tasks.size === 0;
  };
  const cancel = (id: symbol) => {
    const task = tasks.get(id);
    if (!task) return;
    finish(task);
    const view = currentView();
    if (view && find(view, id)) {
      view.dispatch(view.state.tr.setMeta(registeredUploadPlugin(view), { remove: { id } }));
    }
  };
  const live = (task: UploadTask) => {
    const view = currentView();
    if (!view || !view.editable || !tasks.has(task.id) || !find(view, task.id)) {
      cancel(task.id);
      return null;
    }
    return view;
  };
  const run = async (task: UploadTask) => {
    if (task.running || !live(task)) return;
    task.running = true;
    task.retry.hidden = true;
    let failed = false;
    // Preserve input order, retain successful URLs on retry, and bound file memory.
    for (let index = 0; index < task.sources.length; index++) {
      if (task.urls[index]) continue;
      if (!live(task)) return;
      const source = task.sources[index];
      task.status.textContent = i18next.t('notes:upload.in_progress', {
        defaultValue: '正在上传 {{name}}（{{index}}/{{total}}）',
        name: source.name, index: index + 1, total: task.sources.length,
      });
      try {
        const file = await source.read(task.abort.signal);
        if (!live(task)) return;
        if (!file) { cancel(task.id); return; } // picker cancelled
        source.name = file.name;
        await options.validate(file);
        if (!live(task)) return;
        const url = await options.upload(file);
        if (!live(task)) return;
        if (!url.trim()) throw new Error(i18next.t('notes:upload.no_url', { defaultValue: '图片未能保存' }));
        task.urls[index] = url;
      } catch (error) {
        if (!live(task)) return;
        failed = true;
        task.status.textContent = i18next.t('notes:upload.failed_retry', {
          defaultValue: '{{name}} 上传失败：{{error}}。可重试或取消。',
          name: source.name, error: error instanceof Error ? error.message : String(error),
        });
        // Stop at the failed file; retry resumes here, keeping the batch ordered.
        break;
      }
    }
    task.running = false;
    if (failed) { task.retry.hidden = false; return; }
    const view = live(task);
    if (!view) return;
    const anchor = find(view, task.id)!;
    try {
      const node = task.target.node;
      const type = node?.type ?? view.state.schema.nodes['image-block'];
      if (!type) throw new Error(i18next.t('notes:upload.image_unavailable'));
      const nodes = task.urls.map((src, index) => type.create({
        ...node?.attrs, src, alt: task.sources[index].name,
      }));
      // A node decoration disappears when its target is deleted/replaced. For
      // insertion, plugin-upload maps the widget across every intervening edit.
      const tr = view.state.tr.replaceWith(anchor.from, node ? anchor.to : anchor.from, nodes)
        .setMeta(registeredUploadPlugin(view), { remove: { id: task.id } });
      view.dispatch(tr);
      finish(task);
    } catch (error) {
      task.status.textContent = String(error);
      task.retry.hidden = false;
    }
  };

  const widgetFactory: UploadOptions['uploadWidgetFactory'] = (pos, spec) => {
    const task = tasks.get(spec?.id);
    if (task?.target.node) {
      return Decoration.node(pos, pos + task.target.node.nodeSize, { 'aria-busy': 'true' }, spec);
    }
    const label = document.createElement('span');
    label.textContent = i18next.t('notes:upload.placeholder', { defaultValue: '图片上传中…' });
    label.contentEditable = 'false';
    return Decoration.widget(pos, label, { ...spec, side: 1 });
  };

  return {
    widgetFactory,
    getState() {
      const running = [...tasks.values()].filter(task => task.running).length;
      return { pending: tasks.size, running, failed: tasks.size - running, reviewLeases: reviewLeases.size };
    },
    /** Review is in a separate Crepe. Existing uploads must complete into the live
     * document; their revision change makes a pending review fail OCC normally.
     * Inert blocks user interaction without changing view.editable (pending
     * uploads depend on it) or the user's readonly setting. Host writes remain
     * version-checked through FullDocumentApi. Never call setReadonly here:
     * CrepeEditor.setReadonly intentionally cancels in-flight uploads.
     */
    acquireReviewLease() {
      const token = Symbol('review');
      if (!reviewLeases.size) {
        const dom = currentView()?.dom;
        if (dom) {
          const wasInert = dom.inert;
          dom.inert = true;
          restoreReviewInteraction = () => { dom.inert = wasInert; };
        }
      }
      reviewLeases.add(token);
      return () => {
        reviewLeases.delete(token);
        if (!reviewLeases.size) { restoreReviewInteraction?.(); restoreReviewInteraction = undefined; }
      };
    },
    start(sources: UploadSource[], target: UploadTarget): symbol | null {
      const view = currentView();
      if (!view?.editable || !sources.length || reviewLeases.size) return null;
      // Only one upload may own an empty image node at a time.
      if (target.node && [...tasks.values()].some(task => task.target.node && find(view, task.id)?.from === target.pos)) return null;
      const id = Symbol('crepe-image-upload');
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      const retry = document.createElement('button');
      retry.className = 'shrink-0 rounded border px-2 py-1';
      retry.type = 'button';
      retry.textContent = i18next.t('common:retry', { defaultValue: '重试' });
      retry.hidden = true;
      const cancelButton = document.createElement('button');
      cancelButton.className = 'shrink-0 rounded border px-2 py-1';
      cancelButton.type = 'button';
      cancelButton.textContent = i18next.t('common:cancel', { defaultValue: '取消' });
      const task: UploadTask = { id, target, sources, urls: [], abort: new AbortController(), running: false, row, status, retry };
      retry.onclick = () => { void run(task); };
      cancelButton.onclick = () => cancel(id);
      row.append(status, retry, cancelButton);
      panel.append(row);
      if (!panel.isConnected) options.container.append(panel);
      panel.hidden = false;
      tasks.set(id, task);
      // This dispatch must precede file/dialog/validation/backend awaits.
      view.dispatch(view.state.tr.setMeta(registeredUploadPlugin(view), { add: { id, pos: target.pos } }));
      void run(task);
      return id;
    },
    cancel,
    cancelAll() { [...tasks.keys()].forEach(cancel); },
    pruneDeleted() {
      const view = currentView();
      for (const task of tasks.values()) {
        if (!view || !find(view, task.id)) finish(task);
      }
    },
    dispose() {
      restoreReviewInteraction?.(); restoreReviewInteraction = undefined;
      reviewLeases.clear();
      [...tasks.keys()].forEach(cancel);
      disposed = true;
      panel.remove();
    },
  };
}

export type UploadLifecycle = ReturnType<typeof createUploadLifecycle>;

/** Called synchronously by webview.onDragDropEvent; IO lives in lazy sources. */
export function handleNativeImageDrop(options: {
  payload: DragDropEvent;
  pixelRatio: number;
  view: EditorView;
  container: HTMLElement;
  lifecycle: UploadLifecycle;
  read: (path: string, signal: AbortSignal) => Promise<File>;
}) {
  const { payload, view, container, lifecycle } = options;
  if (payload.type !== 'drop' || view.isDestroyed || !view.editable) return;
  const paths = payload.paths.filter(isImageName);
  if (!paths.length) return;
  const target = dropTarget(view, container, nativeDropPoint(payload.position, options.pixelRatio));
  if (!target) return;
  lifecycle.start(paths.map(path => ({
    name: path.split(/[/\\]/).pop() || 'image',
    read: signal => options.read(path, signal),
  })), target);
}

/** A browser picker is async too: its mapped node anchor must exist before click(). */
function pickBrowserImage(signal: AbortSignal): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    const finish = (file: File | null) => {
      signal.removeEventListener('abort', abort);
      input.remove();
      resolve(file);
    };
    const abort = () => finish(null);
    input.onchange = () => finish(input.files?.[0] ?? null);
    input.addEventListener('cancel', abort, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function bindBrowserImageUploads(options: {
  container: HTMLElement;
  view: EditorView;
  lifecycle: UploadLifecycle;
  native: boolean;
  pickNative: () => Promise<File | null>;
}) {
  const { container, view, lifecycle } = options;
  const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const sources = (files: File[]) => files.map(file => ({ name: file.name, read: async () => file }));
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    // Only the actual uploader label/input; the adjacent hint focuses URL input.
    const control = event.target.closest('label.uploader, input[type="file"]');
    if (!control || !container.contains(control)) return;
    const target = imageTarget(view, container, control);
    if (!target || target.node?.attrs.src) return;
    consume(event);
    lifecycle.start([{
      name: i18next.t('notes:upload.choose', { defaultValue: '选择图片' }),
      read: options.native ? options.pickNative : pickBrowserImage,
    }], target);
  };
  const change = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const target = imageTarget(view, container, input);
    if (!target) return;
    consume(event); // prevent ImageInput's unguarded asynchronous setLink
    const files = Array.from(input.files ?? []).filter(isImageFile);
    input.value = '';
    lifecycle.start(sources(files), target);
  };
  const drop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
    // Tauri owns external file drops; browser text/internal block drags continue.
    if (options.native && (files.length || Array.from(event.dataTransfer?.types ?? []).includes('Files'))) {
      consume(event);
      return;
    }
    if (!files.length) return;
    const target = dropTarget(view, container, { left: event.clientX, top: event.clientY });
    consume(event);
    if (target) lifecycle.start(sources(files), target);
  };
  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
    if (!files.length || !(event.target instanceof Element) || !view.dom.contains(event.target)) return;
    consume(event);
    lifecycle.start(sources(files), { pos: view.state.selection.from });
  };
  container.addEventListener('click', click, true);
  container.addEventListener('change', change, true);
  container.addEventListener('drop', drop, true);
  container.addEventListener('paste', paste, true);
  return () => {
    container.removeEventListener('click', click, true);
    container.removeEventListener('change', change, true);
    container.removeEventListener('drop', drop, true);
    container.removeEventListener('paste', paste, true);
  };
}
