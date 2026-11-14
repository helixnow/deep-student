import { expect, it } from 'vitest';
import { applyShellCommandSensitivity, enforceShellCommandPolicy } from '../api.ts';
import { parsePolicy } from '../src/tools/shell-policy.ts';

const rule = { id: 'r', effect: 'allow', match: { kind: 'prefix', value: 'echo' } };
const policy = (rules: unknown, extra: object = {}) => JSON.stringify({ version: 1, default_effect: 'allow', rules, ...extra });

// shell_command_policy.rs:44-69,92-96: serde defaults apply to absent fields, never to wrong types.
it.each([
  ['null rules', policy(null)],
  ['object rules', policy({})],
  ['null default effect', policy([], { default_effect: null })],
  ['unknown default effect', policy([], { default_effect: 'permit' })],
  ['missing effect', policy([{ id: 'r', match: rule.match }])],
  ['null effect', policy([{ ...rule, effect: null }])],
  ['unknown effect', policy([{ ...rule, effect: 'permit' }])],
  ['null enabled', policy([{ ...rule, enabled: null }])],
  ['string enabled', policy([{ ...rule, enabled: 'false' }])],
  ['number enabled', policy([{ ...rule, enabled: 1 }])],
  ['number note', policy([{ ...rule, note: 1 }])],
  ['object note', policy([{ ...rule, note: {} }])],
  ['missing id', policy([{ effect: 'allow', match: rule.match }])],
  ['missing match', policy([{ id: 'r', effect: 'allow' }])],
  ['null rule', policy([null])],
  ['unknown match kind', policy([{ ...rule, match: { kind: 'glob', value: '*' } }])],
  ['nonstring match value', policy([{ ...rule, match: { kind: 'prefix', value: 1 } }])],
  ['fractional version', '{"version":1.0}'],
  ['exponent version', '{"version":1e0}'],
  ['negative zero version', '{"version":-0}'],
  ['u8 overflow', '{"version":256}'],
  ['negative version', '{"version":-1}'],
])('invalid typed policy fails closed: %s', (_label, raw) => {
  expect(() => parsePolicy(raw)).toThrow();
  const decision = enforceShellCommandPolicy(raw, 'echo ready', true);
  expect(decision).toEqual({ configured_effect: 'ask', effective_effect: 'ask', matched_rule_id: null,
    matched_kind: null, protected: false, reason: 'matched_or_default_ask', config_valid: false });
  expect(applyShellCommandSensitivity(decision, 'low')).toBe('medium');
});

// JsonReader uses serde_json StrRead byte positions, not V8 JSON.parse diagnostics.
it.each([
  ['{"version":1,"rules":null}', 'invalid type: null, expected a sequence at line 1 column 25'],
  ['{"version":1,"rules":null,"later":', 'invalid type: null, expected a sequence at line 1 column 25'],
  ['{"version":1,"default_effect":"permit"}', 'unknown variant `permit`, expected one of `allow`, `ask`, `deny` at line 1 column 38'],
  ['{"version":1,"version":', 'duplicate field `version` at line 1 column 22'],
  ['{"version":256}', 'invalid value: integer `256`, expected u8 at line 1 column 14'],
  ['{"version":1.0}', 'invalid type: floating point `1.0`, expected u8 at line 1 column 14'],
  ['{"version":-0}', 'invalid type: floating point `-0.0`, expected u8 at line 1 column 13'],
  ['{}', 'missing field `version` at line 1 column 2'],
  ['{"version":1,"rules":[{"id":"r"}]}', 'missing field `effect` at line 1 column 32'],
  ['{"version":1,"rules":[{"id":"r","effect":"deny","match":{"kind":"exact","value":"x"},"enabled":null}]}',
    'invalid type: null, expected a boolean at line 1 column 99'],
  ['{"version":1,"rules":[{"id":"r","effect":"deny","match":{"kind":"exact","value":"x"},"note":2}]}',
    'invalid type: integer `2`, expected a string at line 1 column 93'],
  ['{\n"version":1, "备注":"长", "rules":null}', 'invalid type: null, expected a sequence at line 2 column 41'],
])('preserves typed error text/order for %s', (raw, expected) => {
  expect(() => parsePolicy(raw)).toThrowError(new Error(`invalid shell command policy JSON: ${expected}`));
});

