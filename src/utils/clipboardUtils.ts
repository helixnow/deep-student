import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';

export async function copyTextToClipboard(text: string): Promise<boolean> {
  // 1. Try Tauri plugin wrapper
  try {
    await writeText(text);
    return true;
  } catch (error) {
    console.warn('[clipboard] Tauri plugin writeText failed:', error);
  }

  // 2. Try Tauri IPC directly (bypasses plugin JS wrapper)
  try {
    await invoke('plugin:clipboard-manager|write_text', { text });
    return true;
  } catch (error) {
    console.warn('[clipboard] Tauri direct invoke failed:', error);
  }

  // 3. Fallback to Web API (navigator.clipboard)
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('[clipboard] navigator.clipboard.writeText failed:', error);
  }

  // 4. Final fallback (execCommand - deprecated but try anyway)
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (successful) return true;
  } catch (error) {
    console.warn('[clipboard] execCommand fallback failed:', error);
  }

  throw new Error('All clipboard methods failed. Check browser console for details.');
}

export async function readTextFromClipboard(): Promise<string | null> {
  // 1. Try Tauri plugin wrapper
  try {
    const text = await readText();
    return text || null;
  } catch (error) {
    console.warn('[clipboard] Tauri plugin readText failed:', error);
  }

  // 2. Try Tauri IPC directly
  try {
    const text = await invoke<string>('plugin:clipboard-manager|read_text');
    return text || null;
  } catch (error) {
    console.warn('[clipboard] Tauri direct invoke read failed:', error);
  }

  // 3. Fallback to Web API
  try {
    if (navigator?.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    console.warn('[clipboard] navigator.clipboard.readText failed:', error);
  }
  
  return null;
}
