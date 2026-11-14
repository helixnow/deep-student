import type { MindmapXmlNode, MindmapXmlParser } from './api.ts';
import { runWasmSync } from '../wasm/loader.ts';

interface FlatNode extends Omit<MindmapXmlNode, 'children'> { parent: number }

export const mindmapXml: MindmapXmlParser = {
  parse(text: string): MindmapXmlNode {
    const response = runWasmSync({ engine: 'xml', op: 'parse', text });
    if (response.ok !== true) throw new Error(String(response.message));
    // Pre-order list from the engine; rebuilt without recursion (any nesting depth).
    const nodes: MindmapXmlNode[] = [];
    for (const { parent, ...node } of response.nodes as FlatNode[]) {
      const built: MindmapXmlNode = { ...node, children: [] };
      if (parent >= 0) nodes[parent]!.children.push(built);
      nodes.push(built);
    }
    return nodes[0]!;
  },
};
