import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';

import {
  detectMentionTrigger,
  shouldSkipMentionContext,
} from '../detectTrigger';

describe('detectMentionTrigger', () => {
  it('triggers on lone @ at start', () => {
    expect(detectMentionTrigger('@')).toEqual({
      triggerStartInText: 0,
      query: '',
    });
  });

  it('triggers on @query', () => {
    expect(detectMentionTrigger('@calculus')).toEqual({
      triggerStartInText: 0,
      query: 'calculus',
    });
  });

  it('triggers after whitespace', () => {
    expect(detectMentionTrigger('see @note')).toEqual({
      triggerStartInText: 4,
      query: 'note',
    });
  });

  it('does not trigger when @ is mid-word', () => {
    expect(detectMentionTrigger('email@x')).toBeNull();
    expect(detectMentionTrigger('中文@x')).toBeNull();
  });

  it('does not trigger when @ is followed by space', () => {
    expect(detectMentionTrigger('@ ')).toBeNull();
    expect(detectMentionTrigger('hi @ world')).toBeNull();
  });

  it('cancels when query contains space', () => {
    expect(detectMentionTrigger('@foo bar')).toBeNull();
  });

  it('uses the rightmost valid @', () => {
    expect(detectMentionTrigger('@a @b')).toEqual({
      triggerStartInText: 3,
      query: 'b',
    });
  });

  it('allows punctuation before @', () => {
    expect(detectMentionTrigger('(@x')).toEqual({
      triggerStartInText: 1,
      query: 'x',
    });
  });
});

describe('shouldSkipMentionContext', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        content: 'inline*',
        group: 'block',
        toDOM: () => ['p', 0],
      },
      code_block: {
        content: 'text*',
        group: 'block',
        code: true,
        defining: true,
        toDOM: () => ['pre', ['code', 0]],
      },
      text: { group: 'inline' },
    },
  });

  it('skips inside code_block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('@foo')]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    });
    expect(shouldSkipMentionContext(state)).toBe(true);
  });

  it('allows inside paragraph', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('@foo')]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    });
    expect(shouldSkipMentionContext(state)).toBe(false);
  });
});
