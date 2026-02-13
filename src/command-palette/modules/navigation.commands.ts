/**
 * 导航命令 - SOTA 版本
 * 覆盖所有应用视图的完整导航命令
 *
 * 清理说明（2026-02）：
 * - 移除废弃视图命令：notes、review
 * - 所有命令仅导航到当前仍受支持的视图
 */

import i18next from 'i18next';
import {
  SquareStack,
  Settings,
  ChevronLeft,
  ChevronRight,
  Palette,
  MessageSquare,
  GraduationCap,
  FileText,
  BarChart3,
  Database,
  Home,
  Zap,
} from 'lucide-react';
import type { Command } from '../registry/types';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * 主要视图导航命令工厂函数
 * 使用 i18next.t() 进行运行时国际化
 * 按优先级排序，常用视图在前
 */
export function getNavigationCommands(): Command[] {
  return [
    // ==================== 核心视图 ====================
    {
      id: 'nav.goto.chat-v2',
      name: i18next.t('command_palette:commands.nav.goto.chat-v2', 'Go to Smart Chat'),
      description: i18next.t('command_palette:descriptions.nav.goto.chat-v2', 'Chat V2 - AI chat main entry'),
      category: 'navigation',
      shortcut: 'mod+1',
      icon: MessageSquare,
      keywords: kw('nav.goto.chat-v2'),
      priority: 100,
      execute: (deps) => {
        deps.navigate('chat-v2');
      },
    },
    {
      id: 'nav.goto.skills-management',
      name: i18next.t('command_palette:commands.nav.goto.skills-management', 'Go to Skills Management'),
      description: i18next.t('command_palette:descriptions.nav.goto.skills-management', 'MCP skills and tools management'),
      category: 'navigation',
      icon: Zap,
      keywords: kw('nav.goto.skills-management'),
      priority: 95,
      execute: (deps) => {
        deps.navigate('skills-management');
      },
    },
    {
      id: 'nav.goto.task-dashboard',
      name: i18next.t('command_palette:commands.nav.goto.task-dashboard', 'Go to Card Tasks'),
      description: i18next.t('command_palette:descriptions.nav.goto.task-dashboard', 'Manage card generation tasks'),
      category: 'navigation',
      shortcut: 'mod+shift+6',
      icon: SquareStack,
      keywords: kw('nav.goto.task-dashboard'),
      priority: 94,
      execute: (deps) => {
        deps.navigate('task-dashboard');
      },
    },

    // ==================== 学习相关视图 ====================
    {
      id: 'nav.goto.learning-hub',
      name: i18next.t('command_palette:commands.nav.goto.learning-hub', 'Go to Learning Hub'),
      description: i18next.t('command_palette:descriptions.nav.goto.learning-hub', 'Integrated learning resource center'),
      category: 'navigation',
      shortcut: 'mod+shift+7',
      icon: GraduationCap,
      keywords: kw('nav.goto.learning-hub'),
      priority: 93,
      execute: (deps) => {
        deps.navigate('learning-hub');
      },
    },
    // ==================== 工具视图 ====================
    {
      id: 'nav.goto.template-management',
      name: i18next.t('command_palette:commands.nav.goto.template-management', 'Go to Template Library'),
      description: i18next.t('command_palette:descriptions.nav.goto.template-management', 'Manage AI prompt templates'),
      category: 'navigation',
      icon: Palette,
      keywords: kw('nav.goto.template-management'),
      priority: 88,
      execute: (deps) => {
        deps.navigate('template-management');
      },
    },
    {
      id: 'nav.goto.pdf-reader',
      name: i18next.t('command_palette:commands.nav.goto.pdf-reader', 'Go to PDF Reader'),
      description: i18next.t('command_palette:descriptions.nav.goto.pdf-reader', 'Read and annotate PDF documents'),
      category: 'navigation',
      icon: FileText,
      keywords: kw('nav.goto.pdf-reader'),
      priority: 87,
      execute: (deps) => {
        deps.navigate('pdf-reader');
      },
    },

    // ==================== 管理视图 ====================
    {
      id: 'nav.goto.dashboard',
      name: i18next.t('command_palette:commands.nav.goto.dashboard', 'Go to Dashboard'),
      description: i18next.t('command_palette:descriptions.nav.goto.dashboard', 'Data statistics and overview'),
      category: 'navigation',
      shortcut: 'mod+5',
      icon: BarChart3,
      keywords: kw('nav.goto.dashboard'),
      priority: 85,
      execute: (deps) => {
        deps.navigate('dashboard');
      },
    },
    {
      id: 'nav.goto.data-management',
      name: i18next.t('command_palette:commands.nav.goto.data-management', 'Go to Data Management'),
      description: i18next.t('command_palette:descriptions.nav.goto.data-management', 'Data import/export and backup'),
      category: 'navigation',
      shortcut: 'mod+e',
      icon: Database,
      keywords: kw('nav.goto.data-management'),
      priority: 84,
      execute: (deps) => {
        deps.navigate('data-management');
      },
    },
    {
      id: 'nav.goto.settings',
      name: i18next.t('command_palette:commands.nav.goto.settings', 'Go to Settings'),
      description: i18next.t('command_palette:descriptions.nav.goto.settings', 'App settings and preferences'),
      category: 'navigation',
      shortcut: 'mod+,',
      icon: Settings,
      keywords: kw('nav.goto.settings'),
      priority: 80,
      execute: (deps) => {
        deps.navigate('settings');
      },
    },

    // ==================== 导航历史命令 ====================
    {
      id: 'nav.back',
      name: i18next.t('command_palette:commands.nav.back', 'Go Back'),
      description: i18next.t('command_palette:descriptions.nav.back', 'Go back to previous page'),
      category: 'navigation',
      shortcut: 'mod+[',
      icon: ChevronLeft,
      keywords: kw('nav.back'),
      priority: 70,
      execute: () => {
        window.dispatchEvent(new CustomEvent('COMMAND_PALETTE_NAV_BACK'));
      },
    },
    {
      id: 'nav.forward',
      name: i18next.t('command_palette:commands.nav.forward', 'Go Forward'),
      description: i18next.t('command_palette:descriptions.nav.forward', 'Go forward to next page'),
      category: 'navigation',
      shortcut: 'mod+]',
      icon: ChevronRight,
      keywords: kw('nav.forward'),
      priority: 69,
      execute: () => {
        window.dispatchEvent(new CustomEvent('COMMAND_PALETTE_NAV_FORWARD'));
      },
    },
    {
      id: 'nav.home',
      name: i18next.t('command_palette:commands.nav.home', 'Go to Home'),
      description: i18next.t('command_palette:descriptions.nav.home', 'Return to app home page'),
      category: 'navigation',
      shortcut: 'mod+shift+h',
      icon: Home,
      keywords: kw('nav.home'),
      priority: 68,
      execute: (deps) => {
        deps.navigate('chat-v2');
      },
    },
  ];
}
