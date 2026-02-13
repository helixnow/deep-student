/**
 * 内置命令注册 - SOTA 版本
 * 覆盖所有功能模块的完整命令集
 */

import { commandRegistry } from './commandRegistry';
import { getNavigationCommands } from '../modules/navigation.commands';
import { getGlobalCommands } from '../modules/global.commands';
import { settingsCommands } from '../modules/settings.commands';
import { notesCommands } from '../modules/notes.commands';

import { devCommands } from '../modules/dev.commands';
import { getChatCommands } from '../modules/chat.commands';
import { learningCommands } from '../modules/learning.commands';

/**
 * 注册所有内置命令
 * @returns 注销函数
 *
 * 命令模块列表在函数内构建，确保使用工厂函数的模块
 * （navigation、chat、global）在注册时才调用 i18next.t()，
 * 实现运行时国际化。
 */
export function registerBuiltinCommands(): () => void {
  const unregisters: Array<() => void> = [];
  const commandCounts: Record<string, number> = {};

  // 构建命令模块列表（工厂函数在此时执行，确保 i18next 已初始化）
  const ALL_COMMAND_MODULES = [
    { name: 'navigation', commands: getNavigationCommands() },
    { name: 'chat', commands: getChatCommands() },
    { name: 'global', commands: getGlobalCommands() },
    { name: 'settings', commands: settingsCommands },
    { name: 'notes', commands: notesCommands },
    { name: 'learning', commands: learningCommands },
    // 开发命令仅在非生产模式下注册，避免用户看到不可用的"幽灵命令"
    ...(import.meta.env.DEV ? [{ name: 'dev', commands: devCommands }] : []),
  ];

  // 按模块注册所有命令
  for (const module of ALL_COMMAND_MODULES) {
    unregisters.push(commandRegistry.registerAll(module.commands));
    commandCounts[module.name] = module.commands.length;
  }

  // 计算总命令数
  const totalCommands = Object.values(commandCounts).reduce((sum, count) => sum + count, 0);

  // 仅在开发模式输出注册摘要
  if (import.meta.env.DEV) {
    console.log(`[CommandPalette] 内置命令注册完成: ${totalCommands} 个, 分布: ${Object.entries(commandCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);
  }

  // 返回批量注销函数
  return () => {
    unregisters.forEach((fn) => fn());
  };
}

/**
 * 获取命令统计信息
 */
export function getCommandStats(): { total: number; byModule: Record<string, number> } {
  const modules = [
    { name: 'navigation', commands: getNavigationCommands() },
    { name: 'chat', commands: getChatCommands() },
    { name: 'global', commands: getGlobalCommands() },
    { name: 'settings', commands: settingsCommands },
    { name: 'notes', commands: notesCommands },
    { name: 'learning', commands: learningCommands },
    ...(import.meta.env.DEV ? [{ name: 'dev', commands: devCommands }] : []),
  ];
  const byModule: Record<string, number> = {};
  for (const module of modules) {
    byModule[module.name] = module.commands.length;
  }
  return {
    total: Object.values(byModule).reduce((sum, count) => sum + count, 0),
    byModule,
  };
}
