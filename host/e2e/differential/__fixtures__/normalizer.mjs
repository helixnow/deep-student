// buildCompare, the report and the run manifest hash every normalizer module relative to their root.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NORMALIZER_FILES } from '../../../../scripts/electron-migration/record/g3-normalize.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** Copies the normalizer's modules (g3-normalize.mjs NORMALIZER_FILES) into the fixture tree `root`. */
export function copyNormalizer(root) {
  for (const file of NORMALIZER_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(root, file));
  }
}
