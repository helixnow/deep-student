// 全局类型定义

// Google Analytics类型
declare global {
  interface Window {
    gtag?: (
      command: 'event' | 'config' | 'set',
      action: string,
      parameters?: {
        [key: string]: any;
      }
    ) => void;
  }
}

// 确保这是一个模块
export {};