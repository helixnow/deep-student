import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractFeatures, hostRegistrations } from '../lib/ipc.mjs';

const docs = {
  'A.json': {
    commands: [],
    $defs: {
      Cfg: {
        type: 'object', additionalProperties: false, required: ['params', 'note'],
        properties: {
          params: { type: 'array', items: { type: 'number', 'x-float': 'f32' } },
          note: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-option': 'null' },
          root: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-option': 'omit' },
          at: { type: 'string', format: 'date-time' },
          size: { type: 'integer', 'x-int': 'u64' },
          map: { type: 'object', additionalProperties: { $ref: '_shared.json#/$defs/S' }, 'x-key-order': 'unspecified' },
          self: { anyOf: [{ $ref: '#/$defs/Cfg' }, { type: 'null' }], 'x-option': 'null' },
        },
      },
    },
  },
  '_shared.json': { $defs: { S: { type: 'object', additionalProperties: false, properties: { v: { type: 'number', 'x-float': 'f32' } }, required: ['v'] } } },
};

test('contractFeatures：沿 $ref（含跨文件、递归）收集 f32 / Option / u64 / HashMap / date-time 路径', () => {
  const f = contractFeatures({ $ref: '#/$defs/Cfg' }, 'A.json', docs);
  assert.deepEqual(f.get('f32'), ['.params[]', '.map{}.v']);
  assert.deepEqual(f.get('option-null'), ['.note', '.self']);
  assert.deepEqual(f.get('option-omit'), ['.root']);
  assert.deepEqual(f.get('chrono'), ['.at']);
  assert.deepEqual(f.get('bigint'), ['.size']);
  assert.deepEqual(f.get('hashmap'), ['.map']);
});

test('hostRegistrations：引号包围的命令名在宿主插件源码中的首个位置', () => {
  const sources = new Map([
    ['host/plugins/b/index.ts', "const x = 1;\nregister('cloud_config_ssot_get', handler);\n"],
    ['host/plugins/a/index.ts', 'commands: {\n  "fsrs_rate": rate,\n}\n'],
  ]);
  const reg = hostRegistrations(['cloud_config_ssot_get', 'fsrs_rate', 'missing_cmd'], sources);
  assert.deepEqual(reg.get('cloud_config_ssot_get'), { file: 'host/plugins/b/index.ts', line: 2 });
  assert.deepEqual(reg.get('fsrs_rate'), { file: 'host/plugins/a/index.ts', line: 2 });
  assert.equal(reg.get('missing_cmd'), undefined);
});
