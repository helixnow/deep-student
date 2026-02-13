export async function computeSha256Hex(payload: string): Promise<string> {
  if (typeof payload !== 'string' || payload.length === 0) {
    return '';
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(payload);

  // 优先使用 Web Crypto（浏览器 / Tauri WebView 原生支持）
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
      return bufferToHex(digest);
    }
  } catch (error: unknown) {
    console.warn('[hash] Web Crypto digest failed, fallback to Node crypto', error);
  }

  // 回退到 Node.js crypto（在单元测试或非浏览器环境）
  try {
    const cryptoModule = await import('node:crypto');
    const hash = cryptoModule.createHash('sha256');
    hash.update(payload);
    return hash.digest('hex');
  } catch (error: unknown) {
    console.error('[hash] Failed to compute SHA-256 digest', error);
    return '';
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hexCodes = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0'));
  return hexCodes.join('');
}





