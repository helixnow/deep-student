import { parseJsonDocument, type JsonNode, type JsonRawNumber } from '../../../platform/util/api.ts';

const nativeJson = JSON as typeof JSON & {
  rawJSON(source: string): JsonRawNumber;
  isRawJSON(value: unknown): boolean;
};

export const isRawNumber = (value: unknown): boolean => nativeJson.isRawJSON(value);

/** Keep source numeric tokens opaque until stringify. Never infer source digits
 * from an existing Number, or treat an ordinary { rawJSON } object as an atom.
 * F4 validates JSON; unlike Value serialization we retain -0/float spelling too.
 */
export function parseSourceJson(source: string): unknown {
  function project(node: JsonNode): unknown {
    switch (node.kind) {
      case 'null': return null;
      case 'bool': case 'string': return node.value;
      case 'number': return nativeJson.rawJSON(node.value.raw);
      case 'array': return node.items.map(project);
      case 'object': return Object.fromEntries(node.members.map(({ key, value }) => [key, project(value)]));
    }
  }
  return project(parseJsonDocument(source));
}
