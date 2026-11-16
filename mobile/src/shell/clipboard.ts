/**
 * 移动端 `plugin:clipboard-manager|*` 处理（对应 `@tauri-apps/plugin-clipboard-manager`）。
 *
 * 优先调用 `navigator.clipboard.writeText/readText`，`write_text` 在受限 WebView 下回退到隐藏 `<textarea>` + `execCommand('copy')`。
 */
import { optString, parseJsonArgs, reqString, type MobilePluginHandler } from './plugin-args.ts';

function copyWithTextareaFallback(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback.
    }
  }
  if (copyWithTextareaFallback(text)) return;
  throw new Error('当前环境不支持写入剪贴板');
}

async function readClipboardText(): Promise<string> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    return navigator.clipboard.readText();
  }
  throw new Error('当前环境不支持读取剪贴板文本');
}

/** 创建供 `MobileShell` 使用的 `plugin:clipboard-manager|*` 处理器。 */
export function createMobileClipboardHandler(): MobilePluginHandler {
  return async ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'clipboard-manager');
    switch (command) {
      case 'write_text':
        await writeClipboardText(reqString(args, 'text', command));
        return null;
      case 'read_text':
        return readClipboardText();
      case 'clear':
        await writeClipboardText('');
        return null;
      case 'write_html': {
        const html = reqString(args, 'html', command);
        const alt = optString(args, 'altText', command);
        await writeClipboardText(alt ?? html);
        return null;
      }
      case 'read_image':
      case 'write_image':
        throw new Error('当前移动端不支持剪贴板图片读写');
      default:
        throw new Error(`unsupported clipboard-manager command "${command}"`);
    }
  };
}
