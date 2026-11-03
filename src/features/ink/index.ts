export { registerDstuFileViewer } from './registerDstuFileViewer';
export { LazyInkEditor } from './LazyInkEditorEntry';
export { INK_MIME, INK_EXTENSION, INK_SCHEMA_VERSION } from './types';
export type { InkManifest, InkPage, InkPageRef } from './types';

export async function registerInkRenderBridge() {
  const { registerInkRenderBridge: register } = await import('./renderBridge');
  return register();
}

export async function registerInkJobBridge() {
  const { registerInkJobBridge: register } = await import('./jobBridge');
  return register();
}

export async function prepareSourceInk(...args: Parameters<typeof import('./actions').prepareSourceInk>) {
  const { prepareSourceInk: action } = await import('./actions');
  return action(...args);
}

export async function createInk(...args: Parameters<typeof import('./api').createInk>) {
  const { createInk } = await import('./api');
  return createInk(...args);
}

export async function renderInkSnapshot(...args: Parameters<typeof import('./api').renderInkSnapshot>) {
  const { renderInkSnapshot } = await import('./api');
  return renderInkSnapshot(...args);
}
