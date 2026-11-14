import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('Office output metadata and PDF diagnostics have portable runtime closures', () => {
  expect(checkModulesClosure(ROOT, [
    'host/plugins/media/src/office-output.ts',
    'host/plugins/media/src/task-objects.ts',
    'host/plugins/media/src/base64.ts',
    'host/plugins/media/src/pdfium-status.ts',
  ])).toEqual([]);
});
