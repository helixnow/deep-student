import { describe, expect, it } from 'vitest';

import {
  parseConfigNumber,
  pluginConfigForm,
  pluginConfigValues,
  validatePluginConfig,
} from '../config-schema';
import type { PluginConfigSchemaNode } from '../types';

const schema: PluginConfigSchemaNode = {
  type: 'object',
  dict: {
    enabled: { type: 'boolean', meta: { default: true, description: 'enable the feature' } },
    mode: {
      type: 'union',
      list: [
        { type: 'const', value: 'fast' },
        { type: 'const', value: 'balanced', meta: { description: 'Balanced mode' } },
        { type: 'const', value: 'thorough' },
      ],
      meta: { default: 'balanced' },
    },
    endpoint: { type: 'string', meta: { default: 'https://example.test', pattern: '^https://' } },
    retries: { type: 'number', meta: { default: 3, min: 0, max: 10, step: 1 } },
    tags: { type: 'array' },
    nested: { type: 'object', dict: { a: { type: 'string' } } },
    mixed: { type: 'union', list: [{ type: 'const', value: 'a' }, { type: 'string' }] },
    secretName: { type: 'string', meta: { required: true } },
  },
};

describe('pluginConfigForm', () => {
  it('maps boolean → switch, enum union → options, string / number → inputs', () => {
    const form = pluginConfigForm(schema);

    expect(form.fields.map((field) => [field.key, field.kind])).toEqual([
      ['enabled', 'boolean'],
      ['mode', 'enum'],
      ['endpoint', 'string'],
      ['retries', 'number'],
      ['secretName', 'string'],
    ]);
    const mode = form.fields.find((field) => field.key === 'mode');
    expect(mode?.kind === 'enum' && mode.options).toEqual([
      { value: 'fast', label: 'fast' },
      { value: 'balanced', label: 'Balanced mode' },
      { value: 'thorough', label: 'thorough' },
    ]);
    expect(form.unsupported).toEqual(['tags', 'nested', 'mixed']);
  });

  it('reads defaults and bounds from the serialized meta', () => {
    const form = pluginConfigForm(schema);
    const enabled = form.fields.find((field) => field.key === 'enabled');
    const retries = form.fields.find((field) => field.key === 'retries');
    const secretName = form.fields.find((field) => field.key === 'secretName');

    expect(enabled).toMatchObject({ kind: 'boolean', defaultValue: true, description: 'enable the feature' });
    expect(retries).toMatchObject({ kind: 'number', defaultValue: 3, min: 0, max: 10, step: 1 });
    expect(secretName).toMatchObject({ kind: 'string', required: true });
  });

  it('returns an empty form for plugins without Config and flags a non-object root', () => {
    expect(pluginConfigForm(null).fields).toEqual([]);
    expect(pluginConfigForm(undefined).unsupported).toEqual([]);
    expect(pluginConfigForm({ type: 'string' })).toEqual({ fields: [], unsupported: ['$'] });
  });

  it('fills defaults without dropping Host values the form cannot render', () => {
    const form = pluginConfigForm(schema);

    const values = pluginConfigValues(form, { retries: 7, tags: ['x'], custom: { keep: true } });

    expect(values).toMatchObject({
      enabled: true,
      mode: 'balanced',
      endpoint: 'https://example.test',
      retries: 7,
      tags: ['x'],
      custom: { keep: true },
    });
    expect('secretName' in values).toBe(false);
  });
});

describe('validatePluginConfig', () => {
  it('accepts a valid configuration', () => {
    const form = pluginConfigForm(schema);
    const values = pluginConfigValues(form, { secretName: 'token' });

    expect(validatePluginConfig(form, values)).toEqual([]);
  });

  it('reports required, type, range, enum and pattern problems per field', () => {
    const form = pluginConfigForm(schema);
    const issues = validatePluginConfig(form, {
      enabled: 'yes',
      mode: 'impossible',
      endpoint: 'http://insecure.test',
      retries: 42,
      secretName: '',
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        { field: 'enabled', rule: 'boolean' },
        { field: 'mode', rule: 'enum' },
        { field: 'endpoint', rule: 'pattern' },
        { field: 'retries', rule: 'range' },
        { field: 'secretName', rule: 'required' },
      ]),
    );
    expect(issues).toHaveLength(5);
  });

  it('treats non-finite numbers and wrong value types as errors', () => {
    const form = pluginConfigForm({
      type: 'object',
      dict: { count: { type: 'number' }, label: { type: 'string' } },
    });

    expect(validatePluginConfig(form, { count: Number.NaN, label: 3 })).toEqual([
      { field: 'count', rule: 'number' },
      { field: 'label', rule: 'string' },
    ]);
  });
});

describe('parseConfigNumber', () => {
  it('parses finite numbers, treats empty input as unset and invalid input as null', () => {
    expect(parseConfigNumber(' 3.5 ')).toBe(3.5);
    expect(parseConfigNumber('')).toBeUndefined();
    expect(parseConfigNumber('   ')).toBeUndefined();
    expect(parseConfigNumber('abc')).toBeNull();
    expect(parseConfigNumber('Infinity')).toBeNull();
  });
});
