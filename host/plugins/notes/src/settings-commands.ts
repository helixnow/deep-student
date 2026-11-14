// cmd/notes.rs preference and subject RAG configuration commands.
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { getSubjectRagConfig, setSubjectRagConfig } from '../repository/rag-config.ts';
import { NoteDocumentError } from '../repository/errors.ts';
import { errorMessage } from './command-utils.ts';

export function getSubjectConfig(
  settings: SettingsService,
  mistakes: SqlExecutor,
  subject: string,
): Commands['notes_get_subject_rag_config']['result'] {
  try {
    return getSubjectRagConfig(settings, mistakes, subject);
  } catch (error) {
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}

export function updateSubjectConfig(
  settings: SettingsService,
  mistakes: SqlExecutor,
  subject: string,
  cfg: Commands['notes_update_subject_rag_config']['args']['cfg'],
): Commands['notes_update_subject_rag_config']['result'] {
  try {
    return setSubjectRagConfig(settings, mistakes, subject, {
      chunk_size: cfg.chunk_size,
      chunk_overlap: cfg.chunk_overlap,
      min_chunk_size: cfg.min_chunk_size,
      rerank_enabled: cfg.rerank_enabled,
    });
  } catch (error) {
    if (error instanceof NoteDocumentError) {
      throw new CommandError(AppError.validation(error.message));
    }
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}

export function setPref(settings: SettingsService, key: string, value: string): boolean {
  try {
    settings.save(`notes.pref.${key}`, value);
    return true;
  } catch (error) {
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}

export function getPref(settings: SettingsService, key: string): string | null {
  try {
    return settings.get(`notes.pref.${key}`);
  } catch (error) {
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}
