import { describe, expect, it } from 'vitest';

describe('ExamContentView module', () => {
  it('loads without runtime reference errors', async () => {
    await expect(import('@/features/learning-hub/apps/views/ExamContentView')).resolves.toHaveProperty('default');
    // ExamContentView 依赖链重（112KB 入口），冷启动转换远超 15s 默认余量
  }, 60_000);
});
