import { TFunction } from 'i18next';
import {
  StudyBlocksIcon,
  StudyBooksIcon,
  StudyChatIcon,
  StudyMagicWandIcon,
  StudySettingsIcon,
  StudyStackIcon,
  StudyTodoIcon,
} from '../components/icons/StudySidebarIcons';

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
  | 'ui-lab'
  | 'todo';

/**
 * 导航项类型定义
 */
export type NavItem = {
  name: string;
  view: NavViewType;
  icon: React.ComponentType<any>;
  skipIndicator?: boolean;
};

/**
 * 创建统一的导航项配置
 * 桌面侧栏（ModernSidebar）与移动抽屉导航（MobileSidebarNavigation）共用同一份配置
 *
 * @param t - i18next翻译函数
 * @returns 导航项数组
 */
export const createNavItems = (t: TFunction, includeUILab = false): NavItem[] => {
  const items: NavItem[] = [
    // 🔧 Chat V2 放第一位
    {
      name: t('sidebar:navigation.chat_v2', '新会话'),
      view: 'chat-v2',
      icon: StudyChatIcon,
    },
    // 🔧 学习资源放第二位
    {
      name: t('sidebar:navigation.learning_hub', '学习资源'),
      view: 'learning-hub',
      icon: StudyBooksIcon,
    },
    // ★ 待办事项放在学习资源后面
    {
      name: t('sidebar:navigation.todo'),
      view: 'todo',
      icon: StudyTodoIcon,
    },
    // ★ 2026-01：用户记忆已集成到 Learning Hub 的 MemoryView
    {
      name: t('sidebar:navigation.skills_management', '技能管理'),
      view: 'skills-management',
      icon: StudyMagicWandIcon,
    },
    {
      name: t('sidebar:navigation.anki_generation', '制卡任务'),
      view: 'task-dashboard',
      icon: StudyStackIcon,
    },
    {
      name: t('sidebar:navigation.template_management', '模板管理'),
      view: 'template-management',
      icon: StudyBlocksIcon,
    },
    ...(includeUILab
      ? [
          {
            name: t('sidebar:navigation.ui_lab'),
            view: 'ui-lab' as NavViewType,
            icon: StudyBlocksIcon,
          },
        ]
      : []),
    {
      name: t('sidebar:navigation.settings', '设置'),
      view: 'settings',
      icon: StudySettingsIcon,
    },
  ];

  return items;
};

/**
 * 移动抽屉导航分组：
 * - study（学习）：会话 / 学习资源 / 待办 —— 高频学习入口
 * - manage（管理）：技能 / 制卡 / 模板 / (UI Lab) / 设置 —— 低频管理入口
 */
export type MobileNavSectionId = 'study' | 'manage';

export const MOBILE_NAV_SECTION_OF_VIEW: Record<NavViewType, MobileNavSectionId> = {
  'chat-v2': 'study',
  'learning-hub': 'study',
  'todo': 'study',
  'skills-management': 'manage',
  'task-dashboard': 'manage',
  'template-management': 'manage',
  'ui-lab': 'manage',
  'settings': 'manage',
};

/** 传给 createNavItems 的最小 t 桩：返回 defaultValue（或 key），仅用于计数等纯结构场景 */
const structuralT = ((key: string, defaultValue?: string) => defaultValue ?? key) as unknown as TFunction;

/**
 * 导航项总数（用于布局计算）。
 * 从 createNavItems 派生（默认不含 UI Lab），避免新增/删除导航项时忘记同步。
 * 需要含 UI Lab 的精确数量时请直接使用 createNavItems(t, includeUILab).length。
 */
export const NAV_ITEMS_COUNT = createNavItems(structuralT).length;

// ESTIMATED_NAV_ITEM_WIDTH / TOPBAR_FIXED_ELEMENTS_WIDTH 已随 Topbar.tsx 一并删除
// （2026-07）：仅旧版顶栏溢出检测使用，全仓已无消费者。
