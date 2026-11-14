import { createSeed, copySeed } from './scenario-seeds.ts';
import { compareDatabaseDirectories, snapshotDirectory } from './database-state.ts';

const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === 'seed' && args.length === 2) result = createSeed(args[0]!, args[1]!);
  else if (command === 'copy' && args.length === 3) result = copySeed(args[0]!, args[1]!, args[2]!);
  else if (command === 'snapshot' && args.length === 1) result = snapshotDirectory(args[0]!);
  else if (command === 'compare' && args.length === 2) {
    const comparison = compareDatabaseDirectories(args[0]!, args[1]!);
    result = comparison;
    process.exitCode = comparison.equal ? 0 : 1;
  } else throw new Error('Usage: scenario-cli.ts seed NAME CATALOG | copy NAME CATALOG DEST | snapshot DIR | compare LEFT RIGHT');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
