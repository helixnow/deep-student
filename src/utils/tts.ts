/**
 * 文字转语音（TTS）工具
 * 混合方案：优先使用浏览器 Web Speech API，回退到 Tauri 命令
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import i18n from '../i18n';

export interface TTSOptions {
  lang?: string; // 语言代码，如 'zh-CN', 'en-US', 'ja-JP'
  rate?: number; // 语速，0.1-10，默认 1
  pitch?: number; // 音调，0-2，默认 1
  volume?: number; // 音量，0-1，默认 1
}

let currentUtterance: SpeechSynthesisUtterance | null = null;
let usingTauriTTS = false;

/**
 * 检查浏览器是否支持 TTS
 */
export function isTTSSupported(): boolean {
  return 'speechSynthesis' in window;
}

/**
 * 检查 Tauri TTS 命令是否可用
 */
async function isTauriTTSAvailable(): Promise<boolean> {
  try {
    await invoke('tts_check_available');
    return true;
  } catch {
    return false;
  }
}

/**
 * 朗读文本（混合方案）
 * @param text 要朗读的文本
 * @param options TTS 选项
 */
export async function speak(text: string, options: TTSOptions = {}): Promise<void> {
  // 策略1：尝试使用 Web Speech API
  if (isTTSSupported()) {
    try {
      await speakWithWebAPI(text, options);
      usingTauriTTS = false;
      return;
    } catch (error: unknown) {
      console.warn('Web Speech API 失败，尝试使用 Tauri TTS:', error);
    }
  }

  // 策略2：回退到 Tauri TTS（如果可用）
  if (await isTauriTTSAvailable()) {
    try {
      await speakWithTauri(text, options);
      usingTauriTTS = true;
      return;
    } catch (error: unknown) {
      console.error('Tauri TTS 失败:', error);
      throw new Error(t('utils.errors.tts_unavailable'));
    }
  }

  throw new Error(t('utils.errors.tts_not_supported'));
}

/**
 * 使用 Web Speech API 朗读
 */
function speakWithWebAPI(text: string, options: TTSOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    // 停止当前的朗读
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // 设置参数
    utterance.lang = options.lang || i18n.language || 'en-US';
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1;
    utterance.volume = options.volume ?? 1;

    // 事件监听
    utterance.onend = () => {
      if (currentUtterance === utterance) {
        currentUtterance = null;
      }
      resolve();
    };

    utterance.onerror = (event) => {
      if (currentUtterance === utterance) {
        currentUtterance = null;
      }
      // 'canceled' 是主动停止，不视为错误
      if (event.error === 'canceled') {
        resolve();
      } else {
        reject(new Error(`Web Speech API failed: ${event.error}`));
      }
    };

    currentUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * 使用 Tauri 系统 TTS 朗读
 */
async function speakWithTauri(text: string, options: TTSOptions): Promise<void> {
  await invoke('tts_speak', {
    text,
    lang: options.lang || i18n.language || 'en-US',
    rate: options.rate ?? 1.0,
    volume: options.volume ?? 1.0,
  });
}

/**
 * 停止朗读
 */
export async function stop(): Promise<void> {
  if (usingTauriTTS) {
    try {
      await invoke('tts_stop');
    } catch (error: unknown) {
      console.warn('停止 Tauri TTS 失败:', error);
    }
  } else if (isTTSSupported()) {
    window.speechSynthesis.cancel();
    currentUtterance = null;
  }
}

/**
 * 暂停朗读
 */
export function pause(): void {
  if (isTTSSupported() && window.speechSynthesis.speaking) {
    window.speechSynthesis.pause();
  }
}

/**
 * 恢复朗读
 */
export function resume(): void {
  if (isTTSSupported() && window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
  }
}

/**
 * 检查是否正在朗读
 */
export function isSpeaking(): boolean {
  return isTTSSupported() && window.speechSynthesis.speaking;
}

/**
 * 检查是否已暂停
 */
export function isPaused(): boolean {
  return isTTSSupported() && window.speechSynthesis.paused;
}

/**
 * 获取可用的语音列表
 */
export function getVoices(): SpeechSynthesisVoice[] {
  if (!isTTSSupported()) {
    return [];
  }
  return window.speechSynthesis.getVoices();
}

/**
 * 根据语言代码获取推荐的语音
 */
export function getRecommendedVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = getVoices();
  // 优先查找完全匹配的语音
  let voice = voices.find(v => v.lang === lang);
  if (voice) return voice;
  
  // 查找语言前缀匹配的语音（如 'zh' 匹配 'zh-CN'）
  const langPrefix = lang.split('-')[0];
  voice = voices.find(v => v.lang.startsWith(langPrefix));
  if (voice) return voice;
  
  return null;
}

/**
 * 语言代码映射
 */
export const LANGUAGE_CODES: Record<string, string> = {
  'zh': 'zh-CN',
  'en': 'en-US',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
  'fr': 'fr-FR',
  'de': 'de-DE',
  'es': 'es-ES',
  'ru': 'ru-RU',
  'ar': 'ar-SA',
  'pt': 'pt-PT',
  'it': 'it-IT',
};

/**
 * 将简写语言代码转换为完整语言代码
 */
export function getFullLanguageCode(lang: string): string {
  return LANGUAGE_CODES[lang] || lang;
}

