import { describe, expect, it } from 'vitest';
import {
  buildReplaySkillPayloadSnapshot, extractCitedMemoryNoteIds, replaySnapshotHasMetadata,
} from '../src/persistence.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';

function toolResult(output: unknown): { success: boolean; output: unknown } {
  return { success: true, output };
}

describe('chat_v2/pipeline/persistence.rs::tests', () => {
  it('test_build_replay_skill_payload_snapshot_does_not_persist_skill_contents', () => {
    const options: SendOptions = {
      activeSkillIds: ['manual-a'],
      skillContents: { 'manual-a': 'private instructions' },
    };

    const snapshot = buildReplaySkillPayloadSnapshot(options);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.activeSkillIds).toEqual(['manual-a']);
    // Skill bodies are transient: the persisted snapshot stays empty.
    expect(Object.keys(snapshot!.skillContents ?? {})).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('private instructions');
  });

  it('test_build_replay_skill_payload_snapshot_skips_content_only_payload', () => {
    const options: SendOptions = {
      skillContents: { 'agentic-a': 'private instructions' },
    };

    expect(buildReplaySkillPayloadSnapshot(options)).toBeNull();

    // Every non-body affordance keeps the snapshot alive on its own.
    expect(replaySnapshotHasMetadata({ activeSkillIds: ['a'] })).toBe(true);
    expect(replaySnapshotHasMetadata({ executionAllowedTools: [] })).toBe(true);
    expect(replaySnapshotHasMetadata({ skillDependencies: { a: ['b'] } })).toBe(true);
    expect(replaySnapshotHasMetadata({ mcpToolSchemas: [{ name: 'tool' }] })).toBe(true);
    expect(replaySnapshotHasMetadata({ selectedMcpServers: ['srv'] })).toBe(true);
    expect(replaySnapshotHasMetadata({ skillContents: { a: 'body' } })).toBe(false);
  });

  it('cited_memory_ids_map_citations_including_compressed_sources', () => {
    const toolResults = [toolResult({
      success: true,
      sources: [
        { citationTag: '[记忆-1]', noteId: 'note_a' },
        { citationTag: '[记忆-2]', noteId: null, sourceNoteIds: ['note_b', 'note_c'] },
        { citationTag: '[知识库-1]', noteId: 'res_x' },
        { citationTag: '[记忆-3]', noteId: 'note_d' },
      ],
    })];

    // 记忆-1/2 are cited; 记忆-3 and the knowledge-base entry are not.
    const ids = extractCitedMemoryNoteIds(
      '根据 [记忆-1]，你此前……结合 [记忆-2] 与 [知识库-1] 来看',
      toolResults,
    );
    expect(ids).toEqual(['note_a', 'note_b', 'note_c']);
  });

  it('cited_memory_ids_dedupe_and_handle_no_citation', () => {
    const toolResults = [toolResult({
      success: true,
      sources: [{ citationTag: '[记忆-1]', noteId: 'note_a' }],
    })];

    // Same index cited twice counts once; the English alias is case-insensitive.
    expect(extractCitedMemoryNoteIds('[记忆-1] …… [Memory-1] 再次引用', toolResults))
      .toEqual(['note_a']);
    // A bare "记忆-1" without brackets is not a citation marker.
    expect(extractCitedMemoryNoteIds('提到过 记忆-1 但没有引用标记', toolResults)).toEqual([]);
    // A failed tool result contributes nothing.
    expect(extractCitedMemoryNoteIds('[记忆-1]', [
      { success: false, output: { sources: [{ citationTag: '[记忆-1]', noteId: 'note_a' }] } },
    ])).toEqual([]);
  });

  it('cited_memory_ids_parse_indexes_as_u64 (persistence.rs:265 parse::<u64>)', () => {
    const toolResults = [toolResult({
      success: true,
      sources: [
        { citationTag: '[记忆-9007199254740992]', noteId: 'neighbour' },
        { citationTag: '[记忆-9007199254740993]', noteId: 'exact' },
        { citationTag: '[记忆-18446744073709551616]', noteId: 'overflow' },
      ],
    })];
    expect(extractCitedMemoryNoteIds('见 [记忆-9007199254740993]', toolResults)).toEqual(['exact']);
    expect(extractCitedMemoryNoteIds('见 [记忆-18446744073709551616]', toolResults)).toEqual([]);
  });
});
