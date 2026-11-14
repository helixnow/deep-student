// chatanki_executor.rs:7511–7575 (`vfs_db = None` branch of the VfsRef input) and the serde decode of
// `vfs_resources.data` (dstu-vfs types.rs:2530–2576); the VFS-backed branches run in run-pipeline-real-host.
import { expect, it } from 'vitest';
import { decodeVfsContextRefData } from '../src/context-refs.ts';
import { resolveVfsRefInput, type ChatAnkiRunInputSources, type ChatAnkiVfsRefInputParams } from '../src/run-vfs-input.ts';

const MATERIAL = '光合作用分为光反应和暗反应两个阶段。\n光反应在类囊体薄膜上进行，产生 ATP 和 NADPH；暗反应在叶绿体基质中进行。';

function params(overrides: Partial<ChatAnkiVfsRefInputParams>, chunks: unknown[]): ChatAnkiVfsRefInputParams {
  const sources: ChatAnkiRunInputSources = {
    latestUserContent: () => MATERIAL,
    resolveTargetRefs: () => { throw new Error('VFS-less runs never read session refs'); },
    vfs: null,
    planner: { callAnkiRoutedRawPrompt: async () => { throw new Error('not called'); } },
    vlm: { callVlmExtract: async () => { throw new Error('not called'); } },
  };
  return {
    sources, sessionId: 's', ankiBlockId: 'blk', goal: 'g', extraContent: null, preferredResourceIds: null,
    forcedRoute: null, visualHint: null, maxImages: null, initialWarnings: [],
    emitChunk: (_id, update) => { chunks.push(update); }, warn: () => undefined, info: () => undefined,
    ...overrides,
  };
}

const simpleTextDetected = {
  progress: { stage: 'importing', route: 'simple_text', messageKey: 'blocks.ankiCards.progress.messages.simpleTextDetected' },
};

it('no VFS: tool content wins over the latest user message and is labelled tool_content', async () => {
  const chunks: unknown[] = [];
  const resolved = await resolveVfsRefInput(params({ extraContent: '  课堂补充材料  ' }, chunks));
  expect(resolved).toEqual({
    route: 'simple_text', content: '  课堂补充材料  ', debugRef: { inputSource: 'tool_content' },
    warnings: [], contentErrorKey: null, llmGlossaryHint: null,
  });
  expect(chunks).toEqual([simpleTextDetected]);
});

it('no VFS: with nothing else the latest material-like user message is the input', async () => {
  const chunks: unknown[] = [];
  const resolved = await resolveVfsRefInput(params({}, chunks));
  expect(resolved).toMatchObject({ route: 'simple_text', content: MATERIAL, debugRef: { inputSource: 'latest_user_message' } });
  expect(chunks).toEqual([simpleTextDetected]);
});

it('no VFS: a forced route or preferred ids suppress the message fallback, so the run has no input', async () => {
  const error = 'VFS database not available (no file input + no content)';
  await expect(resolveVfsRefInput(params({ forcedRoute: 'vlm_full' }, []))).rejects.toThrow(error);
  await expect(resolveVfsRefInput(params({ preferredResourceIds: ['file_a'] }, []))).rejects.toThrow(error);
  await expect(resolveVfsRefInput(params({ extraContent: ' \n ' }, [])))
    .resolves.toMatchObject({ content: MATERIAL, debugRef: { inputSource: 'latest_user_message' } });
  const unreadable = params({}, []);
  unreadable.sources.latestUserContent = () => { throw new Error('chat_v2 locked'); };
  await expect(resolveVfsRefInput(unreadable)).rejects.toThrow(error);
});

it('vfs_resources.data decodes like serde: unit-enum maps, defaults, nullable options; any mismatch is not ref data', () => {
  expect(decodeVfsContextRefData(JSON.stringify({
    refs: [
      { sourceId: 'file_a', resourceHash: 'h1', type: 'file', name: 'a.pdf', extra: 1 },
      { sourceId: 'img_b', resourceHash: 'h2', type: { image: null }, name: 'b.png', resourceId: null,
        snippet: 's', injectModes: { image: ['ocr', { image: null }], pdf: null } },
    ],
  }))).toEqual({
    refs: [
      { sourceId: 'file_a', resourceHash: 'h1', type: 'file', name: 'a.pdf', resourceId: null, snippet: null, injectModes: null },
      { sourceId: 'img_b', resourceHash: 'h2', type: 'image', name: 'b.png', resourceId: null, snippet: 's',
        injectModes: { image: ['ocr', 'image'] } },
    ],
    truncated: false,
    totalCount: 0,
  });
  expect(decodeVfsContextRefData('{"refs":[],"truncated":true,"totalCount":3}')).toEqual({ refs: [], truncated: true, totalCount: 3 });
  for (const invalid of [
    'not json', '[]', '{}', '{"refs":[],"truncated":null}', '{"refs":[],"totalCount":-1}',
    '{"refs":[{"sourceId":"a","resourceHash":"h","type":"MindMap","name":"n"}]}',
    '{"refs":[{"sourceId":"a","resourceHash":"h","type":"file"}]}',
    '{"refs":[{"sourceId":"a","resourceHash":"h","type":"image","name":"n","injectModes":{"image":["pdf"]}}]}',
  ]) {
    expect(decodeVfsContextRefData(invalid), invalid).toBeNull();
  }
});
