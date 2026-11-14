import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaths } from '../paths/index.ts';
import { createLogService } from './index.ts';
import { formatLine, levelEnabled, RotatingFile } from './main-log.ts';
import { DebugLogFileService, formatSize, safeModelComponent, safeTagComponent } from './debug-logs.ts';
import { redactSensitiveFields, redactSensitiveText, sanitizeForLevel, scrubPii } from './redact.ts';
import { DebugLogger, sanitizeApiUrl } from './structured.ts';
import { cleanupOldCrashLogs, writeCrashLog } from './crash.ts';
import { civilTime } from '../time/index.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'f4-log-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const quiet = () => {};

describe('主日志（tauri-plugin-log 2.8.0）', () => {
  it('行格式：UseLocal 后 level 在 target 前', () => {
    const t = civilTime(1_700_000_000_000_000_000n, false);
    expect(formatLine(t, 'info', 'dstu_storage::database', 'hello')).toBe('[2023-11-14][22:13:20][INFO][dstu_storage::database] hello');
  });
  it('level_for 过滤', () => {
    expect(levelEnabled('info', 'dstu_vfs::x')).toBe(true);
    expect(levelEnabled('debug', 'dstu_vfs::x')).toBe(false);
    expect(levelEnabled('info', 'lance::io')).toBe(false);
    expect(levelEnabled('warn', 'lance_io')).toBe(true);
    expect(levelEnabled('info', 'lancer')).toBe(true);
  });
  it('KeepSome(5) 轮转：超过上限归档为带日期文件，最多保留 5 个归档 + 活跃文件', () => {
    const dir = tempDir();
    let sec = 0n;
    const now = () => 1_700_000_000_000_000_000n + sec++ * 1_000_000_000n;
    const file = new RotatingFile({ dir, fileName: 'deep-student', maxSize: 50, keepCount: 5, local: false, now });
    for (let i = 0; i < 20; i++) file.write('x'.repeat(30));
    file.close();
    const names = readdirSync(dir).sort();
    expect(names).toContain('deep-student.log');
    const archived = names.filter((n) => n !== 'deep-student.log');
    expect(archived).toHaveLength(5);
    for (const n of archived) expect(n).toMatch(/^deep-student_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
    expect(readFileSync(join(dir, 'deep-student.log'), 'utf8')).toBe(`${'x'.repeat(30)}\n`);
  });
  it('服务写入 appLogDir/deep-student.log', async () => {
    const base = tempDir();
    const paths = createPaths({ dataDir: join(base, 'data', 'com.deepstudent.app'), platform: 'linux', env: { HOME: base, XDG_DATA_HOME: join(base, 'share') } });
    const log = createLogService({ paths, debug: false, version: '0.11.0', env: {} });
    log.logger('dstu_security::secure_store').warn('警告');
    log.write('debug', 'dstu_core', 'hidden');
    await log.close();
    expect(log.mainLogFile).toBe(join(base, 'share', 'com.deepstudent.app', 'logs', 'deep-student.log'));
    const text = readFileSync(log.mainLogFile, 'utf8');
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[WARN\]\[dstu_security::secure_store\] 警告\n$/);
  });
});

describe('脱敏（debug_log_service.rs）', () => {
  it('文本凭据', () => {
    expect(redactSensitiveText('Authorization: Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678');
    expect(redactSensitiveText('k=sk-abcdef1234567890abcdef ok')).toBe('k=[REDACTED] ok');
    expect(redactSensitiveText('https://x.com/a?key=SECRET&b=1')).toBe('https://x.com/a[REDACTED]&b=1');
    expect(redactSensitiveText('https://user:pw@host/')).toBe('[REDACTED]host/');
  });
  it('字段级', () => {
    expect(redactSensitiveFields({ api_key: 'x', nested: { 'X-Api-Key': 'y', ok: 'z' }, list: [{ refresh_token: 1 }] })).toEqual({
      api_key: '[REDACTED]',
      nested: { 'X-Api-Key': '[REDACTED]', ok: 'z' },
      list: [{ refresh_token: '[REDACTED]' }],
    });
  });
  it('standard / compact', () => {
    const body = {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(4096) } }] }],
      tools: [{ function: { name: 'a' } }, { function: { name: 'b' } }],
      temperature: 0.5,
    };
    const standard = sanitizeForLevel(body, 'standard') as any;
    expect(standard.messages[0].content[0].image_url.url).toEqual({ _redacted: true, _type: 'embedded_binary', _original_chars: 22 + 4096 });
    expect(standard.tools).toEqual([{ _summary: '2 tools: [a, b]' }]);
    const compact = sanitizeForLevel(body, 'compact');
    expect(compact).toEqual({
      model: 'm',
      stream: true,
      messages_summary: [{ role: 'user', content_type: 'multimodal', content_size: 1 }],
      tool_names: ['a', 'b'],
      temperature: 0.5,
    });
  });
  it('scrub_pii', () => {
    expect(scrubPii('at /Users/heli/code/x.ts', 'darwin')).toBe('at /<REDACTED>/code/x.ts');
    expect(scrubPii('C:\\Users\\bob\\a', 'win32')).toBe('C:\\Users\\<REDACTED>\\a');
  });
});

