/**
 * Summarise a V8 `.heapsnapshot`: total self size, top groups by `type:constructor`, and the Host plugin
 * that owns each JS closure (by its script path under `host/plugins/<id>/` or `host/platform/<id>/`).
 *
 *   node host/e2e/smoke/__tests__/support/heap-summary.ts <file.heapsnapshot> [more…] [--top=N]
 */
import { readFileSync } from 'node:fs';

interface Snapshot {
  snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]]; edge_fields: string[]; edge_types: [string[], ...unknown[]] } };
  nodes: number[];
  edges: number[];
  strings: string[];
}

export interface HeapSummary {
  file: string;
  totalMB: number;
  nodes: number;
  byType: Record<string, number>;
  topGroups: Array<{ group: string; count: number; selfMB: number }>;
  /** Self size of closures and their shared function info, by owning plugin / platform module. */
  byOwner: Array<{ owner: string; closures: number; selfMB: number }>;
  /** Source text V8 keeps for loaded scripts, by owning plugin / platform module / package. */
  sourceByOwner: Array<{ owner: string; scripts: number; sourceMB: number }>;
  /** Largest string payloads (≥ 64 KiB) as `length@prefix`. */
  bigStrings: Array<{ kb: number; prefix: string }>;
}

const MB = (bytes: number) => Math.round(bytes / 1024 / 102.4) / 10;

function ownerOf(script: string): string {
  const m = /(host\/(?:plugins|platform|kernel)\/[^/]+)/.exec(script.replaceAll('\\', '/'));
  if (m) return m[1]!;
  if (/node_modules\/((?:@[^/]+\/)?[^/]+)/.test(script)) return `node_modules/${/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(script)![1]}`;
  if (script.startsWith('node:')) return 'node:*';
  return script === '' ? '(no script)' : '(other)';
}

export function summarizeHeap(file: string, top = 25): HeapSummary {
  const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  const { node_fields: nf, node_types: nt, edge_fields: ef, edge_types: et } = snap.snapshot.meta;
  const N = nf.length, E = ef.length;
  const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size'), iEdges = nf.indexOf('edge_count');
  const eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
  const types = nt[0], edgeTypes = et[0];
  const { nodes, edges, strings } = snap;
  const nodeCount = nodes.length / N;

  // First edge index of every node.
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let i = 0, e = 0; i < nodeCount; i++) { firstEdge[i] = e; e += nodes[i * N + iEdges]! * E; firstEdge[i + 1] = e; }
  const edgeTo = (ni: number, name: string): number | null => {
    for (let e = firstEdge[ni]!; e < firstEdge[ni + 1]!; e += E) {
      const t = edgeTypes[edges[e + eType]!];
      if ((t === 'internal' || t === 'property') && strings[edges[e + eName]!] === name) return edges[e + eTo]! / N;
    }
    return null;
  };

  let total = 0;
  const byType: Record<string, number> = {};
  const groups = new Map<string, { count: number; size: number }>();
  const owners = new Map<string, { closures: number; size: number }>();
  const bigStrings: Array<{ kb: number; prefix: string }> = [];
  const sources = new Map<string, { scripts: number; size: number }>();
  const seenSource = new Set<number>();
  for (let i = 0; i < nodeCount; i++) {
    const type = types[nodes[i * N + iType]!]!;
    const name = strings[nodes[i * N + iName]!] ?? '';
    const size = nodes[i * N + iSize]!;
    total += size;
    byType[type] = (byType[type] ?? 0) + size;
    const key = `${type}:${type === 'string' || type === 'concatenated string' || type === 'sliced string' ? '' : name.slice(0, 80)}`;
    const g = groups.get(key) ?? { count: 0, size: 0 };
    g.count += 1; g.size += size; groups.set(key, g);
    if ((type === 'string') && size >= 64 * 1024) bigStrings.push({ kb: Math.round(size / 1024), prefix: name.slice(0, 80) });
    if (type === 'code' && name.startsWith('system / Script')) {
      const source = edgeTo(i, 'source'), scriptName = edgeTo(i, 'name');
      if (source !== null && !seenSource.has(source)) {
        seenSource.add(source);
        const owner = ownerOf(scriptName === null ? '' : strings[nodes[scriptName * N + iName]!] ?? '');
        const s = sources.get(owner) ?? { scripts: 0, size: 0 };
        s.scripts += 1; s.size += nodes[source * N + iSize]!; sources.set(owner, s);
      }
    }
    if (type === 'closure') {
      const shared = edgeTo(i, 'shared');
      const script = shared === null ? null : edgeTo(shared, 'script');
      const scriptName = script === null ? null : edgeTo(script, 'name');
      const path = scriptName === null ? '' : strings[nodes[scriptName * N + iName]!] ?? '';
      const owner = ownerOf(path);
      const o = owners.get(owner) ?? { closures: 0, size: 0 };
      o.closures += 1; o.size += size + (shared === null ? 0 : nodes[shared * N + iSize]!); owners.set(owner, o);
    }
  }
  return {
    file, totalMB: MB(total), nodes: nodeCount,
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, MB(v)])),
    topGroups: [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, top)
      .map(([group, g]) => ({ group, count: g.count, selfMB: MB(g.size) })),
    byOwner: [...owners].sort((a, b) => b[1].size - a[1].size).slice(0, top)
      .map(([owner, o]) => ({ owner, closures: o.closures, selfMB: MB(o.size) })),
    sourceByOwner: [...sources].sort((a, b) => b[1].size - a[1].size).slice(0, top)
      .map(([owner, s]) => ({ owner, scripts: s.scripts, sourceMB: MB(s.size) })),
    bigStrings: bigStrings.sort((a, b) => b.kb - a.kb).slice(0, 10),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const top = Number(process.argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 25);
  for (const file of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    console.log(JSON.stringify(summarizeHeap(file, top), null, 1));
  }
}
