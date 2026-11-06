export { registerDstuFileViewer } from './registerDstuFileViewer';
export { LazyInkEditor } from './LazyInkEditorEntry';
export { LazyNotebookPage } from './LazyNotebookPage';
export type { LazyNotebookPageProps } from './LazyNotebookPage';
export { InkWorkspace } from './InkWorkspace';
export type { InkWorkspaceProps } from './InkWorkspace';
export { INK_MIME, INK_EXTENSION, INK_SCHEMA_VERSION } from './types';
export type { InkManifest, InkPage, InkPageRef } from './types';

/**
 * Single capability switch for board creation UI. The native repo gate installs
 * the writer guard in the same savepoint that publishes the first board; every
 * menu must read this one constant instead of hardcoding its own flag.
 */
export const INK_BOARD_CREATE_ENABLED = true;

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

export async function createInkBoard(...args: Parameters<typeof import('./api').createInkBoard>) {
  const { createInkBoard } = await import('./api');
  return createInkBoard(...args);
}

export async function renderInkSnapshot(...args: Parameters<typeof import('./api').renderInkSnapshot>) {
  const { renderInkSnapshot } = await import('./api');
  return renderInkSnapshot(...args);
}