describe('debug-logs', () => {
  const svc = (dir: string) => new DebugLogFileService({ logDir: dir, roots: [dir], report: quiet });

  // debug_log_service.rs::tests::write_debug_response_entry_preserves_raw_response_completely
  it('write_debug_response_entry_preserves_raw_response_completely', async () => {
    const dir = tempDir();
    const s = svc(dir);
    let raw = '```json\n';
    for (let i = 0; i < 500; i++) raw += `第${i}题 第一行\\n第二行 $\\ce{H2O}$ 中文内容——保持完整。\n`;
    raw += '\n```';
    const path = s.writeResponseEntry(dir, 'qbank_generation_response', 'deepseek-chat/v3.1', 'qbank_generation_stream_test', raw)!;
    expect(await s.flushPending()).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).toBe(dir);
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    expect(entry.tag).toBe('qbank_generation_response');
    expect(entry.model).toBe('deepseek-chat/v3.1');
    expect(entry.raw_response_chars).toBe([...raw].length);
    expect(entry.raw_response).toBe(raw);
    expect(Object.keys(entry)).toEqual(['version', 'timestamp', 'tag', 'model', 'stream_event', 'raw_response_chars', 'raw_response']);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
  });
  // ::write_debug_response_entry_redacts_credential_like_text
  it('write_debug_response_entry_redacts_credential_like_text', async () => {
    const dir = tempDir();
    const s = svc(dir);
    const path = s.writeResponseEntry(dir, 'resp', 'm', 'ev', '好的，密钥是 sk-abcdef1234567890abcdef 请保管好。正常内容不受影响。')!;
    await s.flushPending();
    const stored = JSON.parse(readFileSync(path, 'utf8')).raw_response as string;
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toContain('sk-abcdef1234567890abcdef');
    expect(stored).toContain('正常内容不受影响');
  });
  // ::write_debug_log_entry_still_writes_and_redacts_request_body
  it('write_debug_log_entry_still_writes_and_redacts_request_body', async () => {
    const dir = tempDir();
    const s = svc(dir);
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], api_key: 'sk-abcdef1234567890abcdef' };
    const path = s.writeRequestEntry(dir, 'req_tag', 'org/test-model', 'https://x', 'ev', body)!;
    await s.flushPending();
    expect(path).toMatch(/_\d{4}_test-model_req_tag\.json$/);
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    expect(entry.request_body.model).toBe('test-model');
    expect(entry.request_body.api_key).toBe('[REDACTED]');
  });
  // ::safe_components_keep_filename_safe
  it('safe_components_keep_filename_safe', () => {
    expect(safeModelComponent('deepseek/v3.1-turbo')).toBe('v3.1-turbo');
    expect(safeModelComponent('deepseek/模型:名')).toBe('模型_名');
    expect(safeTagComponent('qbank_generation_response')).toBe('qbank_generation_response');
    expect(safeTagComponent('tag with spaces!')).toBe('tag_with_spaces_');
  });
  it('info / cleanup / clear / readFile', async () => {
    const root = tempDir();
    const other = tempDir();
    const s = new DebugLogFileService({ logDir: root, roots: [root, other], report: quiet });
    const d1 = s.ensureDir(root);
    const d2 = s.ensureDir(other);
    writeFileSync(join(d1, 'b.json'), 'x'.repeat(1536));
    writeFileSync(join(d2, 'a.json'), 'y');
    writeFileSync(join(d1, 'skip.txt'), 'z');
    const info = s.info();
    expect(info.count).toBe(2);
    expect(info.total_size_bytes).toBe(1537);
    expect(info.total_size_display).toBe('1.5 KB');
    expect(s.readFile(join(d1, 'b.json'))).toBe('x'.repeat(1536));
    expect(() => s.readFile(join(d1, 'skip.txt'))).toThrow('非法文件类型：仅允许读取 .json 文件');
    const outside = join(root, 'out.json');
    writeFileSync(outside, '{}');
    expect(() => s.readFile(outside)).toThrow('非法路径：不在 debug-logs 目录中');
    expect(() => s.readFile(join(root, 'missing.json'))).toThrow('路径解析失败: No such file or directory (os error 2)');
    const old = Date.now() / 1000 - 10 * 86400;
    utimesSync(join(d2, 'a.json'), old, old);
    expect(s.cleanupOld(7)).toBe(1);
    expect(s.clearAll()).toBe(1);
  });
  it('format_size 与 Rust {:.1} 一致（五成双）', () => {
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1280)).toBe('1.2 KB'); // 1.25 → 1.2
    expect(formatSize(1331)).toBe('1.3 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});

describe('结构化日志（debug_logger.rs）', () => {
  it('ERROR 级立即落盘到 backend/<UTC日期>_<module>.log，JSON 字段顺序与脱敏', async () => {
    const dir = tempDir();
    const logger = new DebugLogger({ logDir: dir, report: quiet });
    for (const sub of ['frontend', 'backend', 'debug']) expect(existsSync(join(dir, sub))).toBe(true);
    await logger.log('ERROR', 'DATABASE', 'op', { password: 'p', ok: 1 }, { mistakeId: 'm1' });
    const files = readdirSync(join(dir, 'backend'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_database\.log$/);
    const line = readFileSync(join(dir, 'backend', files[0]!), 'utf8');
    const entry = JSON.parse(line);
    expect(Object.keys(entry)).toEqual(['timestamp', 'level', 'module', 'operation', 'data', 'context', 'stackTrace']);
    expect(entry.data).toEqual({ password: '[REDACTED]', ok: 1 });
    expect(entry.context).toEqual({ userId: null, sessionId: null, mistakeId: 'm1', streamId: null, businessId: null });
    expect(entry.timestamp).toMatch(/\+00:00$/);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'backend', files[0]!)).mode & 0o777).toBe(0o600);
  });
  it('frontend 批量写入与截断标记', async () => {
    const dir = tempDir();
    const logger = new DebugLogger({ logDir: dir, report: quiet });
    const entries = Array.from({ length: 502 }, (_, i) => ({ timestamp: 't', level: 'INFO' as const, module: 'frontend', operation: `op${i}`, data: {} }));
    await logger.writeFrontendEntries(entries);
    const file = readdirSync(join(dir, 'frontend'))[0]!;
    const lines = readFileSync(join(dir, 'frontend', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(501);
    expect(lines[0].operation).toBe('LOG_BATCH_TRUNCATED');
    expect(lines[0].data).toEqual({ offered_count: 502, persisted_count: 500, limit_bytes: 10485760 });
    expect(lines[1].operation).toBe('op2');
  });
  it('7 天前的文件在构造时清理', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'backend'), { recursive: true });
    const stale = join(dir, 'backend', 'old.log');
    writeFileSync(stale, 'x');
    const old = Date.now() / 1000 - 8 * 86400;
    utimesSync(stale, old, old);
    new DebugLogger({ logDir: dir, report: quiet });
    expect(existsSync(stale)).toBe(false);
  });
  it('sanitize_api_url', () => {
    expect(sanitizeApiUrl('https://u:p@x.com/a?api_key=1&q=2&code=3')).toBe('https://x.com/a?api_key=%5BREDACTED%5D&q=2&code=%5BREDACTED%5D');
    expect(sanitizeApiUrl('not a url')).toBe('[unparseable URL redacted]');
  });
});

describe('崩溃日志（crash_logger.rs）', () => {
  it('文件名、内容与 PII 脱敏；只保留 20 份', () => {
    const dir = tempDir();
    const path = writeCrashLog(dir, new Error('boom at /Users/someone/x'), { version: '0.11.0', buildNumber: '7', gitHash: 'abc' });
    expect(path).toMatch(new RegExp(`crash-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-pid${process.pid}\\.log$`));
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('=== Deep Student 崩溃日志 ===\n时间: ')).toBe(true);
    expect(text).toContain('版本: 0.11.0 (Build 7, abc)\n');
    expect(text).toContain('错误: boom at /<REDACTED>/x\n');
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `crash-${i}.log`), '');
    cleanupOldCrashLogs(dir);
    expect(readdirSync(dir).filter((n) => n.startsWith('crash-'))).toHaveLength(20);
  });
});
