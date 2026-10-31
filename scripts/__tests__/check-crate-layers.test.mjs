import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkLayers } from '../check-crate-layers.mjs';

// 构造最小 cargo metadata：packages + workspace_members + resolve.nodes。
function metadata(members, extra = []) {
  const packages = [...members, ...extra].map((p) => ({
    id: `${p.name}-id`,
    name: p.name,
    version: p.version ?? '0.0.0',
    publish: p.publish === undefined ? [] : p.publish,
    metadata: p.layer ? { dstu: { layer: p.layer } } : null,
    dependencies: (p.deps ?? []).map((d) => (typeof d === 'string' ? { name: d, kind: null } : d)),
  }));
  return {
    packages,
    workspace_members: members.map((p) => `${p.name}-id`),
    resolve: {
      nodes: packages.map((p) => ({
        id: p.id,
        deps: p.dependencies.map((d) => ({ pkg: `${d.name}-id`, dep_kinds: [{ kind: d.kind }] })),
      })),
    },
  };
}

const app = { name: 'deep-student', version: '0.10.10', publish: null };

test('accepts downward dependencies and same-layer infrastructure', () => {
  const result = checkLayers(metadata([
    app,
    { name: 'dstu-core', layer: 'core' },
    { name: 'dstu-util', layer: 'base', deps: ['dstu-core'] },
    { name: 'dstu-security', layer: 'base', deps: ['dstu-core', 'dstu-util'] },
    { name: 'dstu-anki', layer: 'domain', deps: ['dstu-core', 'dstu-util'] },
  ]));
  assert.deepEqual(result.problems, []);
});

test('rejects upward, domain-to-domain and agent-to-domain dependencies', () => {
  const result = checkLayers(metadata([
    app,
    { name: 'dstu-core', layer: 'core', deps: ['dstu-util'] },
    { name: 'dstu-util', layer: 'base' },
    { name: 'dstu-anki', layer: 'domain', deps: ['dstu-qbank'] },
    { name: 'dstu-qbank', layer: 'domain' },
    { name: 'dstu-agent', layer: 'agent', deps: ['dstu-anki'] },
  ]));
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /dstu-core\(core\) -> dstu-util\(base\): 依赖了更高层/);
  assert.match(result.problems[1], /dstu-anki\(domain\) -> dstu-qbank\(domain\)/);
});

test('agent depending on domain is an upward dependency', () => {
  const result = checkLayers(metadata([
    app,
    { name: 'dstu-anki', layer: 'domain' },
    { name: 'dstu-agent', layer: 'agent', deps: ['dstu-anki'] },
  ]));
  assert.deepEqual(result.problems, []);
  const inverted = checkLayers(metadata([
    app,
    { name: 'dstu-agent', layer: 'agent' },
    { name: 'dstu-anki', layer: 'domain', deps: ['dstu-agent'] },
  ]));
  assert.match(inverted.problems[0], /dstu-anki\(domain\) -> dstu-agent\(agent\): 依赖了更高层/);
});

test('dev-dependencies are exempt from layering', () => {
  const result = checkLayers(metadata([
    app,
    { name: 'dstu-core', layer: 'core', deps: [{ name: 'dstu-util', kind: 'dev' }] },
    { name: 'dstu-util', layer: 'base' },
  ]));
  assert.deepEqual(result.problems, []);
});

test('enforces member naming, version, publish and layer metadata', () => {
  const result = checkLayers(metadata([
    app,
    { name: 'helper', layer: 'base' },
    { name: 'dstu-x', version: '1.2.3', publish: null },
    { name: 'dstu-y', layer: 'nope' },
  ]));
  assert.ok(result.problems.some((p) => /helper: 成员 crate 必须以 dstu- 开头/.test(p)));
  assert.ok(result.problems.some((p) => /dstu-x: version 必须为 0\.0\.0/.test(p)));
  assert.ok(result.problems.some((p) => /dstu-x: 必须设置 publish = false/.test(p)));
  assert.ok(result.problems.some((p) => /dstu-x: \[package\.metadata\.dstu\] layer 缺失/.test(p)));
  assert.ok(result.problems.some((p) => /dstu-y: \[package\.metadata\.dstu\] layer 缺失或无效（nope）/.test(p)));
});

test('members must not depend on the app package', () => {
  const result = checkLayers(metadata([app, { name: 'dstu-core', layer: 'core', deps: ['deep-student'] }]));
  assert.match(result.problems[0], /dstu-core -> deep-student: 成员不得依赖 app 包/);
});

test('dstu-core must not reach tauri through normal dependencies', () => {
  const result = checkLayers(metadata(
    [app, { name: 'dstu-core', layer: 'core', deps: ['some-lib'] }],
    [{ name: 'some-lib', deps: ['tauri'] }, { name: 'tauri' }],
  ));
  assert.match(result.problems[0], /dstu-core 的依赖闭包包含 tauri（经由 some-lib）/);
});
