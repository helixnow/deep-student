import { expect, it } from 'vitest';
import { mindmapOperationToAgentOp, mindmapOpLabel, applyMindmapOperation } from '../src/tools/mindmap-operations.ts';

it('mindmap_operation_to_agent_op_shapes', () => {
  const add = mindmapOperationToAgentOp({ type: 'add_node', parent_id: 'n1', data: { text: '新子节点' }, index: 0 });
  expect(add).toMatchObject({ kind: 'add_node', destructive: false, anchor: { parent_id: 'n1' }, payload: { data: { text: '新子节点' }, index: 0 } });
  expect(add.label).toContain('添加节点');
  const update = mindmapOperationToAgentOp({ type: 'update_node', node_id: 'n2', patch: { text: '改名', completed: true } });
  expect(update).toMatchObject({ kind: 'update_node', destructive: false, anchor: { node_id: 'n2' }, payload: { patch: { text: '改名' } } });
  expect(update.anchor).not.toHaveProperty('parent_id');
  const remove = mindmapOperationToAgentOp({ type: 'delete_node', node_id: 'n3' });
  expect(remove).toMatchObject({ kind: 'delete_node', destructive: true, anchor: { node_id: 'n3' }, payload: {} });
  expect(Object.keys(remove.payload)).toHaveLength(0);
  const move = mindmapOperationToAgentOp({ type: 'move_node', node_id: 'n4', new_parent_id: 'n5', index: 2 });
  expect(move).toMatchObject({ kind: 'move_node', destructive: true, anchor: { node_id: 'n4', new_parent_id: 'n5' }, payload: { index: 2 } });
  expect(move.label).toContain('移动节点');
});
it('mindmap_op_label_chinese', () => {
  expect(mindmapOpLabel({ type: 'add_node', data: { text: '光合作用' } }, 'add_node')).toBe('添加节点「光合作用」');
  expect(mindmapOpLabel({ type: 'delete_node', node_id: 'abc' }, 'delete_node')).toBe('删除节点 abc');
});
it('clears invalidated blank ranges and merges style keys using the production operation dispatcher', () => {
  const doc = { root: { id: 'root', text: 'Old', blankedRanges: [[0, 2]], style: { color: 'red', fontWeight: 'bold' } } };
  applyMindmapOperation(doc, { type: 'update_node', node_id: 'root', patch: { text: 'New', style: { color: null, fontSize: 12 } } });
  expect(doc.root).not.toHaveProperty('blankedRanges'); expect(doc.root.style).toEqual({ fontWeight: 'bold', fontSize: 12 });
});
it('rejects moves into descendants before removal and assigns unique ids throughout added subtrees', () => {
  const doc = { root: { id: 'root', text: 'Root', children: [{ id: 'a', text: 'A', children: [{ id: 'b', text: 'B' }] }] } };
  expect(() => applyMindmapOperation(doc, { type: 'move_node', node_id: 'a', new_parent_id: 'b' })).toThrow("cannot move node 'a' into itself or its own descendant 'b'");
  expect(doc.root.children[0]!.children[0]!.id).toBe('b');
  applyMindmapOperation(doc, { type: 'add_node', parent_id: 'root', data: { id: 'a', text: 'Copy', children: [{ id: 'b', text: 'Copy child' }] } });
  expect(doc.root.children[1]!.id).toMatch(/^n_.{8}$/);
  expect(doc.root.children[1]!.children[0]!.id).toMatch(/^n_.{8}$/);
});
