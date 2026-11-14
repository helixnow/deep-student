import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function loadV7(dependencyEntry) {
  const entry = resolve(dependencyEntry);
  const pkg = JSON.parse(readFileSync(entry, 'utf8'));
  if (pkg.name !== 'ts-fsrs' || pkg.version !== '6.0.0') throw new Error('Trial requires ts-fsrs@6.0.0');
  const requireV7 = createRequire(entry);
  const { FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS } = requireV7('ts-fsrs/models/fsrs-7');
  return new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);
}
