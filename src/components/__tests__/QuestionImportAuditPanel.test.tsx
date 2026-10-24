import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

import {
  QuestionImportAuditPanel,
  type LegacyMigrationAudit,
  type ReparseReport,
  type ReparseResolveReceipt,
} from '../QuestionImportAuditPanel';

const page = {
  page_index: 0,
  blob_hash: 'page-blob-1',
  original_image_path: '/tmp/original-page-1.png',
  width: 1000,
  height: 1400,
  card_count: 3,
};

const auditReport = (overrides: Partial<LegacyMigrationAudit> = {}): LegacyMigrationAudit => ({
  exam_id: 'exam_1',
  canonical_marker: false,
  canonical_question_count: 2,
  source_version: 'source-1',
  audit_version: 'audit-1',
  pages: [page],
  cards: [
    {
      card_id: 'c1',
      page_index: 0,
      card_index: 0,
      question_label: '1',
      preview_text: 'legacy question one',
      status: 'unmatched',
      formal_question_id: null,
      candidate_question_ids: [],
      deleted_question_ids: [],
      migratable: true,
      reason: null,
    },
    {
      card_id: 'c2',
      page_index: 0,
      card_index: 1,
      question_label: '2',
      preview_text: 'already formal',
      status: 'matched',
      formal_question_id: 'q2',
      candidate_question_ids: ['q2'],
      deleted_question_ids: [],
      migratable: false,
      reason: null,
    },
    {
      card_id: 'c3',
      page_index: 0,
      card_index: 2,
      question_label: '3',
      preview_text: 'was deleted',
      status: 'deleted',
      formal_question_id: null,
      candidate_question_ids: [],
      deleted_question_ids: ['q3'],
      migratable: false,
      reason: '对应正式题目已删除',
    },
  ],
  migratable_card_ids: ['c1'],
  matched_count: 1,
  unmatched_count: 1,
  ambiguous_count: 0,
  deleted_count: 1,
  invalid_count: 0,
  suppressed_count: 0,
  ...overrides,
});

const reparseReport = (overrides: Partial<ReparseReport> = {}): ReparseReport => ({
  exam_id: 'exam_1',
  job_id: 'job_1',
  job_version: 3,
  report_version: 'report-1',
  canonical_marker: true,
  canonical_question_count: 2,
  items: [
    {
      local_id: 'q1',
      source_key: 'slot-1',
      status: 'changed',
      canonical_question_id: 'question-1',
      canonical_revision: 'rev-1',
      candidate_question_ids: ['question-1'],
      changes: [{ field: 'content', before: 'old', after: 'new' }],
      allowed_actions: ['keep_existing', 'import_as_new', 'replace_existing'],
      reason: null,
    },
    {
      local_id: 'q2',
      source_key: 'slot-2',
      status: 'deleted',
      canonical_question_id: null,
      canonical_revision: null,
      candidate_question_ids: ['question-2'],
      changes: [],
      allowed_actions: ['keep_existing'],
      reason: '已删除，不重建',
    },
  ],
  canonical_only: [],
  changed_count: 1,
  new_count: 0,
  deleted_count: 1,
  ambiguous_count: 0,
  ...overrides,
});

const okMigrateReceipt = {
  exam_id: 'exam_1',
  committed: true,
  idempotent: false,
  job_id: 'job-legacy',
  migrated_card_ids: ['c1'],
  question_ids: ['new-q1'],
  imported_count: 1,
  audit_version_before: 'audit-1',
  audit_version_after: 'audit-2',
};

const okResolveReceipt: ReparseResolveReceipt = {
  exam_id: 'exam_1',
  job_id: 'job_1',
  applied: [
    { local_id: 'q1', action: 'replace_existing', question_id: 'question-1' },
    { local_id: 'q2', action: 'keep_existing', question_id: null },
  ],
  imported_question_ids: [],
  replaced_question_ids: ['question-1'],
  kept_local_ids: ['q2'],
};

