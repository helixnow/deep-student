import React, { useState } from 'react';
import * as tauriCore from '@tauri-apps/api/core';
import { QuestionSourceViewer } from '@/components/QuestionSourceViewer';
import { QuestionStructureManager } from '@/components/QuestionStructureManager';
import { QuestionImportAuditPanel } from '@/components/QuestionImportAuditPanel';
import type {
  Question,
  QuestionBankStructure,
  QuestionMaterial,
  QuestionStructureGroup,
} from '@/api/questionBankApi';
import type {
  LegacyMigrationAudit,
  ReparseReport,
} from '@/components/QuestionImportAuditPanel';

/**
 * Contract tests for qbank provenance / structure / audit surfaces.
 *
 * All native work goes through the shared CT Tauri mock. Each harness installs
 * a page-local, mutable fixture before its child mounts, so tests never touch
 * app source, a real database, an external network, or another test's state.
 */

type InvokeHandler = (
  command: string,
  payload?: Record<string, unknown>,
) => unknown | Promise<unknown>;

const ctInvoke = tauriCore as unknown as {
  setCtInvokeHandlers?: (handlers: Record<string, InvokeHandler>) => void;
};

function installHandlers(handlers: Record<string, InvokeHandler>) {
  if (!ctInvoke.setCtInvokeHandlers) {
    throw new Error('CT Tauri mock state API is unavailable');
  }
  ctInvoke.setCtInvokeHandlers(handlers);
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Locally generated 900x1200 PNG (solid page with a question block drawn at
 * bbox [0.08, 0.12, 0.62, 0.34]). Built offline with Node zlib; inlined here so
 * the browser receives a real raster data URL without any network access.
 */
export const SOURCE_PAGE_PNG_BASE64 = [
  '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',
  'VIwCACBGxSgAgBgVowAAiFExCgAgRsUoAABiVIwCAIhRMQoAIEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIA',
  'iFExCgCAGBWjAABiVIwCACBGxSgAgBgVowAAiFEAAMSoGAUAEKNiFAAAMSpGAQDEqBgFAECMilEAADEqRgEAEKNiFABAjIpRAADEqBgFABCjYhQAADEqRgEA',
  'xKgYBQBAjIpRAAAxKkYBABCjYhQAQIyKUQAAMSpGAQAQo2IUAECMilEAAMSoGAUAEKNiFAAAMSpGAQDEqBgFAECMilEAADEqRgEAEKNiFABAjIpRAADEqBgF',
  'ABCjYhQAADEqRgEAxKgYBQBAjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCAGBWjAABiVIwCACBGxSgAgBgVowAAiFExCgAgRsUoAABiVIwC',
  'AIhRMQoAgBgVowAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCAGBWjAABiVIwCACBGxSgAgBgVowAAiFEx',
  'CgAgRsUoAABiVIwCAIhRMQoAIEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCAGBWjAABiVIwCACBG',
  'xSgAgBgVowAAYlSMAgAgRsUoAIAYFaMAAIhRMQoAIEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCA',
  'GBWjAABiVIwCAIhRMQoAgBgVowAAYlSMAgAgRsUoAIAYFaMAAIhRMQoAIEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgA',
  'AGIUAAAxKkYBAMSoGAUAQIyKUQAAMSpGAQAQo2IUAECMilEAAMSoGAUAEKNiFAAAMSpGAQDEqBgFAECMilEAADEqRgEAEKNiFABAjIpRAADEqBgFABCjYhQA',
  'QIyKUQAAxKgYBQAQo2IUAAAxKkYBAMSoGAUAQIyKUQAAMSpGAQAQo2IUAECMilEAAMSoGAUAEKNiFAAAMSpGAQDEqBgFAECMilEAADEqRgEAEKMAAIhRMQoA',
  'IEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCAGBWjAABiVIwCACBGxSgAgBgVowAAYlSMAgAgRsUo',
  'AIAYFaMAAIhRMQoAIEbFKAAAYlSMAgCIUTEKAIAYFaMAAGJUjAIAIEbFKACAGBWjAACIUTEKACBGxSgAAGJUjAIAiFExCgCAGPX6AQDEqBgFABCjYhQAADEq',
  'RgEAxKgYBQBAjIpRAAAxKkYBABCjYhQAQIyKUQAAxKgYBQAQo2IUAAAxKkYBAMSoGAUAQIyKUQAAMSpGAQAQo2IUAECMilEAADEqRgEAEKNiFABAjIpRAADE',
  'qBgFABCjYhQAADEqRgEAxKgYBQBAjIpRAAAxKkYBABCjYhQAQIyKUQAAxKgYBQAQo2IUAAAxKkYBAMSoGAUAQIyKUQAAMSpGAQDEqBgFAECMilEAADEqRgEA',
  'EKNiFABAjIpRAADEqBgFABCjYhQAADEqRgEAxKgYBQBAjIpRAAAxKkYBABCjYhQAQIyKUQAAxKgYBQAQo2IUAAAxCgCAGBWjAABiVIwCACBGZ4zR4+liZsX5',
  'cAOIUTEqRs3EKABiVIyaiVEAxKgYFaNmYhQAMSpGzcQoAGJUjIpRMzEKgBgVo2ZiFAAxKkbFqJkYBUCMilEzMQqAGBWjYtRMjAIgRsWomRgFQIyKUTFqJkYB',
  'xKgYBQBAjIpRAAAxKkYBABCjYhQAQIyKUQAAxKgYBQAQo2IUAAAxKkYBAMSoGAUAQIyKUQAAMSpGAQAQo2IUAECMilEAAMRopzH6fv4wM9vBHFdAjIpRMzMx',
  'CohRMSpGzUyMAohRMWpmJkYBMSpGxaiZiVEAMSpGzczEKCBGxagYNTMxCohRMQoAgBgVowAAYlSMAgAgRsUoAIAYFaMAAIhRMQoAIEZ3EqNmZmZm1sPEqJmZ',
  'mZmJUTMzMzMzMWpmZmZmYtTMzMzMTIyamZmZmRg1MzMzMxOjZmZmZiZGzczMzMzEqJmZmZmJUTMzMzMzMWpmZmZmYtTMzMzMTIyamZmZmRg1MzMzMxOjZmZm',
  'ZiZGzczMzEyMmpmZmZmJUTMzMzMTo2ZmZmZmYtTMzMzMxKiZmZmZmRg1MzMzMzFqZmZmZiZGzczMzEyMmpmZmZmJUTMzMzMTo2ZmZmZmYtTMzMzMxKiZmZmZ',
  'mRg1MzMzMzFqZmZmZiZGzczMzEyMmpmZmZkYNTMzMzMTo2ZmZmYmRs3MzMzMxKiZmZmZiVEzMzMzMzFqZmZmZmLUzMzMzEyMmpmZmdmA+wFy1Epx6+VZwwAA',
  'AABJRU5ErkJggg==',
].join('');

const SOURCE_PAGE_WIDTH = 900;
const SOURCE_PAGE_HEIGHT = 1200;
const SOURCE_PAGE_BBOX: [number, number, number, number] = [0.08, 0.12, 0.62, 0.34];

function sourcePage(page: number) {
  return {
    source_id: `qsrc_fixture_${page}`,
    page,
    blob_hash: `blob_fixture_page_${page}`,
    width: SOURCE_PAGE_WIDTH,
    height: SOURCE_PAGE_HEIGHT,
    text: `第 ${page} 页文字层：用于验证原题来源页面与定位框的稳定渲染。`,
    source_name: 'fixture-midterm.pdf',
    source_format: 'pdf',
    original_path: '/fixtures/fixture-midterm.pdf',
    page_count: 3,
    available_pages: [1, 2, 3],
  };
}

function installSourceViewerFixture() {
  installHandlers({
    qbank_get_source_page: (_command, payload) =>
      sourcePage(Number(payload?.page ?? 2)),
    vfs_get_blob_base64: () => ({
      base64: SOURCE_PAGE_PNG_BASE64,
      mimeType: 'image/png',
      size: 8200,
    }),
  });
}

export function SourceViewerHarness() {
  useState(() => {
    installSourceViewerFixture();
    return true;
  });

  return (
    <div style={{ height: '100vh', width: '100%', overflow: 'hidden' }}>
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_fixture"
        sourceRefs={[
          { source_id: 'qsrc_fixture_2', page: 2, bbox: SOURCE_PAGE_BBOX },
        ]}
        answerSourceRefs={[
          { source_id: 'qsrc_fixture_3', page: 3, bbox: [0.10, 0.55, 0.70, 0.75] },
        ]}
      />
    </div>
  );
}

function question(
  id: string,
  label: string,
  content: string,
  groupId: string | null,
  groupPosition: number | null,
): Question {
  return {
    id,
    questionLabel: label,
    content,
    questionType: 'short_answer',
    options: [],
    answer: '参考答案',
    explanation: '',
    difficulty: 'easy',
    tags: ['fixture'],
    status: 'new',
    attemptCount: 0,
    correctCount: 0,
    isFavorite: false,
    images: [],
    groupId,
    groupPosition,
    groupLabel: null,
    materials: [],
  };
}

interface StructureFixture {
  structure: QuestionBankStructure;
  questions: Question[];
}

function makeStructureFixture(): StructureFixture {
  const materials: QuestionMaterial[] = [
    { id: 'm1', content: '共享阅读材料一：关于城市夜间照明的说明文。', images: [], version: 2 },
    { id: 'm2', content: '共享阅读材料二：完形填空使用的短篇故事。', images: [], version: 1 },
    { id: 'm3', content: '未使用的附录材料三：尚未被任何题组引用。', images: [], version: 5 },
    { id: 'm4', content: '未使用的补充材料四：等待整理的历史素材。', images: [], version: 3 },
  ];

  const groups: QuestionStructureGroup[] = [
    {
      id: 'g1',
      exam_id: 'exam_fixture',
      label: '阅读理解一',
      position: 0,
      version: 3,
      material_ids: ['m1'],
      question_ids: ['q1', 'q2', 'q3'],
    },
    {
      id: 'g2',
      exam_id: 'exam_fixture',
      label: '完形填空',
      position: 1,
      version: 1,
      material_ids: ['m2'],
      question_ids: ['q4', 'q5'],
    },
    {
      id: 'g3',
      exam_id: 'exam_fixture',
      label: '语法填空',
      position: 2,
      version: 2,
      material_ids: ['m1', 'm2'],
      question_ids: ['q6'],
    },
  ];

  const questions: Question[] = [
    question('q1', '1', '阅读材料第一题：概括说明文的主要观点。', 'g1', 0),
    question('q2', '2', '阅读材料第二题：解释第三段的论证作用。', 'g1', 1),
    question('q3', '3', '阅读材料第三题：判断作者对夜间照明的态度。', 'g1', 2),
    question('q4', '4', '完形填空第一题：选择最符合语境的动词。', 'g2', 0),
    question('q5', '5', '完形填空第二题：选择最符合语境的连词。', 'g2', 1),
    question('q6', '6', '语法填空第一题：填写正确的时态形式。', 'g3', 0),
    question('q7', '7', '尚未分组的候选题：可用于验证添加子题流程。', null, null),
  ];

  return {
    structure: { exam_id: 'exam_fixture', materials, groups },
    questions,
  };
}

function installStructureFixture(fixture: StructureFixture) {
  const { structure, questions } = fixture;

  installHandlers({
    qbank_list_structure: () => clone(structure),
    qbank_update_group: (_command, payload) => {
      const groupId = String(payload?.groupId ?? '');
      const group = structure.groups.find((candidate) => candidate.id === groupId);
      if (!group) throw new Error('题组不存在');
      const expectedVersion = Number(payload?.expectedVersion);
      if (group.version !== expectedVersion) {
        throw new Error('题组版本已变化，请重新载入');
      }
      group.label = String(payload?.label ?? group.label ?? '');
      group.question_ids = [...((payload?.questionIds as string[] | undefined) ?? group.question_ids)];
      group.material_ids = [...((payload?.materialIds as string[] | undefined) ?? group.material_ids)];
      group.version += 1;
      const updated = clone(group);
      return {
        exam_id: structure.exam_id,
        group: updated,
        removed_question_ids: [],
        solo_group_ids: [],
      };
    },
    qbank_delete_group: (_command, payload) => {
      const groupId = String(payload?.groupId ?? '');
      const group = structure.groups.find((candidate) => candidate.id === groupId);
      structure.groups = structure.groups.filter((candidate) => candidate.id !== groupId);
      if (String(payload?.mode) === 'delete_members' && group) {
        const removed = new Set(group.question_ids);
        fixture.questions = questions.filter((candidate) => !removed.has(candidate.id));
      }
      return undefined;
    },
    qbank_delete_material: (_command, payload) => {
      const materialId = String(payload?.materialId ?? '');
      structure.materials = structure.materials.filter((candidate) => candidate.id !== materialId);
      return undefined;
    },
  });
}

export function StructureManagerHarness({ editable = true }: { editable?: boolean }) {
  const [fixture] = useState(() => {
    const next = makeStructureFixture();
    installStructureFixture(next);
    return next;
  });

  return (
    <div style={{ height: '100vh', width: '100%', overflow: 'hidden' }}>
      <QuestionStructureManager
        open
        onOpenChange={() => {}}
        examId="exam_fixture"
        questions={fixture.questions}
        editable={editable}
      />
    </div>
  );
}

const AUDIT_FIXTURE: LegacyMigrationAudit = {
  exam_id: 'exam_fixture',
  canonical_marker: false,
  canonical_question_count: 6,
  source_version: 'src_v1',
  audit_version: 'audit_v7',
  pages: [
    {
      page_index: 1,
      blob_hash: 'blob_legacy_p1',
      original_image_path: '/fixtures/legacy-page-01.png',
      width: 900,
      height: 1200,
      card_count: 2,
    },
    {
      page_index: 2,
      blob_hash: 'blob_legacy_p2',
      original_image_path: '/fixtures/legacy-page-02.png',
      width: 900,
      height: 1200,
      card_count: 2,
    },
  ],
  cards: [
    {
      card_id: 'card_match_1',
      page_index: 1,
      card_index: 0,
      question_label: '1',
      preview_text: '已映射的预览卡片：阅读材料第一题。',
      status: 'matched',
      formal_question_id: 'q1',
      candidate_question_ids: ['q1'],
      deleted_question_ids: [],
      migratable: false,
      reason: null,
    },
    {
      card_id: 'card_new_1',
      page_index: 1,
      card_index: 1,
      question_label: '2',
      preview_text: '待迁移的预览卡片：阅读材料第二题。',
      status: 'unmatched',
      formal_question_id: null,
      candidate_question_ids: [],
      deleted_question_ids: [],
      migratable: true,
      reason: null,
    },
    {
      card_id: 'card_new_2',
      page_index: 2,
      card_index: 0,
      question_label: '3',
      preview_text: '待迁移的预览卡片：阅读材料第三题。',
      status: 'unmatched',
      formal_question_id: null,
      candidate_question_ids: [],
      deleted_question_ids: [],
      migratable: true,
      reason: null,
    },
    {
      card_id: 'card_ambiguous_1',
      page_index: 2,
      card_index: 1,
      question_label: '4',
      preview_text: '存在歧义的预览卡片：需要人工确认身份映射。',
      status: 'ambiguous',
      formal_question_id: null,
      candidate_question_ids: ['q4', 'q5'],
      deleted_question_ids: [],
      migratable: false,
      reason: '多个候选题目具有相同来源槽',
    },
  ],
  migratable_card_ids: ['card_new_1', 'card_new_2'],
  matched_count: 1,
  unmatched_count: 2,
  ambiguous_count: 1,
  deleted_count: 0,
  invalid_count: 0,
  suppressed_count: 0,
};

const REPARSE_FIXTURE: ReparseReport = {
  exam_id: 'exam_fixture',
  job_id: 'job_fixture',
  job_version: 4,
  report_version: 'report_v3',
  canonical_marker: false,
  canonical_question_count: 6,
  items: [
    {
      local_id: 'draft_1',
      source_key: 'page-1-card-1',
      status: 'changed',
      canonical_question_id: 'q2',
      canonical_revision: 'rev_q2',
      candidate_question_ids: ['q2'],
      changes: [{ field: 'content', before: '旧题干', after: '新题干' }],
      allowed_actions: ['keep_existing', 'replace_existing'],
      reason: null,
    },
    {
      local_id: 'draft_2',
      source_key: 'page-2-card-1',
      status: 'new',
      canonical_question_id: null,
      canonical_revision: null,
      candidate_question_ids: [],
      changes: [],
      allowed_actions: ['keep_existing', 'import_as_new'],
      reason: null,
    },
  ],
  canonical_only: [],
  changed_count: 1,
  new_count: 1,
  deleted_count: 0,
  ambiguous_count: 0,
  resolved: false,
  resolution: null,
};

function installAuditFixture() {
  installHandlers({
    qbank_legacy_audit: () => clone(AUDIT_FIXTURE),
    qbank_reparse_report: () => clone(REPARSE_FIXTURE),
    qbank_legacy_migrate_selected: () => ({
      exam_id: 'exam_fixture',
      committed: true,
      idempotent: false,
      job_id: 'job_fixture',
      migrated_card_ids: ['card_new_1', 'card_new_2'],
      question_ids: ['q7', 'q8'],
      imported_count: 2,
      audit_version_before: 'audit_v7',
      audit_version_after: 'audit_v8',
    }),
    qbank_reparse_resolve: () => ({
      exam_id: 'exam_fixture',
      job_id: 'job_fixture',
      applied: [],
      imported_question_ids: [],
      replaced_question_ids: [],
      kept_local_ids: ['draft_1', 'draft_2'],
    }),
  });
}

export function AuditPanelHarness() {
  useState(() => {
    installAuditFixture();
    return true;
  });

  return (
    <div style={{ minHeight: '100vh', width: '100%', padding: '24px', background: 'var(--background)' }}>
      <QuestionImportAuditPanel examId="exam_fixture" />
    </div>
  );
}
