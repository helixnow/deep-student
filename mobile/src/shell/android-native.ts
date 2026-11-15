import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { InvokeMessage } from '../../../electron/shell/bridge-messages.ts';

type Permission = 'granted' | 'denied' | 'prompt';
type NotificationOptions = { title: string; body: string; target?: string; pomodoroDeadline?: number };
type ChosenDocument = { id: string; name: string } | { cancelled: true };
type DocumentChunk = { data: string } | { done: true };
type WriterCommand = { kind: 'open'; path: string } | { kind: 'write'; bytes: Uint8Array } | { kind: 'close' } | { kind: 'abort' };

interface DeepStudentNativePlugin {
  setImmersiveMode(options: { enabled: boolean }): Promise<void>;
  getNotificationPermission(): Promise<{ state: Permission }>;
  requestNotificationPermission(): Promise<{ state: Permission }>;
  postNotification(options: NotificationOptions): Promise<{ posted: boolean }>;
  setNotificationPolicy(options: { policy: string }): Promise<void>;
  setPomodoroAlarm(options: { deadline: number; title?: string; body?: string }): Promise<void>;
  addListener(event: 'notificationAction', listener: (payload: { target: string }) => void): Promise<PluginListenerHandle>;
  decodeHeic(options: { data: string }): Promise<{ data: string }>;
  createDocument(options: { fileName: string; mimeType: string }): Promise<ChosenDocument>;
  openDocument(): Promise<ChosenDocument>;
  writeDocumentChunk(options: { id: string; data: string }): Promise<void>;
  readDocumentChunk(options: { id: string }): Promise<DocumentChunk>;
  closeDocument(options: { id: string }): Promise<void>;
}

const native = registerPlugin<DeepStudentNativePlugin>('DeepStudentNative');
const CHUNK_SIZE = 256 * 1024;
const MAX_HEIC_BYTES = 24 * 1024 * 1024;
export const isNativeAndroid = (): boolean => Capacitor.getPlatform() === 'android' && Capacitor.isNativePlatform();
export async function postAndroidNotification(options: NotificationOptions): Promise<boolean> {
  return (await native.postNotification(options)).posted;
}

function encodeBase64(bytes: Uint8Array): string {
  // Slices keep both the spread and the WebView's IPC calls smaller than the engine stack limit.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonArgs(message: InvokeMessage): Record<string, unknown> {
  if (message.payload.contentType !== 'application/json') throw new Error(`${message.cmd} requires JSON arguments`);
  const args: unknown = JSON.parse(message.payload.data);
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error(`${message.cmd} requires an arguments object`);
  return args as Record<string, unknown>;
}

export function createAndroidInvokeHandler(
  onNotification: (target: string) => void,
): (message: InvokeMessage) => Promise<unknown> | undefined {
  let actionListener: Promise<PluginListenerHandle> | undefined;
  return (message) => {
    switch (message.cmd) {
      case 'set_android_immersive_mode': {
        const { enabled } = jsonArgs(message);
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        return native.setImmersiveMode({ enabled });
      }
      case 'plugin:notification|is_permission_granted':
        return native.getNotificationPermission().then(({ state }) => state === 'granted');
      case 'plugin:notification|permission_state':
        return native.getNotificationPermission().then(({ state }) => state);
      case 'plugin:notification|request_permission':
        return native.requestNotificationPermission().then(({ state }) => state);
      case 'plugin:notification|set_policy': {
        const { policy } = jsonArgs(message);
        if (typeof policy !== 'string') throw new Error('policy must be a string');
        return native.setNotificationPolicy({ policy });
      }
      case 'mobile_set_pomodoro_alarm': {
        const { deadline, title, body } = jsonArgs(message);
        if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 0 ||
            (deadline !== 0 && (typeof title !== 'string' || typeof body !== 'string'))) {
          throw new Error('A valid Pomodoro deadline and notification are required');
        }
        return native.setPomodoroAlarm({ deadline, ...(typeof title === 'string' && typeof body === 'string' ? { title, body } : {}) });
      }
      case 'plugin:notification|notify': {
        const { title, body, target, pomodoroDeadline } = jsonArgs(message);
        if (typeof title !== 'string' || typeof body !== 'string') throw new Error('title and body must be strings');
        return postAndroidNotification({
          title, body,
          ...(typeof target === 'string' ? { target } : {}),
          ...(typeof pomodoroDeadline === 'number' && Number.isSafeInteger(pomodoroDeadline) && pomodoroDeadline > 0 ? { pomodoroDeadline } : {}),
        });
      }
      case 'plugin:notification|start_action_listener':
        actionListener ??= native.addListener('notificationAction', ({ target }) => {
          if (typeof target === 'string' && target) onNotification(target);
        }).catch((error) => {
          actionListener = undefined;
          throw error;
        });
        return actionListener.then(() => undefined);
      case 'convert_heic_to_jpeg': {
        if (message.payload.contentType !== 'application/octet-stream') throw new Error('HEIC input must be binary');
        const input = message.payload.data;
        if (input.length === 0 || input.length > MAX_HEIC_BYTES) throw new Error('HEIC attachment is empty or larger than 24 MiB');
        return native.decodeHeic({ data: encodeBase64(input) }).then(({ data }) => decodeBase64(data));
      }
      case 'mobile_save_document': {
        if (message.payload.contentType === 'application/octet-stream') {
          const fileName = decodeURIComponent(message.headers['x-file-name'] ?? '');
          const mimeType = message.headers['x-file-mime'] ?? 'application/octet-stream';
          return saveAndroidDocument(new Blob([new Uint8Array(message.payload.data)]), fileName, mimeType);
        }
        const { path, fileName, mimeType = 'application/octet-stream' } = jsonArgs(message);
        if (typeof path !== 'string' || !/^\/deep-student\/recovery\/exports\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:srt|vtt|txt)$/i.test(path)) {
          throw new Error('An approved subtitle export path is required');
        }
        if (typeof fileName !== 'string' || typeof mimeType !== 'string') throw new Error('A file name and MIME type are required');
        return saveStagedSubtitle(path.slice(path.lastIndexOf('/') + 1), fileName, mimeType);
      }
      default:
        return undefined;
    }
  };
}

