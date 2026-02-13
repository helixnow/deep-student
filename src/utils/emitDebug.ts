/**
 * 从 _legacy/chat-core/dev/emitDebug.ts 迁移
 * 调试事件发射工具
 */

export type DebugEvent = {
  channel: string;
  eventName?: string;
  payload?: any;
  meta?: Record<string, any>;
  ts?: number;
};

export function sanitizeDebugPayload(input: any): any {
  const MAX_INLINE = 200;
  const heavyKeys = new Set(['base64', 'base64content', 'text', 'content', 'textcontent', 'text_content', 'content_text', 'raw_text', 'rawcontent', 'raw_content', 'html']);

  const pathIsAttachment = (path: string[]) => {
    const s = path.join('.').toLowerCase();
    return s.includes('attachment') || s.includes('attachments') || s.includes('doc_attachments') || s.includes('documents') || s.includes('files');
  };

  const redact = (v: any, path: string[]): any => {
    if (v == null) return v;
    if (typeof v === 'string') {
      if (pathIsAttachment(path) && v.length > MAX_INLINE) return `[omitted ${v.length} chars]`;
      if (v.length > MAX_INLINE) return `[omitted ${v.length} chars]`;
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => redact(x, path.concat(String(i))));
    if (typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        const kl = k.toLowerCase();
        if (heavyKeys.has(kl)) {
          if (typeof val === 'string' && val.length > MAX_INLINE) { out[k] = `[omitted ${val.length} chars]`; continue; }
        }
        if (typeof val === 'string') {
          if (kl.includes('base64') || kl.includes('dataurl') || kl.includes('data_url')) {
            out[k] = val.length > MAX_INLINE ? `[omitted base64 ${val.length} chars]` : val;
            continue;
          }
          if (pathIsAttachment(path) && val.length > MAX_INLINE) {
            out[k] = `[omitted ${val.length} chars]`;
            continue;
          }
        }
        if (Array.isArray(val) && (kl.includes('attachments') || kl.includes('files') || kl.includes('documents') || kl.includes('sources'))) {
          out[k] = val.map((item: any) => redact(item, path.concat(k)));
          continue;
        }
        out[k] = redact(val, path.concat(k));
      }
      return out;
    }
    return v;
  };

  try { return redact(input, []); } catch { return input; }
}

export function getDebugEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      try {
        const testMode = localStorage.getItem('DSTU_TEST_MODE');
        if (testMode === 'true') return true;
      } catch {}
    }
    if (typeof process !== 'undefined' && process.env?.DSTU_DEBUG) {
      return process.env.DSTU_DEBUG === 'true';
    }
    if ((import.meta as any)?.env?.VITE_DSTU_DEBUG) {
      return (import.meta as any).env.VITE_DSTU_DEBUG === 'true';
    }
    return (import.meta as any)?.env?.DEV === true;
  } catch {
    return false;
  }
}

// 完全禁用以避免日志风暴
export function emitDebug(_ev: DebugEvent) {}
