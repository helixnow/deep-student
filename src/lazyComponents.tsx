/**
 * 🚀 性能优化：页面组件懒加载
 *
 * 将页面组件改为 React.lazy() 动态导入，
 * 减少初始 bundle 大小，加快首帧渲染。
 *
 * 清理说明（2026-01）：
 * - 移除废弃组件：MathWorkflowManager、BridgeToIrec、IrecInsightRecall、
 *   IrecServiceSwitcher、MemoryIntakeDashboard（旧版）
 * - ★ 2026-01 移除：IrecGraphFlow、IrecGraphPage、IrecGraphFlowDemo（图谱模块已废弃）
 * - ★ 2026-02 优化：ChatV2Page 改为懒加载，大幅减少初始 bundle（含 DnD/framer-motion/chat-v2 init 等）
 *
 * 首屏必需（保持同步）：
 * - ModernSidebar（侧边栏）
 * - 基础 UI 组件
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

// ============================================================================
// 懒加载 fallback 组件
// ============================================================================

/**
 * 页面加载占位符（极简，避免布局抖动）
 */
export const PageLoadingFallback: React.FC = () => {
  const { t } = useTranslation('common');
  return (
    <div className="flex-1 flex items-center justify-center min-h-[200px]">
      <div className="animate-pulse text-muted-foreground text-sm">{t('loading')}</div>
    </div>
  );
};

// ============================================================================
// 懒加载页面组件
// ============================================================================

// 设置页
export const LazySettings = React.lazy(() =>
  import('./components/Settings').then(m => ({ default: m.Settings }))
);

// ★ 2026-02：批量分析已废弃（旧错题系统已移除）

// 仪表盘
export const LazyDashboard = React.lazy(() =>
  import('./components/Dashboard').then(m => ({ default: m.Dashboard }))
);

// SOTA 仪表盘
export const LazySOTADashboard = React.lazy(() =>
  import('./components/SOTADashboardLite').then(m => ({ default: m.SOTADashboard }))
);

// LLM 使用量统计
export const LazyLlmUsageStatsPage = React.lazy(() =>
  import('./components/llm-usage/LlmUsageStatsPage').then(m => ({ default: m.LlmUsageStatsPage }))
);

// 数据导入导出
export const LazyDataImportExport = React.lazy(() =>
  import('./components/DataImportExport').then(m => ({ default: m.DataImportExport }))
);

// 导入对话框
export const LazyImportConversationDialog = React.lazy(() =>
  import('./components/ImportConversationDialog').then(m => ({ default: m.ImportConversationDialog }))
);

// 技能管理
export const LazySkillsManagementPage = React.lazy(() =>
  import('./components/skills-management/SkillsManagementPage').then(m => ({ default: m.SkillsManagementPage }))
);

// 模板管理
export const LazyTemplateManagementPage = React.lazy(() =>
  import('./components/TemplateManagementPage').then(m => ({ default: m.default }))
);

// 模板 JSON 预览
export const LazyTemplateJsonPreviewPage = React.lazy(() =>
  import('./components/TemplateJsonPreviewPage').then(m => ({ default: m.default }))
);

// ★ 知识图谱已废弃（2026-01 移除）
// LazyIrecGraphFlow, LazyIrecGraphPage, LazyIrecGraphFlowDemo

// 学习中心
export const LazyLearningHubPage = React.lazy(() =>
  import('./components/learning-hub').then(m => ({ default: m.LearningHubPage }))
);

// PDF 阅读器
export const LazyPdfReader = React.lazy(() =>
  import('./components/PdfReader').then(m => ({ default: m.default }))
);

// 开发专用组件：生产构建中 import.meta.env.DEV 为 false，动态 import 被 Rollup 死代码消除
const DevNull: React.FC<any> = () => null;
const devLazy = () => Promise.resolve({ default: DevNull as React.ComponentType<any> });

export const LazyTreeDragTest = import.meta.env.DEV
  ? React.lazy(() => import('./components/notes/TreeDragTest').then(m => ({ default: m.default })))
  : React.lazy(devLazy);

export const LazyCrepeDemoPage = import.meta.env.DEV
  ? React.lazy(() => import('./components/dev/CrepeDemoPage').then(m => ({ default: m.CrepeDemoPage })))
  : React.lazy(devLazy);

export const LazyChatV2IntegrationTest = import.meta.env.DEV
  ? React.lazy(() => import('./chat-v2/dev').then(m => ({ default: m.IntegrationTest })))
  : React.lazy(devLazy);

// 图片查看器
export const LazyImageViewer = React.lazy(() =>
  import('./components/ImageViewer').then(m => ({ default: m.ImageViewer }))
);

// 🚀 Chat V2 主页面（默认视图，改为懒加载以减少初始 bundle）
// 其依赖链包含 @hello-pangea/dnd、framer-motion、chat-v2/init 等重量级模块
export const LazyChatV2Page = React.lazy(() =>
  import('./chat-v2/pages').then(m => ({ default: m.ChatV2Page }))
);
