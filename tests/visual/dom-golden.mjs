#!/usr/bin/env node
/**
 * FE-A1 layer 2 — DOM golden of the key views on fixed fixtures (the production demo build).
 *
 *   node tests/visual/dom-golden.mjs [--check] [--scenes a,b] [--dist DIR | --base URL] [--retries N] [--build]
 *   node tests/visual/dom-golden.mjs --update
 *
 * 17 scenes × desktop 1440×900 | mobile 390×844, light theme; the structural serialisation is
 * src/ui-plugins/testing/dom-snapshot.ts. Goldens: tests/visual/__golden__/dom/<platform>/<scene>.<viewport>.txt
 * (per platform: virtualised lists and measured layouts render different node counts per font stack).
 * On a mismatch the actual file lands in tests/visual/.out/dom/ and a diff is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { serializeDom } from '../../src/ui-plugins/testing/dom-snapshot.ts';
import { newScenePage } from './lib/page.mjs';
import { goldenRoot, outRoot, parseLayerArgs, platformKey, repoRoot, showDiff, startDemo, writeFile } from './lib/runner.mjs';
import { DOM_SCENES, openScene } from './lib/scenes.mjs';

const VIEWPORTS = ['desktop', 'mobile'];

export async function captureDom(browser, base, scene, viewport) {
  const { context, page, errors } = await newScenePage(browser, { viewport });
  try {
    const ready = await openScene(page, base, scene);
    const dom = await page.evaluate(([source]) => {
      // eslint-disable-next-line no-new-func
      const serialize = new Function(`return (${source})`)();
      return serialize(document, {});
    }, [serializeDom.toString()]);
    return { dom, ready, errors };
  } finally {
    await context.close();
  }
}

async function main() {
  const opts = parseLayerArgs(process.argv.slice(2));
  const platform = platformKey();
  const goldenDir = path.join(goldenRoot, 'dom', platform);
  const actualDir = path.join(outRoot, 'dom', platform);
  const scenes = DOM_SCENES.filter((scene) => !opts.scenes || opts.scenes.has(scene.id));
  const demo = await startDemo(opts);
  const failures = [];
  let flaky = 0;
  try {
    for (const scene of scenes) {
      for (const viewport of VIEWPORTS) {
        const name = `${scene.id}.${viewport}.txt`;
        const goldenFile = path.join(goldenDir, name);
        const actualFile = path.join(actualDir, name);
        let attempt = 0;
        let result;
        let matches = false;
        do {
          result = await captureDom(demo.browser, demo.base, scene, viewport);
          if (opts.mode === 'update') break;
          matches = fs.existsSync(goldenFile) && fs.readFileSync(goldenFile, 'utf8') === result.dom;
        } while (!matches && attempt++ < opts.retries);
        if (!result.ready) failures.push(`${name}: scene never became ready`);
        if (result.errors.length) failures.push(`${name}: ${result.errors[0]}`);
        if (opts.mode === 'update') {
          writeFile(goldenFile, result.dom);
          console.log(`  wrote ${path.relative(repoRoot, goldenFile)} (${result.dom.split('\n').length - 1} lines)`);
          continue;
        }
        if (!fs.existsSync(goldenFile)) {
          failures.push(`${name}: no golden for platform ${platform}; generate with --update on the baseline commit`);
          continue;
        }
        if (matches) {
          if (attempt > 0) flaky++;
          console.log(`  ✓ ${name}${attempt > 0 ? ` (matched on retry ${attempt})` : ''}`);
          continue;
        }
        writeFile(actualFile, result.dom);
        failures.push(`${name}: DOM differs from golden`);
        console.log(`  ✗ ${name}`);
        showDiff(goldenFile, actualFile);
      }
    }
  } finally {
    await demo.close();
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  console.log(`[dom-golden] ${opts.mode} ${failures.length ? 'FAILED' : 'passed'} (${platform}, ${scenes.length * VIEWPORTS.length} snapshots${flaky ? `, ${flaky} needed a retry` : ''})`);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
