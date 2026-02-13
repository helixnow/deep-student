/**
 * 调试面板总开关
 * 控制所有调试日志的输出，当关闭时不输出任何日志到控制台
 */

const STORAGE_KEY = 'DSTU_DEBUG_MASTER_SWITCH';

class DebugMasterSwitch {
  private enabled: boolean;
  private listeners: Set<(enabled: boolean) => void> = new Set();

  constructor() {
    // 默认关闭，避免日常使用时产生大量日志
    this.enabled = this.loadState();
  }

  private loadState(): boolean {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        return stored === 'true';
      }
    } catch {}
    return false; // 默认关闭
  }

  private saveState(): void {
    try {
      localStorage.setItem(STORAGE_KEY, String(this.enabled));
    } catch {}
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.saveState();
    this.notifyListeners();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.saveState();
    this.notifyListeners();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.saveState();
    this.notifyListeners();
    return this.enabled;
  }

  /**
   * 添加状态变化监听器
   */
  addListener(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.enabled);
      } catch {}
    });
  }
}

// 全局单例
export const debugMasterSwitch = new DebugMasterSwitch();

// 暴露到 window 对象，便于控制台调试
if (typeof window !== 'undefined') {
  (window as any).__debugMasterSwitch = debugMasterSwitch;
}

/**
 * 条件日志函数 - 仅在调试开关开启时输出
 * 用于替换 console.log/debug/warn/error
 */
export const debugLog = {
  log: (...args: any[]) => {
    if (debugMasterSwitch.isEnabled()) {
      console.log(...args);
    }
  },
  debug: (...args: any[]) => {
    if (debugMasterSwitch.isEnabled()) {
      console.debug(...args);
    }
  },
  warn: (...args: any[]) => {
    if (debugMasterSwitch.isEnabled()) {
      console.warn(...args);
    }
  },
  info: (...args: any[]) => {
    if (debugMasterSwitch.isEnabled()) {
      console.info(...args);
    }
  },
  // error 始终输出，不受开关控制（错误信息重要）
  error: (...args: any[]) => {
    console.error(...args);
  },
};
