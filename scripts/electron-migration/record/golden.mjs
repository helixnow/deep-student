#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseExact, stringifyExact } from './json.mjs';
import { goldenResults } from './replay.mjs';
const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('usage: golden.mjs <output.json> <replay-report.json>...');
const reports = await Promise.all(inputs.map(async file => parseExact(await readFile(file, 'utf8'))));
await writeFile(output, stringifyExact(goldenResults(reports), 2) + '\n');
