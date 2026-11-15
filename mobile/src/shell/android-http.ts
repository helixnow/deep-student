import { registerPlugin } from '@capacitor/core';
import type { ShellRequest } from '../../../host/kernel/protocol.ts';
import { isNativeAndroid } from './android-native.ts';

type ReplyHead = { url: string; status: number; statusText: string; headers: Record<string, string> };
type OpenArgs = {
  id: string; url: string; method: string; headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer; address?: Uint8Array;
  uploadStream?: boolean; timeoutMs?: number | null;
};
type Id = { id: string };
const native = registerPlugin<{
  resolve(args: { host: string }): Promise<{ addresses: string[] }>;
  open(args: Omit<OpenArgs, 'body' | 'address'> & { bodyBase64?: string; addressBytes?: string }): Promise<ReplyHead>;
  write(args: Id & { bodyBase64?: string }): Promise<void>;
  read(args: Id): Promise<{ done: boolean; bodyBase64?: string }>;
  cancel(args: Id): Promise<void>;
}>('DeepStudentHttp');

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function androidHttpRequest(request: ShellRequest): Promise<unknown> {
  if (request.op === 'http.android.available') return isNativeAndroid();
  if (!isNativeAndroid()) throw new Error('Android HTTP transport is unavailable');
  switch (request.op) {
    case 'http.android.resolve': return native.resolve(request.args as { host: string });
    case 'http.android.open': {
      const { body, address, ...options } = request.args as OpenArgs;
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body)
        : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      return native.open({ ...options, ...(bytes === undefined ? {} : { bodyBase64: encode(bytes) }),
        ...(address === undefined ? {} : { addressBytes: encode(address) }) });
    }
    case 'http.android.write': {
      const { id, bytes } = request.args as Id & { bytes?: Uint8Array };
      await native.write({ id, ...(bytes === undefined ? {} : { bodyBase64: encode(bytes) }) });
      return null;
    }
    case 'http.android.read': {
      const chunk = await native.read(request.args as Id);
      return chunk.done ? { done: true } : {
        done: false, bytes: Uint8Array.from(atob(chunk.bodyBase64!), character => character.charCodeAt(0)),
      };
    }
    case 'http.android.cancel': await native.cancel(request.args as Id); return null;
    default: throw new Error(`Unknown Android HTTP operation: ${request.op}`);
  }
}
