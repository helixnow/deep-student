/**
 * APKG 导出共享常量（`apkg_exporter_service.rs`）。
 */
export const DEEP_STUDENT_TEMPLATE_ID_KEY = 'deepStudentTemplateId';
export const DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY = 'deepStudentCollapseClozeOrds';

/** 导出用固定 deck id：避开 Anki 保留的默认牌组 id 1。 */
export const APKG_EXPORT_DECK_ID = 1_746_000_000_000;
/** 多模板导出的 model id 基准（F21）。 */
export const APKG_MODEL_ID_BASE = 1_425_279_200_000;
/** 导出侧单媒体文件上限（256 MiB）。 */
export const MAX_EXPORT_MEDIA_FILE_BYTES = 256 * 1024 * 1024;
/** 本应用 FSRS 进度元数据键。 */
export const FSRS_EXPORT_METADATA_KEY = 'AnkiFsrs';

export const RESERVED_IMPORT_METADATA_FIELDS = [
  'AnkiNoteId',
  'AnkiCardId',
  'AnkiCardOrd',
  'AnkiCardScope',
  'AnkiDeckId',
  'AnkiModelId',
  'AnkiModelName',
  'AnkiSchedType',
  'AnkiQueue',
  'AnkiDue',
  'AnkiIvl',
  'AnkiFactor',
  'AnkiReps',
  'AnkiLapses',
  FSRS_EXPORT_METADATA_KEY,
] as const;

export const ALIAS_MAP: Readonly<Record<string, readonly string[]>> = {
  optiona: ['OptionA', 'optiona'],
  optionb: ['OptionB', 'optionb'],
  optionc: ['OptionC', 'optionc'],
  optiond: ['OptionD', 'optiond'],
  correct: ['Correct', 'correct'],
  explanation: ['Explanation', 'explanation'],
};

/** 与 `dstu-learning/src/fsrs_scheduler.rs:21` 一致。 */
export const DEFAULT_DAY_ROLLOVER_HOUR = 4;

export type TemplateConfigTuple = [name: string, fields: string[], front: string, back: string, css: string];
