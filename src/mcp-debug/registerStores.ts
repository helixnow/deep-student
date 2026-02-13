/**
 * MCP Debug - Store 自动注册
 * 
 * 在调试模式下自动注册 Zustand stores 到 MCP Debug 模块
 */

import { storeDebugger } from './core/storeDebugger';

// 延迟导入，避免循环依赖
type StoreModule = { [key: string]: any };

/**
 * 注册所有可用的 stores
 * 
 * 这个函数会动态导入并注册各个 store，
 * 用于调试时观察状态变化
 */
export async function registerAllStores(): Promise<void> {
  const storeConfigs: Array<{
    name: string;
    module: () => Promise<StoreModule>;
    exportName: string;
  }> = [
    // Chat V2 相关
    {
      name: 'workspace',
      module: () => import('../chat-v2/workspace/workspaceStore'),
      exportName: 'useWorkspaceStore',
    },
    // 主要功能 stores
    {
      name: 'notesTree',
      module: () => import('../stores/notesTreeStore'),
      exportName: 'useNotesTreeStore',
    },
    {
      name: 'unifiedIndex',
      module: () => import('../stores/unifiedIndexStore'),
      exportName: 'useUnifiedIndexStore',
    },
    {
      name: 'reviewPlan',
      module: () => import('../stores/reviewPlanStore'),
      exportName: 'useReviewPlanStore',
    },
    {
      name: 'questionBank',
      module: () => import('../stores/questionBankStore'),
      exportName: 'useQuestionBankStore',
    },
    {
      name: 'pdfSettings',
      module: () => import('../stores/pdfSettingsStore'),
      exportName: 'usePdfSettingsStore',
    },
    {
      name: 'ankiUI',
      module: () => import('../stores/anki/useAnkiUIStore'),
      exportName: 'useAnkiUIStore',
    },
    {
      name: 'ankiQueue',
      module: () => import('../stores/ankiQueueStore'),
      exportName: 'useAnkiQueueStore',
    },
    {
      name: 'templateAI',
      module: () => import('../stores/templateAiStore'),
      exportName: 'useTemplateAIStore',
    },
    // MindMap 相关
    {
      name: 'mindmap',
      module: () => import('../components/mindmap/store/mindmapStore'),
      exportName: 'useMindMapStore',
    },
    {
      name: 'mindmapUI',
      module: () => import('../components/mindmap/store/uiStore'),
      exportName: 'useUIStore',
    },
    {
      name: 'mindmapHistory',
      module: () => import('../components/mindmap/store/historyStore'),
      exportName: 'useHistoryStore',
    },
    {
      name: 'mindmapDocument',
      module: () => import('../components/mindmap/store/documentStore'),
      exportName: 'useDocumentStore',
    },
    // Learning Hub
    {
      name: 'finder',
      module: () => import('../components/learning-hub/stores/finderStore'),
      exportName: 'useFinderStore',
    },
    {
      name: 'recent',
      module: () => import('../components/learning-hub/stores/recentStore'),
      exportName: 'useRecentStore',
    },
    // 研究相关
    {
      name: 'research',
      module: () => import('../stores/researchStore'),
      exportName: 'useHpiasStore',
    },
  ];

  const results = {
    success: [] as string[],
    failed: [] as string[],
  };

  for (const config of storeConfigs) {
    try {
      const mod = await config.module();
      const store = mod[config.exportName];
      
      if (store && typeof store === 'function') {
        // Zustand store 是一个函数，直接调用获取实际的 store API
        // 大多数情况下，我们需要获取底层的 store API
        if (typeof store.getState === 'function') {
          // 这是一个 vanilla store 或者已经是 store API
          storeDebugger.registerStore(config.name, store);
          results.success.push(config.name);
        } else {
          // 这是一个 React hook，我们需要用特殊方式处理
          // 对于 useStore hooks，我们需要找到底层的 store
          // Zustand 的 create() 返回的 hook 有 getState 和 setState 方法
          const storeApi = store as any;
          if (storeApi.getState) {
            storeDebugger.registerStore(config.name, storeApi);
            results.success.push(config.name);
          } else {
            console.warn(`[MCP Debug] Store "${config.name}" does not have getState method`);
            results.failed.push(config.name);
          }
        }
      } else {
        console.warn(`[MCP Debug] Store "${config.name}" not found in module`);
        results.failed.push(config.name);
      }
    } catch (err: unknown) {
      console.warn(`[MCP Debug] Failed to register store "${config.name}":`, err);
      results.failed.push(config.name);
    }
  }

  console.log(`[MCP Debug] Stores registered: ${results.success.length} success, ${results.failed.length} failed`);
  if (results.success.length > 0) {
    console.log(`[MCP Debug] Registered stores: ${results.success.join(', ')}`);
  }
}

/**
 * 手动注册单个 store
 */
export function registerStore(name: string, store: any): void {
  try {
    storeDebugger.registerStore(name, store);
    console.log(`[MCP Debug] Store "${name}" registered`);
  } catch (err: unknown) {
    console.error(`[MCP Debug] Failed to register store "${name}":`, err);
  }
}

/**
 * 获取已注册的 store 列表
 */
export function getRegisteredStores(): string[] {
  return storeDebugger.getRegisteredStores();
}
