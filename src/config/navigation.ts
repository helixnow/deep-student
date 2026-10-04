import { TFunction } from 'i18next';
import type { CurrentView } from '@/types/navigation';
import {
  StudyBlocksIcon,
  StudyBooksIcon,
  StudyCardsIcon,
  StudyChatIcon,
  StudyMagicWandIcon,
  StudySettingsIcon,
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
  | 'todo'
  | 'flashcards';

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
      name: t('sidebar:navigation.learning_hub', '资源库'),
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
    // ★ 闪卡中心（2026-10）：复习 / 制卡任务 / 模板 三合一，只占一个入口。
    // 分区仍是独立视图（flashcards / task-dashboard / template-management），
    // 由 app/navigation/cardsHub.ts 统一高亮与落点，页内分区切换见 CardsHubTabs。
    {
      name: t('sidebar:navigation.flashcards', '闪卡'),
      view: 'flashcards',
      icon: StudyCardsIcon,
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
 * 移动端所有侧栏在 head 之下的二行三列应用入口。
 * 不含设置（抽屉顶栏齿轮）、命令面板；制卡任务与模板并入「闪卡」入口
 * （闪卡中心页内分区切换，见 app/navigation/cardsHub.ts）。
 */
export const MOBILE_APP_LAUNCHER_VIEWS = [
  'chat-v2',
  'learning-hub',
  'todo',
  'skills-management',
  'flashcards',
  'data-management',
] as const satisfies readonly CurrentView[];

export type MobileAppLauncherView = (typeof MOBILE_APP_LAUNCHER_VIEWS)[number];

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
