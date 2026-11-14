import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { PaperExportBridge, type PaperExportHost } from '../src/paper-export-bridge.ts';
import { countValidChars, inspectPdfText } from '../src/pdf-inspection.ts';
import { parseHeatmapDate } from '../src/heatmap-service.ts';
import type { LearningActivity } from '../api.ts';

const NOW = '2026-01-01T10:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-misc-');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      docs: {
        extractTextFromBase64: async () => '  第一段文字。 第二段文字。 ',
      },
    },
  });
  return {
    base, host, storage,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('get_learning_heatmap', () => {
  it('aggregates each source into the matching date and sums the visible count', async () => {
    const f = await fixture();
    try {
      const vfs = f.storage.database('vfs');
      const chat = f.storage.database('chat_v2');
      const main = f.storage.database('mistakes');
      chat.run(`INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
        VALUES ('sess_1', 'general_chat', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z')`);
      chat.run(`INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
        VALUES ('msg_1', 'sess_1', 'user', 1767261600000), ('msg_2', 'sess_1', 'assistant', 1767265200000)`);
      vfs.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
          created_at, updated_at)
        VALUES ('exam_heat', 'heat', 'completed', 'heat', '{}', '{}', '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z')`);
      vfs.run(`INSERT INTO study_time_daily (date, seconds, updated_at)
        VALUES ('2026-01-01', 120, 1), ('2026-01-02', 7200, 2)`);
      main.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index,
          content_segment, status, anki_generation_options_json)
        VALUES ('task_1', 'doc_1', 'doc', 0, 'body', 'Completed', '{}')`);
      main.run(`INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at)
        VALUES ('card_1', 'task_1', 'front', 'back', '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z')`);

      const result = await f.host.invoke('get_learning_heatmap', {
        startDate: '2026-01-01', endDate: '2026-01-02',
      }) as LearningActivity[];

      expect(result.map(row => row.date)).toEqual(['2026-01-01', '2026-01-02']);
      expect(result[0]!.details).toEqual({
        chatSessions: 1, chatMessages: 2, notesEdited: 0, textbooksOpened: 0,
        examsCreated: 1, translationsCreated: 0, essaysCreated: 0, ankiCardsCreated: 0,
        questionsAnswered: 0,
      });
      expect(result[0]!.count).toBe(4);
      expect(result[0]!.studySeconds).toBe(120);
      expect(result[1]!.details.ankiCardsCreated).toBe(1);
      expect(result[1]!.count).toBe(1);
      expect(result[1]!.studySeconds).toBe(7200);
    } finally {
      await f.dispose();
    }
  });

  it('rejects a malformed date with the chrono parse wording', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('get_learning_heatmap', {
        startDate: '2026/01/01', endDate: '2026-01-02',
      })).rejects.toMatchObject({
        error_type: 'Validation',
        message: 'Invalid start_date: input contains invalid characters',
      });
      await expect(f.host.invoke('get_learning_heatmap', {
        startDate: '2026-02-30', endDate: '2026-03-01',
      })).rejects.toMatchObject({
        error_type: 'Validation',
        message: 'Invalid start_date: input is out of range',
      });
    } finally {
      await f.dispose();
    }
  });

  it('parses leap days and rejects non-leap February 29', () => {
    expect(parseHeatmapDate('2024-02-29', 'x').toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(() => parseHeatmapDate('2026-02-29', 'x')).toThrow('input is out of range');
  });
});

function paperConfig(): import('../api.ts').PaperConfig {
  return {
    title: '练习', type_selection: {}, difficulty_filter: null, tags_filter: null,
    shuffle: false, include_answers: false, include_explanations: false, export_format: 'word',
  };
}

describe('qbank_complete_paper_export', () => {
  function bridgeHost(base: string): PaperExportHost & { emitted: Array<{ event: string; payload: unknown }> } {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    return {
      exportDir: base,
      emitted,
      emit(event, payload) { emitted.push({ event, payload }); },
      log: { warn() {}, info() {} },
    };
  }

  it('reports an expired request id', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('qbank_complete_paper_export', {
        requestId: 'missing', data: null, error: null,
      })).rejects.toMatchObject({ error_type: 'Validation', message: 'Export request expired' });
    } finally {
      await f.dispose();
    }
  });

  it('writes a validated word file and resolves the pending export', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-paper-export-'));
    try {
      const host = bridgeHost(base);
      const bridge = new PaperExportBridge();
      const pending = bridge.exportForTool(host, {
        id: 'paper_1', title: '数学/练习:第一套', exam_id: 'exam_1', created_at: NOW,
        config: paperConfig(), questions: [], total_score: 0, export_path: null,
      }, 'word', true, true);
      expect(host.emitted).toHaveLength(1);
      expect(host.emitted[0]!.event).toBe('qbank-export-paper');
      const request = host.emitted[0]!.payload as { request_id: string; title?: string };
      const data = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64');
      await bridge.complete(host, request.request_id, data, null);
      const filePath = await pending;
      expect(path.basename(filePath)).toMatch(/^数学_练习_第一套-[0-9a-f-]+\.docx$/);
      expect(fs.readFileSync(filePath)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects bytes that do not match the requested format', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-paper-export-'));
    try {
      const host = bridgeHost(base);
      const bridge = new PaperExportBridge();
      const pending = bridge.exportForTool(host, {
        id: 'paper_2', title: '练习', exam_id: 'exam_1', created_at: NOW,
        config: paperConfig(), questions: [], total_score: 0, export_path: null,
      }, 'pdf', false, false);
      const request = host.emitted[0]!.payload as { request_id: string };
      await bridge.complete(host, request.request_id,
        Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64'), null);
      expect(await pending).toBe('Invalid generated paper file');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('passes the frontend error through unchanged', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-paper-export-'));
    try {
      const host = bridgeHost(base);
      const bridge = new PaperExportBridge();
      const pending = bridge.exportForTool(host, {
        id: 'paper_3', title: '练习', exam_id: 'exam_1', created_at: NOW,
        config: paperConfig(), questions: [], total_score: 0, export_path: null,
      }, 'pdf', false, false);
      const request = host.emitted[0]!.payload as { request_id: string };
      await bridge.complete(host, request.request_id, null, 'user cancelled');
      expect(await pending).toBe('user cancelled');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('inspect_pdf_text_for_qbank', () => {
  it('trims, counts valid characters and takes the first 800 chars', async () => {
    const f = await fixture();
    try {
      const result = await f.host.invoke('inspect_pdf_text_for_qbank', {
        request: { content: 'base64' },
      }) as { valid_char_count: number; total_char_count: number; preview_text: string; recommendation: string };
      expect(result.valid_char_count).toBe(countValidChars('第一段文字。 第二段文字。'));
      expect(result.total_char_count).toBe([...'第一段文字。 第二段文字。'].length);
      expect(result.preview_text).toBe('第一段文字。 第二段文字。');
      expect(result.recommendation).toBe('auto_ocr');
    } finally {
      await f.dispose();
    }
  });

  it('maps valid-character thresholds to the Rust recommendations', () => {
    expect(inspectPdfText('字'.repeat(99)).recommendation).toBe('auto_ocr');
    expect(inspectPdfText('字'.repeat(100)).recommendation).toBe('manual_decision');
    expect(inspectPdfText('字'.repeat(499)).recommendation).toBe('manual_decision');
    expect(inspectPdfText('字'.repeat(500)).recommendation).toBe('use_text');
    const long = inspectPdfText('a'.repeat(900));
    expect(long.total_char_count).toBe(900);
    expect([...long.preview_text]).toHaveLength(800);
  });
});
