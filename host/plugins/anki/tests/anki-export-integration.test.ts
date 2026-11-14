/**
 * `tests/anki_export_integration.rs`（3 条）的移植：
 * 全模板导出、媒体打包/缺失报告、超大媒体跳过告警。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { readZip } from '../src/apkg-zip.ts';
import {
  MAX_EXPORT_MEDIA_FILE_BYTES,
  exportCardsToApkgWithFullTemplateReport,
  exportMultiTemplateApkgReport,
  type ApkgExportRuntime,
} from '../src/apkg-exporter.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv;
let runtime: ApkgExportRuntime;

beforeAll(async () => {
  env = await createAnkiTestEnv();
  runtime = {
    logger: env.host.ctx.logger,
    openDatabase: (filePath) => env.storage.openFile(filePath),
    closeDatabase: (handle) => env.storage.close(handle),
    tempDir: path.join(env.dir, 'apkg-export-integration'),
  };
  fs.mkdirSync(runtime.tempDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await env.dispose();
});

function basicTemplate(): CustomAnkiTemplate {
  const now = new Date().toISOString();
  return {
    id: 'test-basic-template',
    name: 'Test Basic',
    description: '',
    author: null,
    version: '1.0.0',
    preview_front: 'Front',
    preview_back: 'Back',
    note_type: 'Basic',
    fields: ['Front', 'Back'],
    generation_prompt: '',
    front_template: '{{Front}}',
    back_template: '{{Back}}',
    css_style: '',
    field_extraction_rules: {},
    created_at: now,
    updated_at: now,
    is_active: true,
    is_built_in: true,
    preview_data_json: null,
  };
}

function card(front: string, back: string, images: string[]): AnkiCard {
  const now = new Date().toISOString();
  return {
    front,
    back,
    text: null,
    tags: ['media-integration'],
    images,
    id: `card-${Math.random().toString(36).slice(2)}`,
    task_id: '',
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: {},
    template_id: null,
  };
}

describe('tests/anki_export_integration.rs', () => {
  it('test_export_all_templates', () => {
    const template = basicTemplate();
    const seeded = card(template.preview_front, template.preview_back, []);
    seeded.template_id = template.id;
    const apkgPath = path.join(env.dir, `${template.id}.apkg`);

    exportCardsToApkgWithFullTemplateReport(
      runtime,
      [seeded],
      'TestDeck',
      template.note_type,
      apkgPath,
      [template.id, template.fields, template.front_template, template.back_template, template.css_style],
      template,
    );

    expect(fs.existsSync(apkgPath)).toBe(true);
  });

  it('test_export_report_packs_referenced_media_and_reports_missing', () => {
    const mediaSrc = path.join(env.dir, 'media-src');
    fs.mkdirSync(mediaSrc, { recursive: true });
    const imgPath = path.join(mediaSrc, 'photo.png');
    fs.writeFileSync(imgPath, Buffer.from('photo-bytes'));
    const audioPath = path.join(mediaSrc, 'voice.mp3');
    fs.writeFileSync(audioPath, Buffer.from('voice-bytes'));
    const missingPath = path.join(mediaSrc, 'not-there.gif');

    const cards = [
      card('front <img src="photo.png"> [sound:voice.mp3]', 'back', [
        imgPath,
        audioPath,
        missingPath,
      ]),
    ];

    const apkgPath = path.join(env.dir, 'media-report.apkg');
    const report = exportMultiTemplateApkgReport(runtime, cards, 'MediaReportDeck', apkgPath, new Map());
    expect(report.exportedMedia).toBe(2);
    expect(report.missingMedia).toEqual([missingPath]);

    const archive = readZip(fs.readFileSync(apkgPath));
    const mediaRaw = archive.get('media');
    expect(mediaRaw).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(mediaRaw!)) as Record<string, string>;
    expect(Object.values(manifest).sort()).toEqual(['photo.png', 'voice.mp3']);
    for (const [key, name] of Object.entries(manifest)) {
      const bytes = archive.get(key);
      expect(bytes).toBeDefined();
      const expected = name === 'photo.png' ? 'photo-bytes' : 'voice-bytes';
      expect(new TextDecoder().decode(bytes!), `media entry ${name}`).toBe(expected);
    }
  });

  it('test_export_report_skips_oversized_media_file', () => {
    const mediaSrc = path.join(env.dir, 'oversized-media-src');
    fs.mkdirSync(mediaSrc, { recursive: true });
    const okPath = path.join(mediaSrc, 'small.png');
    fs.writeFileSync(okPath, Buffer.from('small-bytes'));
    const bigPath = path.join(mediaSrc, 'huge.bin');
    fs.writeFileSync(bigPath, Buffer.alloc(0));
    fs.truncateSync(bigPath, MAX_EXPORT_MEDIA_FILE_BYTES + 1);

    const cards = [card('front <img src="small.png">', 'back <img src="huge.bin">', [okPath, bigPath])];

    const apkgPath = path.join(env.dir, 'oversized-media.apkg');
    const report = exportMultiTemplateApkgReport(runtime, cards, 'OversizedDeck', apkgPath, new Map());
    expect(report.exportedMedia).toBe(1);
    expect(report.missingMedia).toEqual([bigPath]);
    expect(
      report.warnings.some((warning) => warning.includes('huge.bin') && warning.includes('上限')),
    ).toBe(true);

    const archive = readZip(fs.readFileSync(apkgPath));
    const manifest = JSON.parse(new TextDecoder().decode(archive.get('media')!)) as Record<string, string>;
    expect(Object.keys(manifest)).toHaveLength(1);
    expect(manifest['0']).toBe('small.png');
  });
});
