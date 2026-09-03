/**
 * Hand-rolled JSON Schema (draft-07) for GenerativeUIIntent.
 * 不依赖 zod-to-json-schema；块 type enum 来自已注册表，保证可序列化、可确定性导出。
 */

import '../blocks';
import { generativeUIRegistry } from '../registry';
import {
  GENERATIVE_LAYOUT_UNITS,
  GENERATIVE_UI_INTENT_VERSIONS,
  MAX_GENERATIVE_UI_BLOCKS,
} from '../schema';

export const GENERATIVE_UI_JSON_SCHEMA_ID = 'generative-ui-intent';

function registeredBlockTypes(): string[] {
  return [...generativeUIRegistry.keys()].sort();
}

/** 导出描述 GenerativeUIIntent 的 draft-07 JSON Schema 对象。 */
export function exportGenerativeUIJsonSchema(): Record<string, unknown> {
  const blockTypes = registeredBlockTypes();

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: GENERATIVE_UI_JSON_SCHEMA_ID,
    title: 'GenerativeUIIntent',
    type: 'object',
    required: ['blocks'],
    'x-registered-block-types': [...blockTypes],
    properties: {
      version: {
        type: 'string',
        enum: [...GENERATIVE_UI_INTENT_VERSIONS],
      },
      layout: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: {
            type: 'string',
            enum: ['stack', 'grid'],
          },
          columns: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
          },
        },
      },
      blocks: {
        type: 'array',
        maxItems: MAX_GENERATIVE_UI_BLOCKS,
        items: {
          type: 'object',
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              enum: [...blockTypes],
            },
            id: {
              type: 'string',
            },
            props: {
              type: 'object',
            },
            span: {
              type: 'integer',
              enum: [...GENERATIVE_LAYOUT_UNITS],
            },
          },
        },
      },
      meta: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  };
}
