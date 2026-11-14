import { describe, expect, it } from 'vitest';
import {
  NoteAppendTool, NoteCreateTool, NoteListTool, NoteReadTool, NoteReplaceTool, NoteSearchTool,
  NoteSetTool, appendToSection, extractSection, generateSummary, parseStructure, replaceContent,
} from '../src/tools/canvas-tools.ts';

describe('canvas_tools.rs', () => {
  it('test_extract_section', () => {
    const content = '# Title\n## Intro\nHello\n## Code\n```js\nconst x = 1;\n```\n## End\nBye';
    const section = extractSection(content, '## Code');
    expect(section).not.toBeNull();
    expect(section!).toContain('const x = 1;');
    expect(section!).not.toContain('Hello');
    expect(section!).not.toContain('Bye');
  });

  it('test_extract_section_not_found', () => {
    const content = '# Title\n## Intro\nHello';
    expect(extractSection(content, '## NotExist')).toBeNull();
  });

  it('test_append_to_section', () => {
    const content = '# Title\n## Intro\nHello\n## Code\nOld code\n## End';
    const result = appendToSection(content, '## Code', 'New code');
    expect(result).not.toBeNull();
    expect(result!).toContain('Old code');
    expect(result!).toContain('New code');
  });

  it('test_replace_content_plain', () => {
    const [newContent, count] = replaceContent('Hello world, hello Rust', 'hello', 'hi', false);
    expect(count).toBe(1);
    expect(newContent).toContain('hi Rust');
    expect(newContent).toContain('Hello world');
  });

  it('test_replace_content_regex', () => {
    const [newContent, count] = replaceContent('Hello world, hello Rust', '(?i)hello', 'hi', true);
    expect(count).toBe(2);
    expect(newContent).toContain('hi world');
    expect(newContent).toContain('hi Rust');
  });

  it('test_parse_structure', () => {
    const structure = parseStructure('# Title\n## Section 1\n### Subsection\n## Section 2');
    expect(structure).toHaveLength(4);
    expect(structure[0]).toBe('# Title');
    expect(structure[1]).toBe('## Section 1');
  });

  it('test_generate_summary', () => {
    const summary = generateSummary('# Title\nThis is a very long content that needs to be truncated.', 20);
    expect(summary.endsWith('...')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(23);
  });

  it('test_tool_schemas', () => {
    expect(new NoteReadTool().schema().function).toBeDefined();
    expect(new NoteAppendTool().schema().function).toBeDefined();
    expect(new NoteReplaceTool().schema().function).toBeDefined();
    expect(new NoteSetTool().schema().function).toBeDefined();
    expect(new NoteCreateTool().schema().function).toBeDefined();
    expect(new NoteListTool().schema().function).toBeDefined();
    expect(new NoteSearchTool().schema().function).toBeDefined();
  });

  it('note_write_schemas_require_occ_baseline', () => {
    for (const schema of [
      new NoteAppendTool().schema(),
      new NoteReplaceTool().schema(),
      new NoteSetTool().schema(),
    ]) {
      const parameters = schema.function.parameters as {
        required: unknown[]; additionalProperties: unknown;
        properties: Record<string, { minLength?: unknown }>;
      };
      expect(parameters.required.some(value => value === 'expected_updated_at')).toBe(true);
      expect(parameters.additionalProperties).toBe(false);
      expect(parameters.properties.expected_updated_at!.minLength).toBe(1);
    }
  });

  it('test_note_create_schema_has_required_title', () => {
    const parameters = new NoteCreateTool().schema().function.parameters as {
      required: unknown[];
      properties: Record<string, { type?: unknown }>;
      additionalProperties: unknown;
    };
    expect(parameters.required.some(value => value === 'title')).toBe(true);
    expect(parameters.properties.folder_id!.type).toBe('string');
    expect(parameters.properties.tags!.type).toBe('array');
    expect(parameters.additionalProperties).toBe(false);
  });

  it('note_create_and_set_schemas_warn_against_repeating_title_heading', () => {
    for (const toolSchema of [new NoteCreateTool().schema(), new NoteSetTool().schema()]) {
      expect(toolSchema.function.description).toContain('title');
      expect(toolSchema.function.description).toContain('二级标题（##）');
      expect(toolSchema.function.description).toContain('一级标题（# 标题）');
      const properties = (toolSchema.function.parameters as {
        properties: Record<string, { description?: string }>;
      }).properties;
      expect(properties.content!.description).toContain('二级标题（##）');
      expect(properties.content!.description).toContain('# 一级标题');
    }
  });

  it('test_tool_schemas_have_note_id', () => {
    for (const toolSchema of [
      new NoteReadTool().schema(),
      new NoteAppendTool().schema(),
      new NoteReplaceTool().schema(),
      new NoteSetTool().schema(),
    ]) {
      const properties = (toolSchema.function.parameters as {
        properties: Record<string, unknown>;
      }).properties;
      expect(properties.noteId).toBeDefined();
    }
  });
});