describe('QuestionImportAuditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists legacy mappings and migrates only the explicitly selected card with the audit version', async () => {
    let auditCalls = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_legacy_audit') {
        auditCalls += 1;
        return auditCalls === 1
          ? auditReport()
          : auditReport({
              cards: auditReport().cards.map((card) =>
                card.card_id === 'c1'
                  ? {
                      ...card,
                      status: 'matched' as const,
                      formal_question_id: 'new-q1',
                      migratable: false,
                    }
                  : card,
              ),
              migratable_card_ids: [],
              unmatched_count: 0,
              matched_count: 2,
            });
      }
      if (command === 'qbank_reparse_report') return reparseReport();
      if (command === 'qbank_legacy_migrate_selected') return okMigrateReceipt;
      return null;
    });
    const onChanged = vi.fn();

    render(<QuestionImportAuditPanel examId="exam_1" onChanged={onChanged} />);
    expect(await screen.findByTestId('legacy-card-c1')).toBeInTheDocument();
    expect(screen.getByTestId('legacy-status-c1')).toHaveTextContent('unmatched');
    expect(screen.getByTestId('audit-page-assets')).toHaveTextContent('/tmp/original-page-1.png');
    expect(
      (screen.getByTestId('legacy-card-checkbox-c2') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('legacy-card-checkbox-c3') as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId('legacy-card-checkbox-c1'));
    fireEvent.click(screen.getByTestId('legacy-migrate-selected'));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('qbank_legacy_migrate_selected', {
        examId: 'exam_1',
        cardIds: ['c1'],
        expectedVersion: 'audit-1',
      }),
    );
    expect(await screen.findByTestId('legacy-migration-receipt')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(auditCalls).toBeGreaterThanOrEqual(2);
  });

  it('shows a stale audit conflict and reloads the report instead of retrying blindly', async () => {
    let auditCalls = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_legacy_audit') {
        auditCalls += 1;
        return auditReport({ audit_version: `audit-${auditCalls}` });
      }
      if (command === 'qbank_reparse_report') return reparseReport();
      if (command === 'qbank_legacy_migrate_selected') {
        throw new Error('CONFLICT: 历史导入审计已变化');
      }
      return null;
    });

    render(<QuestionImportAuditPanel examId="exam_1" />);
    await screen.findByTestId('legacy-card-c1');
    fireEvent.click(screen.getByTestId('legacy-card-checkbox-c1'));
    fireEvent.click(screen.getByTestId('legacy-migrate-selected'));

    expect(await screen.findByTestId('legacy-audit-error')).toHaveTextContent(
      '历史导入审计已变化',
    );
    await waitFor(() => expect(auditCalls).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId('legacy-migration-receipt')).toBeNull();
  });

  it('never offers migration when a canonical marker has no live questions', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_legacy_audit') {
        return auditReport({
          canonical_marker: true,
          canonical_question_count: 0,
          cards: [
            {
              card_id: 'c1',
              page_index: 0,
              card_index: 0,
              question_label: '1',
              preview_text: 'deleted canonical question',
              status: 'suppressed_canonical',
              formal_question_id: null,
              candidate_question_ids: [],
              deleted_question_ids: ['q-deleted'],
              migratable: false,
              reason: '正式题目全部删除，不会从预览快照重建',
            },
          ],
          migratable_card_ids: [],
          matched_count: 0,
          unmatched_count: 0,
          deleted_count: 1,
          suppressed_count: 1,
        });
      }
      if (command === 'qbank_reparse_report') {
        return reparseReport({ items: [], changed_count: 0, deleted_count: 0 });
      }
      return null;
    });

    render(<QuestionImportAuditPanel examId="exam_1" />);
    expect(await screen.findByTestId('canonical-all-deleted-warning')).toBeInTheDocument();
    expect(screen.getByTestId('audit-page-assets')).toHaveTextContent('page-blob-1');
    expect(
      (screen.getByTestId('legacy-card-checkbox-c1') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('legacy-migrate-selected') as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId('legacy-migrate-selected'));
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'qbank_legacy_migrate_selected',
      expect.anything(),
    );
  });

  it('sends explicit keep/replace decisions with the report version and canonical revision', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_legacy_audit') return auditReport();
      if (command === 'qbank_reparse_report') return reparseReport();
      if (command === 'qbank_reparse_resolve') return okResolveReceipt;
      return null;
    });
    const onChanged = vi.fn();

    render(<QuestionImportAuditPanel examId="exam_1" onChanged={onChanged} />);
    await screen.findByTestId('reparse-item-q1');
    const action = screen.getByTestId('reparse-action-q1') as HTMLSelectElement;
    expect(Array.from(action.options).map((option) => option.value)).toEqual([
      'keep_existing',
      'import_as_new',
      'replace_existing',
    ]);
    fireEvent.change(action, { target: { value: 'replace_existing' } });
    expect(
      (screen.getByTestId('reparse-action-q2') as HTMLSelectElement).value,
    ).toBe('keep_existing');

    fireEvent.click(screen.getByTestId('reparse-resolve'));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('qbank_reparse_resolve', {
        examId: 'exam_1',
        jobId: 'job_1',
        expectedReportVersion: 'report-1',
        decisions: [
          {
            local_id: 'q1',
            action: 'replace_existing',
            expected_revision: 'rev-1',
          },
          {
            local_id: 'q2',
            action: 'keep_existing',
            expected_revision: null,
          },
        ],
      }),
    );
    expect(await screen.findByTestId('reparse-receipt')).toHaveTextContent('替换');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('renders the persisted resolution without offering another import', async () => {
    const resolved = reparseReport({
      resolved: true,
      resolution: okResolveReceipt,
      items: reparseReport().items.map((item) => ({ ...item, allowed_actions: [] })),
    });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_legacy_audit') return auditReport();
      if (command === 'qbank_reparse_report') return resolved;
      return null;
    });

    render(<QuestionImportAuditPanel examId="exam_1" />);
    expect(await screen.findByTestId('reparse-receipt')).toBeInTheDocument();
    expect(screen.getByTestId('reparse-resolve')).toBeDisabled();
    expect(screen.getByTestId('reparse-action-q1')).toBeDisabled();
    expect(screen.getByTestId('reparse-action-q2')).toBeDisabled();
    fireEvent.click(screen.getByTestId('reparse-resolve'));
    expect(mocks.invoke).not.toHaveBeenCalledWith('qbank_reparse_resolve', expect.anything());
  });
});
