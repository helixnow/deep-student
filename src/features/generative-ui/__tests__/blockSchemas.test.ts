import { describe, expect, it, vi } from 'vitest';

// Skeleton/schema callers must remain usable without evaluating any UI block.
vi.mock('../blocks', () => { throw new Error('Unexpected UI registration import'); });
vi.mock('../components/ChartBlock', () => { throw new Error('Unexpected chart renderer import'); });

import { validateArtifactSkeletonTypes } from '@/features/chat/skills/artifactSkeleton';
import { BUILTIN_GENERATIVE_BLOCK_SCHEMAS, registerBuiltinGenerativeSchemas } from '../blockSchemas';
import { generativeUIRegistry } from '../registry';
import { chartBlockPropsSchema } from '../schema';
import { exportGenerativeUIJsonSchema } from '../utils/exportGenerativeUIJsonSchema';

describe('schema-only built-in registration', () => {
  it('validates all built-in skeleton types and builds the catalog without renderers', () => {
    expect(BUILTIN_GENERATIVE_BLOCK_SCHEMAS).toHaveLength(18);
    expect(generativeUIRegistry.getAll()).toEqual([]);
    expect(validateArtifactSkeletonTypes({
      blocks: BUILTIN_GENERATIVE_BLOCK_SCHEMAS.map(({ type }) => ({ type })),
    })).toEqual({ valid: true, unknownTypes: [] });
    expect(validateArtifactSkeletonTypes({ blocks: [{ type: 'unknown-block' }] })).toEqual({
      valid: false, unknownTypes: ['unknown-block'],
    });
    expect(generativeUIRegistry.getCatalogForPrompt()).toHaveLength(18);
    expect(exportGenerativeUIJsonSchema()['x-registered-block-types']).toEqual(generativeUIRegistry.keys().sort());
  });

  it('keeps schema refinements available without importing their chart UI', () => {
    expect(chartBlockPropsSchema.safeParse({
      kind: 'line', categories: ['one'], series: [{ name: 'series', values: [1, 2] }],
    }).success).toBe(false);
    expect(chartBlockPropsSchema.safeParse({
      kind: 'line', categories: ['one'], series: [{ name: 'series', values: [1] }],
    }).success).toBe(true);
  });

  it('does not replace an already registered renderer when metadata is registered again', () => {
    const config = BUILTIN_GENERATIVE_BLOCK_SCHEMAS.find(({ type }) => type === 'chart')!;
    const component = () => null;
    generativeUIRegistry.register({ ...config, component });
    registerBuiltinGenerativeSchemas();
    expect(generativeUIRegistry.get('chart')?.component).toBe(component);
    expect(generativeUIRegistry.get('chart')?.propsSchema).toBe(chartBlockPropsSchema);
    generativeUIRegistry.unregister('chart');
    generativeUIRegistry.registerSchema(config);
  });
});
