/** builtin_resource_executor.rs:4783-4859,5161-5501. */
import { takeChars } from '../../../../platform/util/portable.ts';
import { nanoid } from '../nanoid.ts';
import { recordOf, valueString } from './mindmap-document.ts';
type ObjectValue = Record<string, unknown>;

/** `util.isDeepStrictEqual`（JSON 友好数据）：原始值按 `Object.is`，数组与同原型对象按自有键递归。 */
function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    if (left.length !== other.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!isDeepStrictEqual(left[index], other[index])) return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key)
    && isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

const children = (node: unknown): unknown[] => { const value = recordOf(node)?.children; return Array.isArray(value) ? value : []; };
const fail = (message: string): never => { throw new Error(message); };
export function mindmapOpLabel(value: unknown, kind: string): string {
  const op = recordOf(value), id = valueString(op?.node_id) ?? '?';
  switch (kind) {
    case 'add_node': return `添加节点「${takeChars(valueString(recordOf(op?.data)?.text) ?? '新节点', 24)}」`;
    case 'update_node': { const text = valueString(recordOf(op?.patch)?.text); return text === null ? `更新节点 ${id}` : `更新节点「${takeChars(text, 24)}」`; }
    case 'delete_node': return `删除节点 ${id}`;
    case 'move_node': return `移动节点 ${id} → ${valueString(op?.new_parent_id) ?? '?'}`;
    default: return `导图操作 ${kind}`;
  }
}
export function mindmapOperationToAgentOp(value: unknown) {
  const op = recordOf(value), kind = valueString(op?.type) ?? 'unknown', anchor: ObjectValue = {}, payload: ObjectValue = {};
  for (const key of ['node_id', 'parent_id', 'new_parent_id']) if (op?.[key] != null) anchor[key] = structuredClone(op[key]);
  for (const key of ['patch', 'data', 'index']) if (op?.[key] != null) payload[key] = structuredClone(op[key]);
  return { kind, anchor: Object.keys(anchor).length === 0 ? null : anchor, payload,
    destructive: kind === 'delete_node' || kind === 'move_node', label: mindmapOpLabel(op, kind) };
}
function findNode(value: unknown, id: string): ObjectValue | null {
  const node = recordOf(value);
  if (node?.id === id) return node;
  for (const child of children(value)) { const found = findNode(child, id); if (found !== null) return found; }
  return null;
}
function removeChild(value: unknown, id: string): ObjectValue | null {
  const list = children(value), index = list.findIndex(child => recordOf(child)?.id === id);
  if (index >= 0) return recordOf(list.splice(index, 1)[0]);
  for (const child of list) { const removed = removeChild(child, id); if (removed !== null) return removed; }
  return null;
}
function collectIds(value: unknown, ids: Set<string>): void {
  const id = valueString(recordOf(value)?.id); if (id !== null) ids.add(id);
  for (const child of children(value)) collectIds(child, ids);
}
function uniqueSubtree(value: unknown, ids: Set<string>): ObjectValue {
  // serde_json indexing turns null into an object and panics on other primitives.
  const node = value === null ? {} : recordOf(value);
  if (node === null) throw new TypeError('cannot index non-object mindmap node');
  let id = valueString(node.id);
  if (id === null || id === '' || ids.has(id)) { do { id = `n_${nanoid(8)}`; } while (ids.has(id)); }
  ids.add(id); node.id = id;
  if (!Object.hasOwn(node, 'children')) node.children = [];
  if (Array.isArray(node.children)) node.children = node.children.map(child => uniqueSubtree(child, ids));
  return node;
}
function applyPatch(node: ObjectValue, value: unknown): void {
  const patch = recordOf(value); if (patch === null) return;
  const changed = Object.hasOwn(patch, 'text') && !isDeepStrictEqual(node.text, patch.text);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'style') {
      const style = recordOf(value); if (style === null) continue;
      const existing = Object.hasOwn(node, 'style') ? structuredClone(node.style) : {}, merged = recordOf(existing);
      if (merged !== null) for (const [key, value] of Object.entries(style)) { if (value === null) delete merged[key]; else merged[key] = structuredClone(value); }
      node.style = existing;
    } else node[key] = structuredClone(value);
  }
  if (changed && !Object.hasOwn(patch, 'blankedRanges')) delete node.blankedRanges;
}
export function applyMindmapOperation(value: unknown, rawOp: unknown): void {
  const doc = recordOf(value), op = recordOf(rawOp), kind = valueString(op?.type) ?? '';
  const string = (key: string) => valueString(op?.[key]) ?? fail(`${kind}: missing '${key}'`);
  const field = (key: string) => op !== null && Object.hasOwn(op, key) ? op[key] : fail(`${kind}: missing '${key}'`);
  const root = () => doc !== null && Object.hasOwn(doc, 'root') ? doc.root : fail("Document has no 'root' node");
  const index = typeof op?.index === 'number' && Number.isInteger(op.index) && op.index >= 0 && op.index < 2 ** 64 ? op.index : null;
  const insert = (parent: ObjectValue, child: ObjectValue, error: string) => {
    if (!Object.hasOwn(parent, 'children')) parent.children = [];
    if (!Array.isArray(parent.children)) fail(error);
    (parent.children as unknown[]).splice(index === null ? (parent.children as unknown[]).length : Math.min(index, (parent.children as unknown[]).length), 0, child);
  };
  switch (kind) {
    case 'update_node': {
      const id = string('node_id'), patch = field('patch');
      const node = findNode(root(), id) ?? fail(`update_node: node '${id}' not found`); applyPatch(node, patch); return;
    }
    case 'add_node': {
      const id = string('parent_id'), data = structuredClone(field('data')), currentRoot = root(), ids = new Set<string>();
      collectIds(currentRoot, ids); const node = uniqueSubtree(data, ids);
      const parent = findNode(currentRoot, id) ?? fail(`add_node: parent '${id}' not found`);
      insert(parent, node, "add_node: parent 'children' is not an array"); return;
    }
    case 'delete_node': {
      const id = string('node_id');
      if (recordOf(doc?.root)?.id === id) fail('delete_node: cannot delete root node');
      if (removeChild(root(), id) === null) fail(`delete_node: node '${id}' not found`); return;
    }
    case 'move_node': {
      const id = string('node_id'), parentId = string('new_parent_id');
      if (recordOf(doc?.root)?.id === id) fail('move_node: cannot move root node');
      const currentRoot = root(), moving = findNode(currentRoot, id) ?? fail(`move_node: node '${id}' not found`);
      if (id === parentId || findNode(moving, parentId) !== null) fail(`move_node: cannot move node '${id}' into itself or its own descendant '${parentId}'`);
      if (findNode(currentRoot, parentId) === null) fail(`move_node: new parent '${parentId}' not found`);
      const removed = removeChild(currentRoot, id) ?? fail(`move_node: node '${id}' not found`);
      const parent = findNode(currentRoot, parentId) ?? fail(`move_node: new parent '${parentId}' not found`);
      insert(parent, removed, "move_node: new parent 'children' is not an array"); return;
    }
    default: fail(`Unknown operation type: '${kind}'`);
  }
}
