import { TFunction } from 'i18next';
import {
  Brain,
  SquareStack,
  Settings,
  Palette,
  Zap,
  GraduationCap,
  ListChecks,
} from 'lucide-react';
import DsAnalysisIconMuted from '../components/icons/DsAnalysisIconMuted';

/**
 * 统一的导航视图类型定义
 * 
 * 清理说明（2026-01）：
 * - 移除废弃视图：library、math-workflow、notes
 * - 移除：irec-graph（知识图谱）
 */
// ★ 2026-01：知识库入口已整合到 Learning Hub
export type NavViewType =
  | 'settings'
  | 'task-dashboard'
  | 'template-management'
  | 'chat-v2'
  | 'learning-hub'
  | 'skills-management'
  | 'todo';

/**
 * 导航项类型定义
 */
export type NavItem = {
  name: string;
  view: NavViewType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- icon components from Lucide/custom SVG have varying prop signatures
  icon: React.ComponentType<any>;
  skipIndicator?: boolean;
};

/**
 * 创建统一的导航项配置
 * 确保Topbar和MobileNavDrawer使用相同的导航项
 * 
 * @param t - i18next翻译函数
 * @returns 导航项数组
 */
export const createNavItems = (t: TFunction): NavItem[] => {
  const items: NavItem[] = [
    // 🔧 Chat V2 放第一位
    {
      name: t('sidebar:navigation.chat_v2', '聊天'),
      view: 'chat-v2',
      icon: DsAnalysisIconMuted,
    },
    // 🔧 学习资源放第二位
    {
      name: t('sidebar:navigation.learning_hub', '学习资源'),
      view: 'learning-hub',
      icon: GraduationCap,
    },
    // ★ 待办事项放在学习资源后面
    {
      name: t('sidebar:navigation.todo', '待办'),
      view: 'todo',
      icon: ListChecks,
    },
    // ★ 2026-01：用户记忆已集成到 Learning Hub 的 MemoryView
    {
      name: t('sidebar:navigation.skills_management', '技能管理'),
      view: 'skills-management',
      icon: Zap,
    },
    {
      name: t('sidebar:navigation.anki_generation', '制卡任务'),
      view: 'task-dashboard',
      icon: SquareStack,
    },
    {
      name: t('sidebar:navigation.template_management', '模板库'),
      view: 'template-management',
      icon: Palette,
    },
    {
      name: t('sidebar:navigation.settings', '系统'),
      view: 'settings',
      icon: Settings,
    },
  ];

  return items;
};

/**
 * 导航项总数（用于布局计算）
 */
export const NAV_ITEMS_COUNT = 7;

/**
 * 估算单个导航项的平均宽度（像素）
 * 用于溢出检测的粗略计算
 */
export const ESTIMATED_NAV_ITEM_WIDTH = 100;

/**
 * Topbar的固定元素宽度估算（Logo + 分隔符 + 控制按钮等）
 */
export const TOPBAR_FIXED_ELEMENTS_WIDTH = 200;
