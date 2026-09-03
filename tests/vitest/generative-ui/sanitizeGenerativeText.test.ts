import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  GenerativeUIRenderer,
  sanitizeGenerativeText,
  sanitizeGenerativeTextLeaves,
  validateBlockProps,
} from '@/features/generative-ui';
import { textBlockPropsSchema } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

describe('sanitizeGenerativeText', () => {
  it('strips C0 controls including NUL–BS', () => {
    const dirty = 'A\u0000B\u0001C\u0007D\u0008E';
    expect(sanitizeGenerativeText(dirty)).toBe('ABCDE');
    expect(sanitizeGenerativeText(dirty)).not.toMatch(/[\u0000-\u0008]/);
  });

  it('strips VT / FF / other C0, DEL, and C1 while keeping TAB LF CR', () => {
    const dirty = 'keep\tline\nbreak\r\u000B\u000C\u001F\u007F\u0085\u009Fend';
    expect(sanitizeGenerativeText(dirty)).toBe('keep\tline\nbreak\rend');
  });

  it('returns empty / unchanged non-dirty strings', () => {
    expect(sanitizeGenerativeText('')).toBe('');
    expect(sanitizeGenerativeText('正常正文')).toBe('正常正文');
  });
});

describe('sanitizeGenerativeTextLeaves', () => {
  it('walks nested props string leaves without changing shape', () => {
    const input = {
      heading: 'Hi\u0000',
      body: 'Hello\u0000world',
      density: 'normal',
      rows: [{ key: 'k\u0007', value: 3, nested: ['a\u0008b', null] }],
    };
    expect(sanitizeGenerativeTextLeaves(input)).toEqual({
      heading: 'Hi',
      body: 'Helloworld',
      density: 'normal',
      rows: [{ key: 'k', value: 3, nested: ['ab', null] }],
    });
  });

  it('leaves primitives and non-plain objects untouched', () => {
    expect(sanitizeGenerativeTextLeaves(12)).toBe(12);
    expect(sanitizeGenerativeTextLeaves(null)).toBe(null);
    const when = new Date('2026-08-24T00:00:00.000Z');
    expect(sanitizeGenerativeTextLeaves(when)).toBe(when);
  });
});

describe('validateBlockProps sanitizes before schema', () => {
  it('hooks sanitizeGenerativeTextLeaves in validateBlockProps', () => {
    const schemaSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/schema.ts'),
      'utf8',
    );
    expect(schemaSrc).toContain('sanitizeGenerativeTextLeaves');
    expect(schemaSrc).toContain('textBlockPropsSchema');
  });

  it('returns stripped text-block props without changing schema fields', () => {
    const result = validateBlockProps(textBlockPropsSchema, {
      heading: '标题\u0000',
      body: '正文\u0000内容',
      density: 'compact',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.props).toEqual({
        heading: '标题',
        body: '正文内容',
        density: 'compact',
      });
      expect(result.props.body).not.toContain('\u0000');
    }
  });

  it('fails min-length after control-only body is stripped', () => {
    const result = validateBlockProps(textBlockPropsSchema, { body: '\u0000\u0008' });
    expect(result.ok).toBe(false);
  });
});

describe('GenerativeUIRenderer text block', () => {
  it('does not render NUL in a text block', () => {
    render(
      React.createElement(GenerativeUIRenderer, {
        intent: {
          version: '1',
          blocks: [
            {
              type: 'text',
              props: {
                heading: '标题\u0000',
                body: '你好\u0000世界',
              },
            },
          ],
        },
        showChrome: false,
      }),
    );

    expect(screen.getByText('标题')).toBeInTheDocument();
    expect(screen.getByText('你好世界')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\u0000');
    expect(document.body.innerHTML).not.toContain('\u0000');
  });
});
