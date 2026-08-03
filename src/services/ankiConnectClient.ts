import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import type { AnkiCard } from '../types';

export type MediaMode = 'skip' | 'inline_base64' | 'upload_media';

/** add_cards_to_anki_connect 返回的同步明细报告（后端 serde camelCase） */
export interface AnkiSyncReport {
  noteIds: Array<number | null>;
  added: number;
  duplicates: number;
  failed: number;
  createdModels: string[];
}

export interface AnkiConnectSettings {
  anki_connect_enabled: boolean;
  anki_connect_auto_import_enabled: boolean;
  anki_connect_default_deck: string; // 后端 chatanki 导出实际消费的 key
  anki_connect_default_model: string; // 后端 chatanki 导出实际消费的 key
  anki_connect_delete_apkg_after_import: boolean;
  anki_connect_open_folder_on_failure: boolean;
  anki_connect_export_deck?: string; // legacy key，仅用于向 anki_connect_default_deck 的一次性迁移读取
  // optional for instant import
  anki_connect_auto_create_deck?: boolean;
  anki_connect_batch_size?: number;
  anki_connect_retry_times?: number;
  anki_connect_tag_prefix?: string;
  anki_connect_media_mode?: MediaMode;
}

const strToBool = (v: unknown, def = false) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true';
  return def;
};

const getStr = (v: unknown, def: string) => typeof v === 'string' && v.trim() ? v : def;

/** 所有真实 AnkiConnect 请求前置检查：开关关闭时直接拒绝 */
async function ensureEnabled(): Promise<void> {
  const enabled = await invoke('get_setting', { key: 'anki_connect_enabled' }).catch(() => 'false');
  if (!strToBool(enabled, false)) {
    throw new Error(i18next.t('anki:connect.disabled'));
  }
}

export const ankiConnectClient = {
  async check(): Promise<boolean> {
    await ensureEnabled();
    return await invoke<boolean>('check_anki_connect_status');
  },
  async listDecks(): Promise<string[]> {
    await ensureEnabled();
    return await invoke<string[]>('get_anki_deck_names');
  },
  async listModels(): Promise<string[]> {
    await ensureEnabled();
    return await invoke<string[]>('get_anki_model_names');
  },
  async createDeck(name: string): Promise<void> {
    await ensureEnabled();
    await invoke('create_anki_deck', { deckName: name });
  },
  async importPackage(apkgPath: string, options?: { deleteAfter?: boolean }): Promise<boolean> {
    await ensureEnabled();
    return await invoke<boolean>('import_anki_package', {
      path: apkgPath,
      deleteAfter: options?.deleteAfter ?? false,
    });
  },
  async addCards(params: { cards: AnkiCard[]; deckName: string; noteType: string }): Promise<AnkiSyncReport> {
    await ensureEnabled();
    const { cards, deckName, noteType } = params;
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new Error(i18next.t('anki:connect.no_cards_provided'));
    }
    if (!deckName?.trim()) {
      throw new Error(i18next.t('anki:connect.deck_name_required'));
    }
    if (!noteType?.trim()) {
      throw new Error(i18next.t('anki:connect.note_type_required'));
    }
    // Tauri v2 默认期望 camelCase JS 参数，自动映射到 snake_case Rust 参数
    return await invoke<AnkiSyncReport>('add_cards_to_anki_connect', {
      selectedCards: cards,
      deckName,
      noteType,
    });
  },
  async loadSettings(): Promise<AnkiConnectSettings> {
    const [enabled, autoImport, defDeck, defModel, delAfter, openOnFail, exportDeck, autoCreate, batchSize, retryTimes, tagPrefix, mediaMode] = await Promise.all([
      invoke('get_setting', { key: 'anki_connect_enabled' }).catch(() => 'false') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_auto_import_enabled' }).catch(() => 'true') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_default_deck' }).catch(() => '') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_default_model' }).catch(() => 'Basic') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_delete_apkg_after_import' }).catch(() => 'true') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_open_folder_on_failure' }).catch(() => 'true') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_export_deck' }).catch(() => '') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_auto_create_deck' }).catch(() => 'true') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_batch_size' }).catch(() => '50') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_retry_times' }).catch(() => '1') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_tag_prefix' }).catch(() => '') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_media_mode' }).catch(() => 'upload_media') as Promise<string>,
    ]);
    return {
      anki_connect_enabled: strToBool(enabled, false),
      anki_connect_auto_import_enabled: strToBool(autoImport, true),
      // 迁移：新 key 为空时回退读旧 key anki_connect_export_deck（一次性显示，保存即写新 key）
      anki_connect_default_deck: getStr(defDeck, '') || getStr(exportDeck, '') || 'Default',
      anki_connect_default_model: getStr(defModel, 'Basic'),
      anki_connect_delete_apkg_after_import: strToBool(delAfter, true),
      anki_connect_open_folder_on_failure: strToBool(openOnFail, true),
      anki_connect_export_deck: getStr(exportDeck, '') || undefined,
      anki_connect_auto_create_deck: strToBool(autoCreate, true),
      anki_connect_batch_size: parseInt(String(batchSize || '50'), 10) || 50,
      anki_connect_retry_times: parseInt(String(retryTimes || '1'), 10) || 1,
      anki_connect_tag_prefix: getStr(tagPrefix, ''),
      anki_connect_media_mode: (getStr(mediaMode, 'upload_media') as MediaMode),
    };
  },
  async saveSettings(s: Partial<AnkiConnectSettings>): Promise<void> {
    const pairs: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => pairs.push([k, String(v)]);
    if (s.anki_connect_enabled != null) push('anki_connect_enabled', s.anki_connect_enabled);
    if (s.anki_connect_auto_import_enabled != null) push('anki_connect_auto_import_enabled', s.anki_connect_auto_import_enabled);
    if (s.anki_connect_default_deck != null) push('anki_connect_default_deck', s.anki_connect_default_deck);
    if (s.anki_connect_default_model != null) push('anki_connect_default_model', s.anki_connect_default_model);
    if (s.anki_connect_delete_apkg_after_import != null) push('anki_connect_delete_apkg_after_import', s.anki_connect_delete_apkg_after_import);
    if (s.anki_connect_open_folder_on_failure != null) push('anki_connect_open_folder_on_failure', s.anki_connect_open_folder_on_failure);
    if (s.anki_connect_export_deck != null) push('anki_connect_export_deck', s.anki_connect_export_deck);
    if (s.anki_connect_auto_create_deck != null) push('anki_connect_auto_create_deck', s.anki_connect_auto_create_deck);
    if (s.anki_connect_batch_size != null) push('anki_connect_batch_size', s.anki_connect_batch_size);
    if (s.anki_connect_retry_times != null) push('anki_connect_retry_times', s.anki_connect_retry_times);
    if (s.anki_connect_tag_prefix != null) push('anki_connect_tag_prefix', s.anki_connect_tag_prefix);
    if (s.anki_connect_media_mode != null) push('anki_connect_media_mode', s.anki_connect_media_mode);
    await Promise.all(pairs.map(([key, value]) => invoke('save_setting', { key, value })));
  }
};