it.each([
  '{"version":1,"default_effect":"allow","default_effect":"deny"}',
  '{"version":1,"rules":[],"rules":[]}',
  '{"version":1,"rules":[{"id":"r","id":"s","effect":"allow","match":["exact","echo ready"]}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","effect":"deny","match":["exact","echo ready"]}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","match":["exact","echo"],"match":["prefix","echo"]}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","match":["exact","echo ready"],"enabled":true,"enabled":false}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","match":["exact","echo ready"],"note":null,"note":null}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","match":{"kind":"exact","kind":"prefix","value":"echo"}}]}',
  '{"version":1,"rules":[{"id":"r","effect":"allow","match":{"kind":"exact","value":"echo","value":"echo ready"}}]}',
])('rejects duplicate known fields: %s', raw => {
  expect(() => parsePolicy(raw)).toThrow(/duplicate field/);
  expect(enforceShellCommandPolicy(raw, 'echo ready', true).config_valid).toBe(false);
});

it('retains defaults, Option null, ignored fields, sequence structs and unit-enum maps', () => {
  expect(parsePolicy('{"version":1}')).toEqual({ version: 1, default_effect: 'ask', rules: [] });
  expect(parsePolicy('[1]')).toEqual(parsePolicy('{"version":1}'));
  const mapped = parsePolicy('{"version":1,"default_effect":{"ask":null},"rules":[{"id":"r","effect":{"allow":null},"match":{"kind":{"prefix":null},"value":"echo"},"note":null}]}');
  expect(mapped.rules).toEqual([{ ...rule, enabled: true, note: null }]);
  expect(parsePolicy('[1,"ask",[["r","allow",["prefix","echo"]]]]')).toEqual(mapped);
  expect(parsePolicy('[1,"ask",[["r","allow",["prefix","echo"],false,"note"]]]').rules[0])
    .toEqual({ ...rule, enabled: false, note: 'note' });
  expect(parsePolicy('{"ignored":1e999,"ignored":{"x":"\\ud800"},"version":1}'))
    .toEqual({ version: 1, default_effect: 'ask', rules: [] });
  expect(enforceShellCommandPolicy(policy([rule]), 'echo ready', true)).toMatchObject({ config_valid: true, effective_effect: 'allow' });
  expect(enforceShellCommandPolicy(policy([{ ...rule, enabled: false }], { default_effect: 'ask' }), 'echo ready', true))
    .toMatchObject({ config_valid: true, effective_effect: 'ask', matched_rule_id: null });
});

it('validates after typed decoding and keeps domain errors unprefixed', () => {
  expect(() => parsePolicy('{"version":2}')).toThrowError(new Error('unsupported shell command policy version 2'));
  expect(() => parsePolicy(policy([{ ...rule, id: '' }]))).toThrowError(new Error('shell command rule id must contain 1..=128 bytes'));
  expect(() => parsePolicy('[1,"ask",[],0]')).toThrow(/trailing characters/);
  expect(() => parsePolicy('{"version":2,"rules":null}')).toThrow(/invalid shell command policy JSON: invalid type: null/);
});

// shell_command_policy.rs:145-149: char::is_whitespace, distinct from ECMAScript \s.
it.each([['\u0085', true], ['\ufeff', false], [' ', true], ['x', false]] as const)(
  'uses Rust prefix boundary U+%s', (separator, matched) => {
    const raw = policy([{ ...rule, effect: 'deny', match: { kind: 'prefix', value: 'git stat' } }], { default_effect: 'ask' });
    const decision = enforceShellCommandPolicy(raw, `git stat${separator}--short`, true);
    expect(decision.config_valid).toBe(true);
    expect(decision.matched_rule_id).toBe(matched ? 'r' : null);
    expect(decision.effective_effect).toBe(matched ? 'deny' : 'ask');
  },
);

// shell_command_policy.rs:224-231 `Path::parent`: trailing separators and `.` components left after the file name are
// dropped (std Components::trim_right), interior ones stay verbatim.
it.skipIf(process.platform === 'win32').each([
  ['/usr/bin/grep needle README.md', 'allow'],
  ['/usr/bin//grep needle README.md', 'allow'],
  ['/usr/bin/./grep needle README.md', 'allow'],
  ['/bin///ls -la', 'allow'],
  ['/usr//bin/grep needle README.md', 'ask'],
  ['/usr/./bin/grep needle README.md', 'ask'],
  ['/usr/bin/../bin/grep needle README.md', 'ask'],
])('trusted OS executable parent of %s is %s like Path::parent', (command, effect) => {
  expect(enforceShellCommandPolicy(policy([]), command, true).effective_effect).toBe(effect);
});