async function saveStagedSubtitle(name: string, fileName: string, mimeType: string) {
  const root = await navigator.storage.getDirectory();
  const appData = await root.getDirectoryHandle('deep-student');
  const recovery = await appData.getDirectoryHandle('recovery');
  const exports = await recovery.getDirectoryHandle('exports');
  const handle = await exports.getFileHandle(name);
  try {
    return await saveAndroidDocument(await handle.getFile(), fileName, mimeType);
  } finally {
    await exports.removeEntry(name).catch((error: unknown) => console.warn('[mobile] unable to clean up staged subtitle:', error));
  }
}

export async function saveAndroidDocument(file: Blob, fileName: string, mimeType: string): Promise<{ method: string } | null> {
  if (fileName.trim() === '' || /[/\\\x00]/.test(fileName)) throw new Error('A file name is required');
  const selection = await native.createDocument({ fileName, mimeType });
  if ('cancelled' in selection) return null;
  const { id } = selection;
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      await native.writeDocumentChunk({ id, data: encodeBase64(chunk) });
    }
  } catch (error) {
    await native.closeDocument({ id }).catch(() => undefined);
    throw error;
  }
  await native.closeDocument({ id });
  return { method: 'android-saf' };
}

export async function pickAndroidBackup(targetPath: string): Promise<{ path: string; name: string; size: number } | null> {
  const selection = await native.openDocument();
  if ('cancelled' in selection) return null;
  const { id, name } = selection;
  let worker: Worker | undefined;
  try {
    const writer = worker = new Worker(new URL('./backup-writer.worker.ts', import.meta.url), { type: 'module', name: 'dstu-android-backup-writer' });
    let failure: Error | undefined;
    writer.addEventListener('error', event => { failure = new Error(event.message || 'Unable to start the Android backup writer'); });
    writer.addEventListener('messageerror', () => { failure = new Error('Invalid message from the Android backup writer'); });
    const send = (command: WriterCommand): Promise<void> => {
      if (failure) return Promise.reject(failure);
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          writer.removeEventListener('message', onMessage);
          writer.removeEventListener('error', onError);
          writer.removeEventListener('messageerror', onError);
        };
        const onError = () => { cleanup(); reject(failure ?? new Error('Android backup writer failed')); };
        const onMessage = (event: MessageEvent<{ error?: string }>) => {
          cleanup();
          if (event.data.error !== undefined) reject(new Error(event.data.error));
          else resolve();
        };
        writer.addEventListener('message', onMessage);
        writer.addEventListener('error', onError);
        writer.addEventListener('messageerror', onError);
        try {
          writer.postMessage(command, command.kind === 'write' ? [command.bytes.buffer] : []);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    };

    await send({ kind: 'open', path: targetPath });
    let size = 0;
    try {
      for (;;) {
        const next = await native.readDocumentChunk({ id });
        if ('done' in next) break;
        const bytes = decodeBase64(next.data);
        size += bytes.byteLength;
        await send({ kind: 'write', bytes });
      }
      await native.closeDocument({ id });
      await send({ kind: 'close' });
    } catch (error) {
      await send({ kind: 'abort' }).catch(() => undefined);
      throw error;
    }
    return { path: targetPath, name, size };
  } catch (error) {
    await native.closeDocument({ id }).catch(() => undefined);
    throw error;
  } finally {
    worker?.terminate();
  }
}
