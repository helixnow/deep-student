/** X6-LP-0060：真实 Host APKG 导出命令中的 Rust warn 与清理错误语义。 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { MAX_EXPORT_MEDIA_FILE_BYTES } from '../src/apkg-exporter.ts';
import { readZip } from '../src/apkg-zip.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';
import { setAnkiLocalRuntime } from '../src/local-runtime.ts';
import { nodeAnkiLocalRuntime } from '../src/local-runtime.node.ts';

let env: AnkiTestEnv;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync('/tmp/opencode/anki-export-logs-');
  env = await createAnkiTestEnv({
    withReview: false,
    provide: { paths: { appDataDir: home, os: { home, temp: home } } },
  });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await env.dispose();
  setAnkiLocalRuntime(null);
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { setAnkiLocalRuntime(nodeAnkiLocalRuntime); });

function card(images: string[] = []): AnkiCard {
  return {
    id: 'card-export-log', task_id: '', front: 'Q', back: 'A', text: null,
    tags: [], images, is_error_card: false, error_content: null,
    created_at: 'N', updated_at: 'N', extra_fields: {}, template_id: null,
  };
}

it('logs invalid filename, duplicate name, oversized file, unreadable file, then the single-template missing summary', async () => {
  const first = path.join(home, 'first', 'same.png');
  const second = path.join(home, 'second', 'same.png');
  for (const file of [first, second]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'media');
  }
  const large = path.join(home, 'large.png');
  const fd = fs.openSync(large, 'w');
  try { fs.ftruncateSync(fd, MAX_EXPORT_MEDIA_FILE_BYTES + 1); } finally { fs.closeSync(fd); }
  const missing = path.join(home, 'missing.png');
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  const output = await env.host.invoke<string>('export_cards_as_apkg', {
    selectedCards: [card(['/', first, second, large, missing])], deckName: 'Log media', noteType: 'Basic',
  });
  expect(fs.statSync(output).size).toBeGreaterThan(0);
  expect(warn.mock.calls.map((call) => call[0])).toEqual([
    '媒体路径无有效文件名，跳过: /',
    `媒体同名冲突：${first} 与 ${second} 文件名相同（same.png），仅导出首个来源，后者被跳过`,
    `媒体文件超过 ${MAX_EXPORT_MEDIA_FILE_BYTES} 字节导出上限，已跳过: ${large} (${MAX_EXPORT_MEDIA_FILE_BYTES + 1} 字节)`,
    `读取媒体文件失败，跳过并继续导出 ${missing}: No such file or directory (os error 2)`,
    `APKG 导出完成，但 3 个媒体文件缺失: ["/", "${large}", "${missing}"]`,
  ]);
});

it('logs a missing custom field while preserving its empty exported value', async () => {
  const templateId = await env.host.invoke<string>('create_custom_template', {
    request: {
      name: 'Log missing field', description: '', author: null, version: null,
      preview_front: '', preview_back: '', note_type: 'Basic', fields: ['Front', 'Back', 'Missing'],
      generation_prompt: 'Create cards', front_template: '{{Front}}', back_template: '{{Back}}', css_style: '',
      field_extraction_rules: Object.fromEntries(['Front', 'Back', 'Missing'].map((field) => [field, {
        field_type: 'Text', is_required: false, default_value: null, validation_pattern: null, description: field,
      }])),
      preview_data_json: null, is_active: true, is_built_in: false,
    },
  });
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  const output = await env.host.invoke<string>('export_cards_as_apkg_with_template', {
    selectedCards: [card()], deckName: 'Log field', noteType: 'Basic', templateId,
  });
  expect(fs.statSync(output).size).toBeGreaterThan(0);
  expect(warn).toHaveBeenCalledExactlyOnceWith("字段 'Missing' 未找到，使用空值");
  const collection = readZip(fs.readFileSync(output)).get('collection.anki2');
  if (collection === undefined) throw new Error('expected exported collection');
  const dbPath = path.join(home, 'field-check.anki2');
  fs.writeFileSync(dbPath, collection);
  const db = env.storage.openFile(dbPath);
  try {
    expect(db.pluck('SELECT flds FROM notes')).toBe('Q\u001fA\u001f');
  } finally {
    env.storage.close(db);
  }
});

it('multi-template report logs unreadable media but does not invent the discarded-report wrapper summary', async () => {
  const missing = path.join(home, 'multi-missing.png');
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  const result = await env.host.invoke<{ path: string; report: { missingMedia: string[] } }>('export_multi_template_apkg', {
    cards: [card([missing])], deckName: 'Multi report', outputPath: path.join(home, 'multi-report.apkg'),
  });
  expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  expect(result.report.missingMedia).toEqual([missing]);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    `读取媒体文件失败，跳过并继续导出 ${missing}: No such file or directory (os error 2)`,
  );
});

function failTempCleanup(): void {
  const remove = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (path.basename(String(target)).startsWith('anki_export_') && options?.recursive) {
      throw Object.assign(new Error('cleanup denied'), { code: 'EACCES', errno: -13 });
    }
    remove(target, options);
  });
}

it.each(['single', 'multi'] as const)('%s-template cleanup failure does not replace a successful export', async (kind) => {
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  failTempCleanup();
  const output = kind === 'single'
    ? await env.host.invoke<string>('export_cards_as_apkg', {
      selectedCards: [card()], deckName: 'Cleanup single', noteType: 'Basic',
    })
    : (await env.host.invoke<{ path: string }>('export_multi_template_apkg', {
      cards: [card()], deckName: 'Cleanup multi', outputPath: path.join(home, 'cleanup-multi.apkg'),
    })).path;
  expect(fs.statSync(output).size).toBeGreaterThan(0);
  if (kind === 'single') {
    expect(warn).toHaveBeenCalledExactlyOnceWith('警告：清理临时目录失败: Permission denied (os error 13)');
  } else {
    // Rust multi-report 的末尾是 `let _ = remove_dir_all`，不额外加日志。
    expect(warn).not.toHaveBeenCalled();
  }
});

it.each(['single', 'multi'] as const)('%s-template cleanup failure does not mask the primary export error', async (kind) => {
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  failTempCleanup();
  const write = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
    const name = String(target);
    if (name.includes('.apkg.') && name.endsWith('.tmp')) throw new Error('primary export failure');
    write(target, data, options);
  });
  const result = kind === 'single'
    ? env.host.invoke('export_cards_as_apkg', {
      selectedCards: [card()], deckName: 'Failed single', noteType: 'Basic',
    })
    : env.host.invoke('export_multi_template_apkg', {
      cards: [card()], deckName: 'Failed multi', outputPath: path.join(home, 'failed-multi.apkg'),
    });
  await expect(result).rejects.toMatchObject({ error_type: 'Validation', message: 'primary export failure' });
  if (kind === 'single') {
    expect(warn).toHaveBeenCalledExactlyOnceWith('警告：清理临时目录失败: Permission denied (os error 13)');
  } else {
    expect(warn).not.toHaveBeenCalled();
  }
});

it.each(['missing', 'read-error'] as const)(
  'X6-LP-0064 single export keeps the two independent Rust template reads for %s',
  async (failure) => {
    const db = env.storage.database('mistakes');
    const templateId = 'unavailable-export-template';
    if (failure === 'read-error') {
      db.run('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
    }
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    const get = vi.spyOn(db, 'get');
    try {
      const output = await env.host.invoke<string>('export_cards_as_apkg_with_template', {
        selectedCards: [card()], deckName: `Template ${failure}`, noteType: 'Basic', templateId,
      });
      expect(fs.statSync(output).size).toBeGreaterThan(0);
      const expected = failure === 'missing'
        ? [`获取模板配置失败 - 模板ID: ${templateId}, 错误: 模板不存在: ${templateId}，将使用默认模板继续导出`]
        : [
          `获取模板配置失败 - 模板ID: ${templateId}, 错误: 获取模板失败: no such table: custom_anki_templates，将使用默认模板继续导出`,
          `获取完整模板失败 - 模板ID: ${templateId}, 错误: no such table: custom_anki_templates，回退默认模板`,
        ];
      expect(warn.mock.calls.map(([message]) => message)).toEqual(expected);
      const templateReads = get.mock.calls.filter(([input]) => {
        const query: unknown = input;
        return query !== null && typeof query === 'object' && 'name' in query && query.name === 'anki.templates.byId';
      });
      expect(templateReads).toHaveLength(2);
    } finally {
      get.mockRestore();
      if (failure === 'read-error') {
        db.run('ALTER TABLE unavailable_templates RENAME TO custom_anki_templates');
      }
    }
  },
);

it.each(['missing', 'read-error'] as const)(
  'X6-LP-0064 selection export preserves one config read and its Rust %s context',
  async (failure) => {
    const db = env.storage.database('mistakes');
    const id = `selection-log-${failure}`;
    const templateId = 'unavailable-selection-template';
    db.run(`INSERT INTO document_tasks
      (id,document_id,original_document_name,segment_index,content_segment,status,created_at,updated_at,anki_generation_options_json)
      VALUES (?1,?1,'selection.md',0,'body','Completed','N','N','{}')`, [id]);
    expect(env.host.ctx.anki.insertAnkiCard({ ...card(), id, task_id: id, front: id })).toBe(true);
    if (failure === 'read-error') db.run('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    const get = vi.spyOn(db, 'get');
    try {
      const output = await env.host.invoke<string>('export_apkg_for_selection', {
        cardIds: [id], options: {
          deck_name: 'Selection log', note_type: 'Basic', template_id: templateId,
          enable_images: false, max_cards_per_mistake: 5, segment_overlap_size: 0,
        },
      });
      expect(fs.statSync(output).size).toBeGreaterThan(0);
      const error = failure === 'missing' ? `模板不存在: ${templateId}`
        : '获取模板失败: no such table: custom_anki_templates';
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        `获取模板配置失败 - 模板ID: ${templateId}, 错误: ${error}，将使用默认模板继续导出`,
      ]);
      expect(get.mock.calls.filter(([input]) => {
        const query: unknown = input;
        return query !== null && typeof query === 'object' && 'name' in query && query.name === 'anki.templates.byId';
      })).toHaveLength(1);
    } finally {
      get.mockRestore();
      if (failure === 'read-error') db.run('ALTER TABLE unavailable_templates RENAME TO custom_anki_templates');
    }
  },
);

it('X6-LP-0064 multi-template command silently ignores template read failure as Rust if-let does', async () => {
  const db = env.storage.database('mistakes');
  db.run('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  const get = vi.spyOn(db, 'get');
  try {
    const result = await env.host.invoke<{ path: string }>('export_multi_template_apkg', {
      cards: [{ ...card(), template_id: 'unavailable-multi-template' }],
      deckName: 'Multi template read', outputPath: path.join(home, 'multi-template-read.apkg'),
    });
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
    const index = get.mock.calls.findIndex(([input]) => {
      const query: unknown = input;
      return query !== null && typeof query === 'object' && 'name' in query && query.name === 'anki.templates.byId';
    });
    expect(index).toBeGreaterThanOrEqual(0);
    expect(get.mock.results[index]?.type).toBe('throw');
    expect(warn).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    db.run('ALTER TABLE unavailable_templates RENAME TO custom_anki_templates');
  }
});
