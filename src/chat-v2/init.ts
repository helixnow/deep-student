/**
 * Chat V2 - 初始化文件
 *
 * 导入此文件会：
 * 1. 加载样式文件
 * 2. 注册所有内置插件（模式、块、事件）
 * 3. 初始化全局配置
 *
 * 使用方式：
 * ```typescript
 * // 在应用启动时导入
 * import '@/chat-v2/init';
 * ```
 *
 * 样式使用说明：
 * - 所有样式限定在 .chat-v2 作用域内，不会污染其他模块
 * - 在 Chat V2 容器组件上添加 className="chat-v2"
 * - 暗色模式自动响应 :root.dark / .dark / [data-theme="dark"]
 */

// ============================================================================
// 样式文件（必须在组件之前导入）
// ============================================================================

import './styles/index.css';

// ============================================================================
// 初始化上下文类型系统
// ============================================================================

import { initializeContextSystem } from './context';

try {
  initializeContextSystem();
} catch (error) {
  console.error('[Chat V2] Context system initialization failed:', error);
}

// ============================================================================
// 初始化 Schema 工具注册表（文档 26）
// ============================================================================

import { initializeToolRegistry } from './tools';

try {
  initializeToolRegistry();
} catch (error) {
  console.error('[Chat V2] Tool registry initialization failed:', error);
}

// ============================================================================
// 初始化 Skills 系统
// ============================================================================

import { initializeSkillSystem, loadSkillsFromFileSystem } from './skills';
import { skillRegistry } from './skills/registry';

// 注册 skill_instruction 上下文类型
initializeSkillSystem().catch((error) => {
  console.error('[Chat V2] Skill system initialization failed:', error);
});

// 延迟加载 skills 文件（等待 Tauri 初始化完成后再执行）
const loadSkillsWhenReady = async () => {
  try {
    const tauriApi = (await import('@/utils/tauriApi')) as {
      waitForTauriReady?: () => Promise<void>;
    };
    await tauriApi.waitForTauriReady?.();
  } catch {
    // fallback: 如果 waitForTauriReady 不可用，延迟 500ms
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  loadSkillsFromFileSystem()
    .then((stats) => {
      console.log(`[Chat V2] Skills loaded: ${stats.total} (global=${stats.global}, project=${stats.project})`);
    })
    .catch((error) => {
      console.error('[Chat V2] Skills loading failed:', error);
    })
    .finally(() => {
      skillRegistry.markSkillsLoaded();
    });
};
loadSkillsWhenReady();

// ============================================================================
// 初始化 Workspace 事件监听
// ============================================================================

import { initWorkspaceEventListeners } from './workspace/events';

initWorkspaceEventListeners()
  .then(() => {
    console.log('[Chat V2] Workspace event listeners initialized');
  })
  .catch((error) => {
    console.error('[Chat V2] Workspace event initialization failed:', error);
  });

// ============================================================================
// 注册所有插件
// ============================================================================

// 导入插件即自动注册
import './plugins';

// ============================================================================
// 导出
// ============================================================================

// 导出所有核心模块
export * from './core/types';
export * from './registry';
export * from './hooks';
export * from './components';
export * from './context';
export * from './skills';

// 版本信息
export const CHAT_V2_VERSION = '2.0.0';

// 初始化完成标志
export const CHAT_V2_INITIALIZED = true;

console.log(`[Chat V2] Initialized v${CHAT_V2_VERSION}`);
