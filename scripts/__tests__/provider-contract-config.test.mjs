import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, '..', '..');

function read(relativePath) {
  return readFileSync(join(projectRoot, relativePath), 'utf8');
}

function yamlTopLevelSection(source, key, indent = 2) {
  const prefix = `${' '.repeat(indent)}${key}:\n`;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `missing YAML section: ${key}`);
  const remainder = source.slice(start + prefix.length);
  const next = remainder.search(new RegExp(`^ {${indent}}[A-Za-z0-9_-]+:\\s*$`, 'm'));
  return next === -1 ? remainder : remainder.slice(0, next);
}

test('provider contract is a fixed fail-closed CI job', () => {
  const workflow = read('.github/workflows/ci.yml');
  const job = yamlTopLevelSection(workflow, 'provider-contract');

  assert.match(job, /^\s{4}name: Cloud Provider Contract Gate$/m);
  assert.doesNotMatch(job, /continue-on-error:/);
  assert.match(job, /DS_SYNC_TEST_DOCKER: '1'/);
  assert.match(job, /config --images > "\$IMAGES_FILE"/);
  assert.match(job, /provider contract images must not use mutable latest tags/i);
  assert.match(
    job,
    /up --detach --build --wait --wait-timeout 180 minio webdav ftp/,
  );
  assert.match(job, /for service in minio webdav ftp; do/);
  assert.match(job, /State\.Health\.Status.*healthy/);

  assert.match(
    job,
    /cargo test --test sync_provider_contract_tests -- --ignored --list > "\$LIST_FILE"/,
  );
  assert.match(job, /for provider in webdav s3 ftp; do/);
  assert.match(
    job,
    /cargo test --test sync_provider_contract_tests -- --ignored --test-threads=1 --nocapture/,
  );
  assert.match(job, /Not every listed provider contract ran/);
  assert.match(job, /set -euo pipefail/);
});

test('canonical provider composition pins all services with healthchecks', () => {
  const compose = read('scripts/dev/docker-compose.sync-test.yml');
  const minio = yamlTopLevelSection(compose, 'minio');
  const webdav = yamlTopLevelSection(compose, 'webdav');
  const ftp = yamlTopLevelSection(compose, 'ftp');

  assert.match(minio, /image: minio\/minio:RELEASE\.[^\s]+/);
  assert.match(minio, /healthcheck:/);
  assert.match(minio, /\/minio\/health\/live/);

  assert.match(webdav, /image: bytemark\/webdav:2\.4/);
  assert.match(webdav, /healthcheck:/);
  assert.match(webdav, /wget .*127\.0\.0\.1/);

  assert.match(ftp, /image: deep-student-sync-test-ftp:pyftpdlib-2\.2\.0/);
  assert.match(ftp, /healthcheck:/);
  assert.match(ftp, /socket\.create_connection/);

  assert.doesNotMatch(compose, /image:\s+\S+:latest(?:\s|$)/);
  for (const port of ['9000', '9001', '8080', '2121']) {
    assert.match(compose, new RegExp(String.raw`"127\.0\.0\.1:${port}:`));
  }
});

test('compatibility composition delegates to the canonical source', () => {
  const compatibility = read('dstu-test/docker/docker-compose.sync-test.yml');
  assert.match(
    compatibility,
    /include:\s*\n\s+- path: \.\.\/\.\.\/scripts\/dev\/docker-compose\.sync-test\.yml/,
  );
  assert.doesNotMatch(compatibility, /^services:/m);
});
