/**
 * 测试模式检测与配置工具
 * 
 * 功能：
 * - 检测应用是否运行在测试模式
 * - 提供测试模式相关的配置和工具函数
 */

import { getErrorMessage } from './errorUtils';

// ==================== 迁移逻辑 ====================

const LEGACY_KEYS = {
  testMode: 'AIMM_TEST_MODE',
  testConfig: 'AIMM_TEST_CONFIG',
} as const;

const NEW_KEYS = {
  testMode: 'DSTU_TEST_MODE',
  testConfig: 'DSTU_TEST_CONFIG',
} as const;

/**
 * 迁移旧版 AIMM_* localStorage 键到新版 DSTU_*
 */
function migrateLegacyTestModeKeys(): void {
  try {
    // 迁移 TEST_MODE
    const oldMode = localStorage.getItem(LEGACY_KEYS.testMode);
    if (oldMode && !localStorage.getItem(NEW_KEYS.testMode)) {
      localStorage.setItem(NEW_KEYS.testMode, oldMode);
      localStorage.removeItem(LEGACY_KEYS.testMode);
    }
    // 迁移 TEST_CONFIG
    const oldConfig = localStorage.getItem(LEGACY_KEYS.testConfig);
    if (oldConfig && !localStorage.getItem(NEW_KEYS.testConfig)) {
      localStorage.setItem(NEW_KEYS.testConfig, oldConfig);
      localStorage.removeItem(LEGACY_KEYS.testConfig);
    }
  } catch {
    // localStorage 不可用时静默失败
  }
}

// ==================== 测试模式检测 ====================

/**
 * 检测是否在测试模式下运行
 * 测试模式可通过以下方式激活：
 * 1. URL参数: ?test=true 或 ?test-mode=true
 * 2. localStorage: DSTU_TEST_MODE=true
 * 3. 环境变量: TAURI_TEST=1 (在开发环境中)
 */
export function isTestMode(): boolean {
  // 检查URL参数
  if (typeof window !== 'undefined') {
    // 先执行迁移
    migrateLegacyTestModeKeys();
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('test') === 'true' || urlParams.get('test-mode') === 'true') {
      return true;
    }

    // 检查localStorage
    try {
      const stored = localStorage.getItem('DSTU_TEST_MODE');
      if (stored === 'true') {
        return true;
      }
    } catch {
      // localStorage可能不可用
    }

    // 检查环境变量（在开发模式下）
    if (import.meta.env.DEV && import.meta.env.VITE_TAURI_TEST === '1') {
      return true;
    }
  }

  return false;
}

/**
 * 启用测试模式（写入localStorage）
 */
export function enableTestMode(): void {
  try {
    localStorage.setItem('DSTU_TEST_MODE', 'true');
  } catch (error: unknown) {
    console.error('[TestMode] Failed to enable test mode:', error);
  }
}

/**
 * 禁用测试模式（清除localStorage）
 */
export function disableTestMode(): void {
  try {
    localStorage.removeItem('DSTU_TEST_MODE');
  } catch (error: unknown) {
    console.error('[TestMode] Failed to disable test mode:', error);
  }
}

/**
 * 获取测试数据库路径（相对于应用数据目录）
 */
export function getTestDatabasePath(): string {
  return 'test-db.sqlite';
}

/**
 * 获取测试数据目录路径
 */
export function getTestDataDir(): string {
  return 'test-data';
}

/**
 * 检查测试相关的依赖服务是否可用（调用后端命令）
 */
export async function checkTestDependencies(): Promise<{
  available: boolean;
  details: {
    prometheus?: boolean;
    graphRag?: boolean;
    webSearch?: boolean;
  };
  errors: string[];
}> {
  try {
    const { invokeWithDebug } = await import('./tauriApi');
    const result = await invokeWithDebug<{
      available: boolean;
      details: Record<string, boolean>;
      errors: string[];
      results: Array<{
        service: string;
        available: boolean;
        latency_ms?: number;
        error?: string;
      }>;
    }>('check_test_dependencies', {}, { tag: 'test_health' });

    return {
      available: result.available,
      details: {
        prometheus: result.details.prometheus,
        graphRag: result.details.graph_rag,
        webSearch: result.details.web_search,
      },
      errors: result.errors,
    };
  } catch (error: unknown) {
    return {
      available: false,
      details: {},
      errors: [`Health check failed: ${getErrorMessage(error)}`],
    };
  }
}

/**
 * 获取测试模式配置
 */
export function getTestModeConfig(): {
  enabled: boolean;
  useMockServices: boolean;
  recordMode: boolean;
  replayMode: boolean;
  temperature: number;
  modelOverride?: string;
} {
  const enabled = isTestMode();
  
  try {
    const configStr = localStorage.getItem('DSTU_TEST_CONFIG');
    if (configStr) {
      const config = JSON.parse(configStr);
      return {
        enabled,
        useMockServices: config.useMockServices === true,
        recordMode: config.recordMode === true,
        replayMode: config.replayMode === true,
        temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
        modelOverride: config.modelOverride,
      };
    }
  } catch {
    // 使用默认配置
  }

  return {
    enabled,
    useMockServices: false,
    recordMode: false,
    replayMode: false,
    temperature: 0.3, // 测试模式默认低温度
  };
}

/**
 * 保存测试模式配置
 */
export function saveTestModeConfig(config: {
  useMockServices?: boolean;
  recordMode?: boolean;
  replayMode?: boolean;
  temperature?: number;
  modelOverride?: string;
}): void {
  try {
    const current = getTestModeConfig();
    const updated = {
      ...current,
      ...config,
    };
    localStorage.setItem('DSTU_TEST_CONFIG', JSON.stringify(updated));
  } catch (error: unknown) {
    console.error('[TestMode] Failed to save test config:', error);
  }
}


// ==================== 导出 ====================

export const TestMode = {
  isEnabled: isTestMode,
  enable: enableTestMode,
  disable: disableTestMode,
  getDatabasePath: getTestDatabasePath,
  getDataDir: getTestDataDir,
  checkDependencies: checkTestDependencies,
  getConfig: getTestModeConfig,
  saveConfig: saveTestModeConfig,
};
