/**
 * W37 枢纽文件行数预算：控制器拆出后，两个 hub 文件只保留 props/渲染装配。
 * 基线来自改造前：LearningHubPage 1594 行、LearningHubSidebar 1443 行；要求各降 >=40%。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const lineCount = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8').split('\n').length;

describe('learning hub file budget', () => {
  it('keeps LearningHubPage at 60% or less of 1594 lines', () => {
    expect(lineCount('src/features/learning-hub/LearningHubPage.tsx')).toBeLessThanOrEqual(Math.floor(1594 * 0.6));
  });

  it('keeps LearningHubSidebar at 60% or less of 1443 lines', () => {
    expect(lineCount('src/features/learning-hub/LearningHubSidebar.tsx')).toBeLessThanOrEqual(Math.floor(1443 * 0.6));
  });
});
