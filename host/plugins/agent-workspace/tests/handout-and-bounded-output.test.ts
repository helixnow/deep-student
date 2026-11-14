import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIRSTLINE_CHARS_XML, FONT, LINE_EXACT_28, SIZE, TABLE_BORDERS,
  parseHandoutSectionBlocks, parseRewrittenBlock, renderHandoutDocumentHtml,
  renderHandoutPageNumberXml, rewriteHandoutSection,
} from '../src/handout-ir.ts';
import {
  ARTIFACT_TTL_MS, BoundedStreamAccumulator, OUTPUT_LIMIT_BYTES,
  Utf16LeArtifactStore,
} from '../src/bounded-output-artifact.ts';

const directories: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bounded-output-test-'));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const parse = (blocks: unknown[], startSec = 0, endSec = 8000) => parseHandoutSectionBlocks(JSON.stringify({ blocks }), { startSec, endSec });

describe('讲义 IR 清洗与确定性排版', () => {
  it('清除前置序号与行内 Markdown，保留所有块类型', () => {
    expect(parse([
      { type: 'lead', text: '**主旨**' }, { type: 'para', text: '1. __正文__ 与 `code`' },
      { type: 'h2', text: '（一）**标题**' },
      { type: 'list', ordered: true, items: ['1. **条目**', '● __第二项__', '（二）`第三项`'] },
      { type: 'note', text: '● 注意' },
      { type: 'table', caption: '**对照**', header: ['甲', '乙'], rows: [['`x`', '__y__']] },
    ])).toEqual([
      { type: 'lead', text: '主旨' }, { type: 'para', text: '正文 与 code' },
      { type: 'h2', text: '标题' }, { type: 'list', ordered: true, items: ['条目', '第二项', '第三项'] },
      { type: 'note', text: '注意' }, { type: 'table', caption: '对照', header: ['甲', '乙'], rows: [['x', 'y']] },
    ]);
  });
  it('换算 mm:ss / hh:mm:ss，越界和无效配图不影响整节', () => {
    const blocks = parse([
      { type: 'figure', time: '01:02' }, { type: 'figure', time: '01:02:03', caption: '**图**' },
      { type: 'figure', time: '00:01' }, { type: 'figure', time: '09:00:00' },
      { type: 'figure', time: '01:99' }, { type: 'figure', time: 'invalid' },
      { type: 'para', text: ' ' },
    ], 62, 3723);
    expect(blocks).toEqual([{ type: 'figure', ts: 62 }, { type: 'figure', ts: 3723, caption: '图' }]);
  });
  it('接受围栏及前后说明，结构性错误触发重试', () => {
    expect(parseHandoutSectionBlocks('说明\n```json\n{"blocks":[{"type":"para","text":"内容"}]}\n```', { startSec: 0, endSec: 10 })).toEqual([{ type: 'para', text: '内容' }]);
    expect(() => parse([{ type: 'table', header: ['a', 'b'], rows: [['x']] }])).toThrow('行列数不一致');
    expect(() => parse([{ type: 'table', header: ['a', 'b'], rows: [['x', ' ']] }])).toThrow('单元格为空');
    expect(() => parse([{ type: 'table', header: [' '], rows: [['x']] }])).toThrow('header 为空');
    expect(() => parse([{ type: 'table', header: ['a'], rows: [] }])).toThrow('rows 为空');
    expect(() => parse([{ type: 'unknown' }])).toThrow('未知块类型');
    expect(() => parse([])).toThrow('无有效块');
    expect(() => parseHandoutSectionBlocks('没有 JSON', { startSec: 0, endSec: 1 })).toThrow('JSON');
  });
  it('组装封面/目录/正文、分节编号、图表、转义和公文排版', () => {
    const blocks = parse([
      { type: 'lead', text: '<script>&"' }, { type: 'h2', text: '（一）小节' },
      { type: 'list', ordered: true, items: ['条目'] }, { type: 'list', ordered: false, items: ['条目'] },
      { type: 'table', header: ['列'], rows: [['值']] },
      { type: 'figure', time: '00:01', caption: '示意图' }, { type: 'figure', time: '00:02' },
      { type: 'note', text: '注意' },
    ]);
    const doc = { title: '标题<&', courseName: '课程', date: '2026年11月9日', summary: '摘要', sections: [{ heading: '第一节', blocks }, { heading: '第二节', blocks: [{ type: 'h2' as const, text: '重新编号' }] }], images: new Map([[1, { data: new Uint8Array([255, 216, 255]), width: 1120, height: 560, caption: '图' }]]) };
    const html = renderHandoutDocumentHtml(doc);
    expect(html).toBe(renderHandoutDocumentHtml(doc));
    for (const text of ['class="cover"', 'class="toc"', '<main>', '一、第一节', '二、第二节', '（一）重新编号', '表 1-1', '图 1-1', 'image/jpeg;base64', 'width="560" height="280"', '&lt;script&gt;&amp;&quot;', 'text-indent:2em', 'line-height:28pt', 'border-top:1.5pt', 'border-bottom:.5pt', '@page body:right', '@page body:left', '— ']) expect(html).toContain(text);
    expect(html).not.toContain('<script>');
    expect(html.match(/<figure>/g)).toHaveLength(1);
    expect(FONT.h1).toBe('黑体'); expect(SIZE.h1).toBe(32); expect(SIZE.body).toBe(28);
    expect(LINE_EXACT_28).toEqual({ line: 560, lineRule: 'exact' });
    expect(TABLE_BORDERS).toEqual({ top: 12, bottom: 12, headerBottom: 4, vertical: 0, bodyHorizontal: 0 });
    expect(FIRSTLINE_CHARS_XML).toContain('firstLineChars="200"');
    expect(renderHandoutPageNumberXml(true)).toContain('w:val="right"');
    expect(renderHandoutPageNumberXml(false)).toContain('w:val="left"');
    expect(renderHandoutPageNumberXml(true)).toContain('w:instr="PAGE"');
  });
  it('单块改写保留图时间、列表顺序、表格维度，整节改写只重试失败块', async () => {
    expect(parseRewrittenBlock('{"caption":"**新图注**","ts":999}', { type: 'figure', ts: 10 })).toEqual({ type: 'figure', ts: 10, caption: '新图注' });
    expect(parseRewrittenBlock('{"items":["1. 新条目"],"ordered":false}', { type: 'list', ordered: true, items: ['原条目'] })).toEqual({ type: 'list', ordered: true, items: ['新条目'] });
    expect(() => parseRewrittenBlock('{"header":["a"],"rows":[["x"],["y"]]}', { type: 'table', header: ['a'], rows: [['x']] })).toThrow('行列维度');
    const generate = vi.fn().mockResolvedValueOnce('bad').mockResolvedValueOnce('{"text":"新段落"}');
    expect(await rewriteHandoutSection({ heading: '标题', blocks: [{ type: 'para', text: '原文' }] }, '简化', generate, { title: '讲义' })).toEqual({ heading: '标题', blocks: [{ type: 'para', text: '新段落' }] });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('流式有界输出', () => {
  it('正确拼接逐字节 UTF-8 中文与数学符号，双管道解码互不干扰', () => {
    const acc = new BoundedStreamAccumulator();
    const text = '中文 English ∑积分αβ 𝛑\n';
    const out = Buffer.from(text), err = Buffer.from('错误：π≠∞');
    for (let i = 0; i < Math.max(out.length, err.length); i++) {
      if (i < out.length) acc.append('stdout', out.subarray(i, i + 1));
      if (i < err.length) acc.append('stderr', err.subarray(i, i + 1));
    }
    const result = acc.finish();
    expect(result.stdout).toBe(text); expect(result.stderr).toBe('错误：π≠∞');
    expect(result.stdoutTruncated).toBe(false); expect(result.complete).toBe(true);
    expect(result.output.stdoutBytes).toBe(out.length);
    expect(acc.finish()).toEqual(result);
  });
  it('8KiB 临界值完整返回；超限仅保留4KiB首尾，绝不终止命令', () => {
    const acc = new BoundedStreamAccumulator();
    acc.append('stdout', Buffer.from('a'.repeat(8192)));
    expect(acc.append('stderr', Buffer.from('e'.repeat(9000))).stderr).toBe('e'.repeat(8192));
    expect(acc.append('stdout', Buffer.from('b'.repeat(6000))).stdout).toBe('a'.repeat(4096) + 'b'.repeat(4096));
    const result = acc.finish();
    expect(result.stdoutTruncated).toBe(true); expect(result.stderrTruncated).toBe(true);
    expect(result.complete).toBe(true); expect(result.terminationReason).toBeUndefined();
    const exact = new BoundedStreamAccumulator(); exact.append('stdout', Buffer.alloc(8192, 97));
    expect(exact.finish().stdout).toHaveLength(8192); expect(exact.finish().stdoutTruncated).toBe(false);
  });
  it('中文首尾预览无替换字符且每条流内存预览不超过8KiB', () => {
    const acc = new BoundedStreamAccumulator();
    const text = '开头'.repeat(3000) + '末尾'.repeat(3000);
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 113) acc.append('stdout', bytes.subarray(i, i + 113));
    const result = acc.finish();
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stdout.startsWith('开头')).toBe(true); expect(result.stdout.endsWith('末尾')).toBe(true);
  });
  it('stdout/stderr 合并16MiB硬上限熔断并保留部分输出，不再接受洪泛', () => {
    const acc = new BoundedStreamAccumulator();
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let i = 0; i < 16; i++) expect(acc.append(i % 2 ? 'stderr' : 'stdout', chunk).complete).toBe(true);
    const over = acc.append('stdout', Buffer.from('洪泛'));
    expect(over.terminationReason).toBe('output_limit_exceeded'); expect(over.complete).toBe(false);
    expect(over.output.stdoutBytes + over.output.stderrBytes).toBe(OUTPUT_LIMIT_BYTES);
    expect(acc.append('stderr', chunk)).toEqual(over);
    expect(acc.finish().output.complete).toBe(false);
  });
});

describe('UTF-16LE 旁路文件及字符分页', () => {
  it('217KB混合输出随机分页逐字符等于String.slice，含代理对中间偏移', () => {
    const dir = directory(), store = new Utf16LeArtifactStore(dir);
    const text = ('中文 English ∑αβ√π≠∞ 𝛑\n'.repeat(8000)).slice(0, 140000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(217000);
    const artifact = store.writeArtifact('owner', text);
    const file = readdirSync(dir)[0]!;
    expect(readFileSync(join(dir, file)).equals(Buffer.from(text, 'utf16le'))).toBe(true);
    let seed = 19;
    for (let i = 0; i < 120; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const offset = seed % (text.length + 1), max = (seed % 11791) + 1;
      const result = store.readArtifactSlice(artifact.artifactId, 'owner', offset, max);
      expect(result.slice).toBe(text.slice(offset, offset + max));
      expect(result.totalChars).toBe(text.length);
      expect(result.nextOffset).toBe(offset + max < text.length ? offset + max : null);
      expect(result.truncated).toBe(offset + max < text.length);
    }
    const surrogate = text.indexOf('𝛑');
    expect(store.readArtifactSlice(artifact.artifactId, 'owner', surrogate + 1, 1).slice).toBe(text.slice(surrogate + 1, surrogate + 2));
    expect(store.readArtifactSlice(artifact.artifactId, 'owner', text.length, 1)).toEqual({ slice: '', totalChars: text.length, nextOffset: null, truncated: false });
    expect(() => store.readArtifactSlice(artifact.artifactId, 'stranger', 0, 10)).toThrow('artifact_not_found');
    expect(() => store.readArtifactSlice(artifact.artifactId, 'owner', -1, 10)).toThrow('invalid_artifact_range');
  });
  it('连接流式蓄水池，UTF-8拆块后完整溢写，而模型只见预览', () => {
    const dir = directory(), store = new Utf16LeArtifactStore(dir);
    const acc = new BoundedStreamAccumulator({ store, ownerId: 'owner' });
    const text = '中文 E=mc² ∑𝛑\n'.repeat(10000), bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 337) acc.append('stdout', bytes.subarray(i, i + 337));
    const result = acc.finish(), artifact = result.artifacts!.stdout!;
    expect(result.stdoutTruncated).toBe(true); expect(result.outputStorageError).toBeUndefined();
    expect(artifact.totalChars).toBe(text.length); expect(artifact.sizeBytes).toBe(bytes.length);
    let content = '', offset = 0;
    for (;;) {
      const page = store.readArtifactSlice(artifact.artifactId, 'owner', offset, 777);
      content += page.slice;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(content).toBe(text);
  });
  it('小输出以内联存储，超过8KiB才创建旁路文件', () => {
    const dir = directory(), store = new Utf16LeArtifactStore(dir);
    const small = store.writeArtifact('o', '中'.repeat(2000));
    expect(readdirSync(dir)).toEqual([]);
    expect(store.readArtifactSlice(small.artifactId, 'o', 3, 8).slice).toBe('中'.repeat(8));
    store.writeArtifact('o', 'x'.repeat(8193)); expect(readdirSync(dir)).toHaveLength(1);
  });
  it('owner字节/数量配额包含并发写入，失败释放预留并退化为预览', () => {
    const store = new Utf16LeArtifactStore(directory(), { ownerQuotaBytes: 9000, ownerArtifactLimit: 2 });
    const pending = store.createWriter('o'); pending.append(Buffer.alloc(8000, 97));
    expect(() => store.writeArtifact('o', 'b'.repeat(1001))).toThrow('artifact_quota_exceeded');
    pending.discard();
    const acc = new BoundedStreamAccumulator({ store, ownerId: 'o' });
    acc.append('stdout', Buffer.from('z'.repeat(10000)));
    const result = acc.finish();
    expect(result.outputStorageError).toBe('artifact_quota_exceeded');
    expect(result.complete).toBe(true); expect(result.stdout).toBe('z'.repeat(8192));
    expect(readdirSync(store.directory)).toEqual([]);
    store.writeArtifact('o', 'a'); store.writeArtifact('o', 'b');
    expect(() => store.writeArtifact('o', 'c')).toThrow('artifact_quota_exceeded');
    expect(store.writeArtifact('other', 'c').sizeBytes).toBe(1);
  });
  it('磁盘不可用仅降级存储，七天TTL清理文件并释放配额', () => {
    const unavailable = new Utf16LeArtifactStore('/dev/null/outputs');
    const acc = new BoundedStreamAccumulator({ store: unavailable, ownerId: 'o' });
    acc.append('stdout', Buffer.alloc(9000, 120));
    expect(acc.finish().outputStorageError).toBe('artifact_storage_unavailable');
    expect(acc.finish().complete).toBe(true);
    let now = 100;
    const store = new Utf16LeArtifactStore(directory(), { now: () => now, ownerArtifactLimit: 1 });
    const artifact = store.writeArtifact('o', 'a'.repeat(9000));
    now += ARTIFACT_TTL_MS;
    expect(() => store.readArtifactSlice(artifact.artifactId, 'o')).toThrow('artifact_expired');
    expect(store.cleanup()).toBe(1); expect(readdirSync(store.directory)).toEqual([]);
    expect(store.cleanup()).toBe(0); expect(store.writeArtifact('o', 'new').totalChars).toBe(3);
  });
});
