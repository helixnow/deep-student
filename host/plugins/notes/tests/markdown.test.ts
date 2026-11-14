import { describe, expect, it } from 'vitest';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import { replaceContent } from '../src/canvas-commands.ts';
import {
  appendToSection, extractSectionContent, getHeadingLevel,
} from '../src/markdown.ts';
// R5 N4: the production notes_manager query builder used by notes_list_advanced.
import { buildNotesFtsMatchQuery } from '../repository/notes-manager.ts';

describe('notes_manager.rs::canvas_tests', () => {
  it('test_get_heading_level', () => {
    for (const [text, level] of [
      ['# Title', 1], ['  # Title  ', 1], ['## Section', 2], ['### Subsection', 3],
      ['###### Deep', 6], ['Normal text', null], ['#NoSpace', null],
      ['####### Too many', null], ['', null],
    ] as const) expect(getHeadingLevel(text)).toBe(level);
  });
  it('test_extract_section_content', () => {
    const content = '# Title\nIntroduction paragraph.\n\n## Section 1\nContent of section 1.\nMore content.\n\n### Subsection 1.1\nNested content.\n\n## Section 2\nContent of section 2.\n\n## End';
    const s1 = extractSectionContent(content, '## Section 1');
    expect(s1).not.toBeNull();
    expect(s1).toContain('Content of section 1');
    expect(s1).toContain('Subsection 1.1');
    expect(s1).toContain('Nested content');
    expect(s1).not.toContain('Content of section 2');
    const s2 = extractSectionContent(content, '## Section 2');
    expect(s2).not.toBeNull();
    expect(s2).toContain('Content of section 2');
    expect(s2).not.toContain('Content of section 1');
    const sub = extractSectionContent(content, '### Subsection 1.1');
    expect(sub).not.toBeNull();
    expect(sub).toContain('Nested content');
    expect(extractSectionContent(content, '## Not Found')).toBeNull();
    expect(extractSectionContent(content, '## section 1')).not.toBeNull();
  });
  it('test_extract_section_content_without_hash', () => {
    const section = extractSectionContent('# Title\nIntro.\n\n## Code\n```js\nconst x = 1;\n```\n\n## End', 'Code');
    expect(section).not.toBeNull();
    expect(section).toContain('const x = 1');
  });
  it('test_append_to_section', () => {
    const result = appendToSection('# Title\n\n## Intro\nHello world.\n\n## Code\n```rust\nfn main() {}\n```\n\n## End\nGoodbye.', '## Code', '// New line added');
    expect(result).not.toBeNull();
    expect(result!.indexOf('## Code')).toBeLessThan(result!.indexOf('// New line added'));
    expect(result!.indexOf('// New line added')).toBeLessThan(result!.indexOf('## End'));
    expect(result).toContain('fn main() {}');
    expect(result).toContain('Goodbye');
  });
  it('test_append_to_last_section', () => {
    const result = appendToSection('# Title\n\n## Last Section\nSome content.', '## Last Section', 'Appended text');
    expect(result).not.toBeNull();
    expect(result).toContain('Some content');
    expect(result).toContain('Appended text');
    expect(result!.indexOf('Some content')).toBeLessThan(result!.indexOf('Appended text'));
  });
  it('test_extract_section_ignores_headings_inside_code_fence', () => {
    const content = '# Title\n\n## Shell\n```bash\n# 这是注释，不是标题\necho hi\n```\ntail text\n\n## Next\nother';
    const section = extractSectionContent(content, '## Shell');
    expect(section).not.toBeNull();
    expect(section).toContain('echo hi');
    expect(section).toContain('tail text');
    expect(section).not.toContain('other');
    expect(extractSectionContent(content, '这是注释，不是标题')).toBeNull();
  });
  it('test_extract_section_with_atx_closing_hashes', () => {
    const content = '# Doc\n\n## Closed ##\nbody line\n\n## C#\ncsharp line\n';
    expect(extractSectionContent(content, 'Closed')).toBe('body line');
    expect(extractSectionContent(content, 'C#')).toBe('csharp line');
  });
  it('test_section_query_level_must_match_when_specified', () => {
    const content = '# Root\n\n## Sub\nlevel2 body\n';
    expect(extractSectionContent(content, '### Sub')).toBeNull();
    expect(extractSectionContent(content, '## Sub')).not.toBeNull();
    expect(extractSectionContent(content, 'Sub')).not.toBeNull();
  });
  it('test_build_notes_fts_match_query', () => {
    expect(buildNotesFtsMatchQuery('ab')).toBeNull();
    expect(buildNotesFtsMatchQuery('  a ')).toBeNull();
    expect(buildNotesFtsMatchQuery('微积分')).toBe('"微积分"');
    expect(buildNotesFtsMatchQuery('say "hi"')).toBe('"say ""hi"""');
  });
  it('test_regex_replace', async () => {
    const content = 'Log: error123 and error456 occurred';
    // Real F7 nativeRegex engine (regex crate 1.12.3 wasm), not JS RegExp.
    const replaced = await replaceContent(content, 'error\\d+', 'ERROR', true, nativeRegex);
    expect(replaced.count).toBe(2);
    expect(replaced.next).toBe('Log: ERROR and ERROR occurred');
    // notes_manager.rs maps `regex::Error` Display into a validation message.
    await expect(replaceContent(content, 'error(', 'ERROR', true, nativeRegex)).rejects.toMatchObject({
      value: {
        error_type: 'Validation',
        message: expect.stringMatching(/^无效的正则表达式: [\s\S]*unclosed group/),
      },
    });
  });
  it('test_regex_engine_comes_from_the_caller_port', async () => {
    const calls: string[] = [];
    const port = {
      async compile(pattern: string) { calls.push(`compile:${pattern}`); return { pattern }; },
      async findIter(_pattern: { pattern: string }, _text: string) {
        return [{ start: 0, end: 1, text: 'a' }];
      },
      async replaceAll(_pattern: { pattern: string }, _text: string, replacement: string) {
        return replacement;
      },
    };
    await expect(replaceContent('a', 'ignored', 'b', true, port)).resolves.toEqual({ next: 'b', count: 1 });
    expect(calls).toEqual(['compile:ignored']);
    await expect(replaceContent('a', 'ignored', 'b', true)).rejects.toMatchObject({
      value: { error_type: 'Unknown', message: '正则引擎不可用（Context.nativeRegex）' },
    });
  });
  it('test_string_replace', async () => {
    const content = 'Hello World, Hello Universe';
    const replaced = await replaceContent(content, 'Hello', 'Hi', false);
    expect(replaced.count).toBe(2);
    expect(replaced.next).toBe('Hi World, Hi Universe');
  });
});
