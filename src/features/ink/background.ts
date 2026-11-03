import { invoke } from '@tauri-apps/api/core';
import type { InkPageRef } from './types';

const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024;
const MAX_BACKGROUND_EDGE = 2048;
const MAX_BACKGROUND_PIXELS = 16_000_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

interface VfsBlobBase64Result {
  base64: string;
  mimeType: string;
  size: number;
}

export interface InkBackgroundLease {
  background?: CanvasImageSource;
  dispose(): void;
}

export async function loadInkBackground(pageRef: InkPageRef): Promise<InkBackgroundLease> {
  const background = pageRef.background;
  if (background.kind === 'blank') return { dispose() {} };

  const blob = await invoke<VfsBlobBase64Result>('vfs_get_blob_base64', { blobHash: background.blob_hash });
  if (!blob || blob.mimeType !== 'image/png' || !Number.isSafeInteger(blob.size)
    || blob.size < 0 || blob.size > MAX_BACKGROUND_BYTES || !blob.base64
    || blob.base64.length > Math.ceil(MAX_BACKGROUND_BYTES * 4 / 3) + 4) {
    throw new Error('Frozen Ink PNG background is missing or exceeds the 4 MiB limit.');
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(blob.base64);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Frozen Ink PNG background is not valid base64.');
  }
  if (bytes.byteLength !== blob.size || bytes.length < 24
    || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error('Frozen Ink background bytes do not match the declared PNG blob.');
  }
  const pngWidth = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  const pngHeight = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
  if (pngWidth < 1 || pngHeight < 1 || pngWidth > MAX_BACKGROUND_EDGE || pngHeight > MAX_BACKGROUND_EDGE
    || pngWidth * pngHeight > MAX_BACKGROUND_PIXELS) {
    throw new Error('Frozen Ink PNG dimensions exceed the background limits.');
  }

  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (bitmap.width !== pngWidth || bitmap.height !== pngHeight) {
    bitmap.close();
    throw new Error('Decoded frozen Ink PNG dimensions do not match its header.');
  }
  let disposed = false;
  return {
    background: bitmap,
    dispose() {
      if (disposed) return;
      disposed = true;
      bitmap.close();
    },
  };
}
