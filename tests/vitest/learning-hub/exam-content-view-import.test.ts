import { describe, expect, it } from 'vitest';

describe('ExamContentView module', () => {
  it('loads without runtime reference errors', async () => {
    await expect(import('@/components/learning-hub/apps/views/ExamContentView')).resolves.toHaveProperty('default');
  });
});
