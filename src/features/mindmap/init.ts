import { registerBuiltinLayouts } from './layouts';
import { registerBuiltinStyles } from './styles';
import { registerBuiltinPresets } from './presets';
import { LayoutRegistry, PresetRegistry, StyleRegistry } from './registry';

/** 是否已初始化 */
let initialized = false;

/** 初始化思维导图模块 - 注册所有内置组件 */
export function initMindMapModule(): void {
  // 防止重复初始化
  if (initialized) {
    return;
  }
  
  try {
    // 注册布局引擎
    registerBuiltinLayouts();
    
    // 注册样式主题
    registerBuiltinStyles();
    
    // 注册预设
    registerBuiltinPresets();
    
    initialized = true;

    if (import.meta.env.DEV) {
      console.log(
        `[MindMap] Module initialized: ${LayoutRegistry.getAll().length} layouts, ${StyleRegistry.getAllIncludingHidden().length} styles (${StyleRegistry.getAll().length} visible), ${PresetRegistry.getAll().length} presets`
      );
    }
  } catch (error) {
    console.error('[MindMap] Module initialization failed:', error);
  }
}

/** 检查是否已初始化 */
export function isInitialized(): boolean {
  return initialized;
}

/** 确保模块已初始化 */
export function ensureInitialized(): void {
  if (!initialized) {
    initMindMapModule();
  }
}

// 自动初始化
initMindMapModule();
