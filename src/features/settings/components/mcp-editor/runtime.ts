import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const invoke = isTauri ? tauriInvoke : null;
