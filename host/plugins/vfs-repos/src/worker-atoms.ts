/**
 * Number atoms (`JSON.rawJSON`, how serde_json arbitrary-precision numbers are held) cannot be
 * structured-cloned, so a worker result carries them beside the value as `[path, raw text]`
 * pairs and the receiving thread re-creates them in place. Plain numbers stay plain numbers.
 */
import { isNumberAtom } from '../../../platform/serde-compat/index.ts';

export type DetachedAtom = readonly [path: ReadonlyArray<string | number>, raw: string];

const nativeJson = JSON as typeof JSON & { rawJSON(text: string): unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function detachNumberAtoms(value: unknown): { value: unknown; atoms: DetachedAtom[] } {
  const atoms: DetachedAtom[] = [];
  const path: Array<string | number> = [];
  const walk = (node: unknown): unknown => {
    if (isNumberAtom(node)) {
      atoms.push([[...path], node.rawJSON]);
      return null;
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => {
        path.push(index);
        try { return walk(item); } finally { path.pop(); }
      });
    }
    if (isPlainObject(node)) {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => {
        path.push(key);
        try { return [key, walk(item)]; } finally { path.pop(); }
      }));
    }
    return node;
  };
  return { value: walk(value), atoms };
}

export function attachNumberAtoms(value: unknown, atoms: readonly DetachedAtom[]): unknown {
  let root = value;
  for (const [path, raw] of atoms) {
    const atom = nativeJson.rawJSON(raw);
    if (path.length === 0) {
      root = atom;
      continue;
    }
    let parent = root as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    Object.defineProperty(parent, path[path.length - 1]!, {
      value: atom, writable: true, enumerable: true, configurable: true,
    });
  }
  return root;
}
