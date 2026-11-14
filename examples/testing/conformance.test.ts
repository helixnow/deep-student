// @vitest-environment node
/** 仓库里的每个示例插件都跑 conformance.ts 的全部一致性用例。 */
import { describe, expect, it } from 'vitest';
import { describeConformance } from './conformance';
import { examplePackages } from './harness';

const examples = examplePackages();

it('examples/plugins has the four examples', () => {
  expect(examples.map((e) => e.pkg.deepStudent.id))
    .toEqual(['example.web-search', 'example.word-of-day', 'example.study-goal', 'example.translation-prompt']);
});

describe.each(examples.map((e) => [e.pkg.deepStudent.id, e] as const))('%s', (_id, { dir, dirName, pkg }) => {
  describeConformance({ dir, pkg, gateFile: `examples/plugins/${dirName}/package.json` });
});
