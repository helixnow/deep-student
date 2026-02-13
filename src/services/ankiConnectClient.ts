import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import type { AnkiCard } from '../types';

export type MediaMode = 'skip' | 'inline_base64' | 'upload_media';

export interface AnkiConnectSettings {
  anki_connect_enabled: boolean;
  anki_connect_auto_import_enabled: boolean;
  anki_connect_default_deck: string; // legacy default deck
  anki_connect_default_model: string; // legacy default model
  anki_connect_delete_apkg_after_import: boolean;
  anki_connect_open_folder_on_failure: boolean;
  anki_connect_export_deck?: string; // preferred export deck name
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

export const ankiConnectClient = {
  async check(): Promise<boolean> {
    return await invoke<boolean>('check_anki_connect_status');
  },
  async listDecks(): Promise<string[]> {
    return await invoke<string[]>('get_anki_deck_names');
  },
  async listModels(): Promise<string[]> {
    return await invoke<string[]>('get_anki_model_names');
  },
  async createDeck(name: string): Promise<void> {
    await invoke('create_anki_deck', { deck_name: name, deckName: name });
  },
  async importPackage(apkgPath: string): Promise<boolean> {
    return await invoke<boolean>('import_anki_package', { path: apkgPath });
  },
  async addCards(params: { cards: AnkiCard[]; deckName: string; noteType: string }): Promise<(number | null)[]> {
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
    return await invoke<(number | null)[]>('add_cards_to_anki_connect', {
      selected_cards: cards,
      deck_name: deckName,
      note_type: noteType,
    });
  },
  async loadSettings(): Promise<AnkiConnectSettings> {
    const [enabled, autoImport, defDeck, defModel, delAfter, openOnFail, exportDeck, autoCreate, batchSize, retryTimes, tagPrefix, mediaMode] = await Promise.all([
      invoke('get_setting', { key: 'anki_connect_enabled' }).catch(() => 'false') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_auto_import_enabled' }).catch(() => 'true') as Promise<string>,
      invoke('get_setting', { key: 'anki_connect_default_deck' }).catch(() => 'Default') as Promise<string>,
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
      anki_connect_default_deck: getStr(defDeck, 'Default'),
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
