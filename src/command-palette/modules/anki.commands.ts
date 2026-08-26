/**
 * Anki 制卡命令
 *
 * 仅注册有真实实现的命令。历史上 8 条无监听的 anki.* 幽灵命令
 * （generate-smart/regenerate/sync/export/batch-mode/accept-all/reset/settings）
 * 已于 2026-07-20 连同文案一并删除，勿再加 TODO stub。
 */

import i18next from 'i18next';
import { UploadSimple } from '@phosphor-icons/react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { Command } from '../registry/types';

/** 后端 import_apkg_to_library 返回结构（字段与 Rust ApkgImportResult serde 输出一致） */
interface ApkgImportResult {
  documentId: string;
  importedCards: number;
  importedTemplates: number;
  mediaSkipped: number;
  mediaImported: number;
  warnings?: string[];
}

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

export const ankiCommands: Command[] = [
  {
    id: 'anki.import-apkg',
    get name() { return i18next.t('command_palette:commands.anki.import-apkg', 'Import Anki Deck (.apkg)'); },
    get description() { return i18next.t('command_palette:descriptions.anki.import-apkg', 'Choose a local .apkg file and import it into the card library'); },
    category: 'anki',
    icon: UploadSimple,
    get keywords() { return kw('anki.import-apkg'); },
    priority: 90,
    execute: async (deps) => {
      const selected = await dialogOpen({
        multiple: false,
        filters: [{ name: 'Anki Deck', extensions: ['apkg'] }],
        title: i18next.t('command_palette:commands.anki.import-apkg', 'Import Anki Deck (.apkg)'),
      });
      // 用户取消选择时静默返回
      if (!selected || Array.isArray(selected)) return;

      try {
        const result = await invoke<ApkgImportResult>('import_apkg_to_library', { path: selected });
        deps.showNotification(
          'success',
          i18next.t('command_palette:notifications.apkg_import_success', {
            cards: result.importedCards,
            defaultValue: 'Anki deck imported: {{cards}} cards',
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.showNotification(
          'error',
          i18next.t('command_palette:notifications.apkg_import_failed', {
            error: message,
            defaultValue: 'Failed to import Anki deck: {{error}}',
          }),
        );
      }
    },
  },
];
