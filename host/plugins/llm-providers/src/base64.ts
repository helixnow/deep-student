/** Portable base64 helpers (Web `btoa`/`atob`) matching `Buffer#toString('base64' | 'base64url')`. */

const CHUNK = 0x8000;

function binaryString(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return out;
}

/** Standard alphabet with `=` padding. */
export function encodeBase64(bytes: Uint8Array): string {
  return btoa(binaryString(bytes));
}

/** URL-safe alphabet without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes URL-safe unpadded text already restricted to `[A-Za-z0-9_-]` with `length % 4 !== 1`. */
export function decodeBase64Url(text: string): Uint8Array {
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
