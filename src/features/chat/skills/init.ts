/**
 * Chat V2 - Skills 系统初始化
 *
 * 当前仅负责标记 skill registry 初始化完成。
 * 旧的 `skill_instruction` context type 已不再注册到运行时主链。
 * 在应用启动时调用
 */

import { skillRegistry } from './registry';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillSystem]';

// ============================================================================
// 初始化状态
// ============================================================================

let _initialized = false;

// ============================================================================
// 初始化函数
// ============================================================================

/**
 * 初始化 Skills 系统
 *
 * 职责：
 * 1. 标记系统为已初始化
 *
 * 注意：skill 加载（loader.ts）由应用在适当时机调用，不在此处自动执行
 *
 * @returns Promise<void>
 */
export async function initializeSkillSystem(): Promise<void> {
  if (_initialized) {
    console.log(LOG_PREFIX, 'Already initialized, skipping duplicate call');
    return;
  }

  console.log(LOG_PREFIX, 'Initializing...');

  // 标记已初始化
  _initialized = true;
  skillRegistry.markInitialized();

  console.log(LOG_PREFIX, 'Initialization complete');
}

/**
 * 检查 Skills 系统是否已初始化
 */
export function isSkillSystemInitialized(): boolean {
  return _initialized;
}

/**
 * 重置 Skills 系统（仅用于测试）
 */
export function resetSkillSystem(): void {
  _initialized = false;
  skillRegistry.reset();
  console.log(LOG_PREFIX, 'Reset (test mode)');
}
