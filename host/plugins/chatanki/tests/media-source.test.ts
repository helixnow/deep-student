import { expect, it } from 'vitest';
import {
  applyMediaSourceRequirements, buildGenerationOptions, defaultGenerationTuning,
} from '../src/executor-helpers.ts';

it('media_transcript_material_adds_source_requirements_and_card_source', () => {
  const content = '## 片段 1/1 · [媒体@file_lecture3:00:00] 起\n[00:05] 正则化用于抑制过拟合';
  const options = buildGenerationOptions(
    '复习第 3 讲', 'Default', 'Basic', content, null, null, null,
    defaultGenerationTuning(), null,
  );
  applyMediaSourceRequirements(options, '## 片段 1/1 · [媒体@file_lecture3:00:00] 起', null);
  const requirements = options.custom_requirements ?? '';
  expect(requirements).toContain('学习目标：复习第 3 讲');
  expect(requirements).toContain('[媒体@资源ID:mm:ss]');
  expect(options.source_ref).toEqual({ kind: 'resource', id: 'file_lecture3', title: null });

  const plain = buildGenerationOptions(
    'goal', 'Default', 'Basic', '普通材料 [03:00]', null, null, null,
    defaultGenerationTuning(), null,
  );
  const before = plain.custom_requirements;
  applyMediaSourceRequirements(plain, '普通材料 [03:00]', null);
  expect(plain.custom_requirements).toBe(before);
  expect(plain.source_ref).toBeNull();
});

it('media source title resolves through the injected media filename lookup', () => {
  const options = buildGenerationOptions(
    'goal', 'Default', 'Basic', 'x', null, null, null,
    defaultGenerationTuning(), null,
  );
  applyMediaSourceRequirements(options, '[媒体@file_lecture3:01:05] 转写', (id) =>
    id === 'file_lecture3' ? '第3讲.mp4' : null);
  expect(options.source_ref).toEqual({
    kind: 'resource', id: 'file_lecture3', title: '第3讲.mp4',
  });
});
