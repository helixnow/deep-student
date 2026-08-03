import { describe, expect, it } from 'vitest';
import { canvasNoteSkill } from '../builtin-tools/canvas-note';

describe('canvas note ACR 3.0 OCC contract', () => {
  it.each([
    'builtin-note_append',
    'builtin-note_replace',
    'builtin-note_set',
  ])('%s requires the note_read revision', (name) => {
    const tool = canvasNoteSkill.embeddedTools?.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain('expected_updated_at');
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    expect(tool!.inputSchema.properties.expected_updated_at).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('defines note_read as the source of the updatedAt write baseline', () => {
    const read = canvasNoteSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-note_read',
    );
    expect(read?.description).toContain('updatedAt');
    expect(canvasNoteSkill.content).toContain('expected_updated_at');
  });
});
