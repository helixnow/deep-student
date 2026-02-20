import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    // Try Tauri native plugin first
    await writeText(text);
    return true;
  } catch (error) {
    console.warn('Tauri clipboard plugin failed, falling back to navigator.clipboard', error);
  }

  // Fallback to Web API (navigator.clipboard)
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('navigator.clipboard failed, falling back to execCommand', error);
  }

  // Final fallback (execCommand)
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const successful = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!successful) throw new Error('execCommand copy failed');
  return true;
}

export async function readTextFromClipboard(): Promise<string | null> {
  try {
    // Try Tauri native plugin first
    const text = await readText();
    return text || null;
  } catch (error) {
    console.warn('Tauri clipboard plugin failed, falling back to navigator.clipboard', error);
  }

  // Fallback to Web API
  try {
    if (navigator?.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    console.warn('navigator.clipboard.readText failed', error);
  }
  
  return null;
}
