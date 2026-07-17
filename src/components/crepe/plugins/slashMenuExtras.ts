/**
 * Crepe BlockEdit slash 菜单扩展：callout / toggle
 *
 * 通过 featureConfigs[BlockEdit].buildMenu 挂到 advanced 分组。
 */

import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx } from '@milkdown/kit/core';
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
} from '@milkdown/kit/preset/commonmark';
import i18next from 'i18next';

import { calloutSchema } from './callout';
import { createEmptyToggleNode } from './toggle';

/**
 * Slash 菜单项图标（SVG 字符串）。
 * 对齐 Crepe 内置项：24×24 槽位、fill/currentColor、无 stroke；
 * path 取自 Phosphor regular（viewBox 0 0 256 256），由 CSS 统一着色为 muted-foreground。
 */
/** ChatCenteredText — 高亮块 / callout */
export const CALLOUT_SLASH_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" fill="currentColor">
    <path d="M88,104a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H96A8,8,0,0,1,88,104Zm8,40h64a8,8,0,0,0,0-16H96a8,8,0,0,0,0,16ZM232,56V184a16,16,0,0,1-16,16H155.57l-13.68,23.94a16,16,0,0,1-27.78,0L100.43,200H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56Zm-16,0H40V184h65.07a8,8,0,0,1,7,4l16,28,16-28a8,8,0,0,1,7-4H216Z" />
  </svg>
`;

/** CaretDown — 折叠块 / toggle（披露箭头，与内置 filled path 风格一致） */
export const TOGGLE_SLASH_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" fill="currentColor">
    <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
  </svg>
`;

/** Crepe GroupBuilder 最小表面（避免依赖未导出的内部路径） */
export interface SlashGroupBuilder {
  getGroup: (key: string) => {
    addItem: (
      key: string,
      item: { label: string; icon: string; onRun?: (ctx: Ctx) => void },
    ) => unknown;
  };
  addGroup: (
    key: string,
    label: string,
  ) => {
    addItem: (
      key: string,
      item: { label: string; icon: string; onRun?: (ctx: Ctx) => void },
    ) => unknown;
  };
}

/** 插入空 note callout（含空 paragraph） */
export function insertEmptyCallout(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: calloutSchema.type(ctx),
    attrs: { type: 'note', title: '' },
  });
}

/** 插入展开态空 toggle */
export function insertEmptyToggle(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: createEmptyToggleNode(ctx),
  });
}

/**
 * 在 advanced 分组追加 callout / toggle 菜单项。
 * 供 CrepeFeature.BlockEdit.buildMenu 调用。
 */
export function appendCalloutToggleSlashItems(builder: SlashGroupBuilder): void {
  let advanced: ReturnType<SlashGroupBuilder['getGroup']>;
  try {
    advanced = builder.getGroup('advanced');
  } catch {
    advanced = builder.addGroup(
      'advanced',
      i18next.t('notes:slashMenu.advancedGroup.label', { defaultValue: '高级' }),
    );
  }

  advanced.addItem('callout', {
    label: i18next.t('notes:slashMenu.advancedGroup.callout', {
      defaultValue: '高亮块',
    }),
    icon: CALLOUT_SLASH_ICON,
    onRun: insertEmptyCallout,
  });

  advanced.addItem('toggle', {
    label: i18next.t('notes:toggle.slashLabel', {
      defaultValue: '折叠块',
    }),
    icon: TOGGLE_SLASH_ICON,
    onRun: insertEmptyToggle,
  });
}
