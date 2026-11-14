/**
 * 内存版 OPFS，行为按 Chromium 148 Worker 中实测结果（mobile/tests/files-opfs.spec.ts 在真实浏览器上跑同一套一致性用例）：
 * - 文件句柄有 `move()`，覆盖同名文件；目录句柄没有 `move()`（`withDirectoryMove` 可打开，模拟其他引擎）；
 * - 同步访问句柄独占（第二个抛 `NoModificationAllowedError`），持有期间 `getFile()` 仍可读；
 * - 类型不符 `TypeMismatchError`，不存在 `NotFoundError`，非空目录非递归删除 `InvalidModificationError`，
 *   名称含 `/`、为 `.` / `..` / 空串时 `TypeError`；
 * - `withoutSyncAccess` 模拟主线程（没有 `createSyncAccessHandle`），`withoutFileMove` 模拟没有 `move()` 的引擎。
 */
import type { OpfsDirectoryHandle, OpfsFile, OpfsFileHandle, OpfsSyncAccessHandle } from '../../opfs.ts';

export interface FakeOpfsOptions {
  readonly withDirectoryMove?: boolean;
  readonly withoutSyncAccess?: boolean;
  readonly withoutFileMove?: boolean;
  /** 单个文件超过该字节数时 `write` 抛 `QuotaExceededError`。 */
  readonly quotaBytes?: number;
}

interface FileNode { kind: 'file'; data: Uint8Array; lastModified: number; locked: boolean }
interface DirNode { kind: 'directory'; children: Map<string, FileNode | DirNode> }

const domError = (name: string, message: string) => new DOMException(message, name);

function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`Name is not allowed: ${JSON.stringify(name)}`);
  }
}

let clock = 1_700_000_000_000;

export function createFakeOpfs(options: FakeOpfsOptions = {}): OpfsDirectoryHandle {
  const root: DirNode = { kind: 'directory', children: new Map() };

  /** 句柄记住父目录与名称；节点被移走或删除后再用它会得到 `NotFoundError`。 */
  function fileHandle(parent: DirNode, name: string): OpfsFileHandle {
    let currentParent = parent;
    let currentName = name;
    const node = (): FileNode => {
      const found = currentParent.children.get(currentName);
      if (found?.kind !== 'file') throw domError('NotFoundError', 'file was removed');
      return found;
    };
    const handle: OpfsFileHandle = {
      kind: 'file',
      get name() {
        return currentName;
      },
      async getFile(): Promise<OpfsFile> {
        const snapshot = node();
        const data = snapshot.data.slice();
        return {
          size: data.length,
          lastModified: snapshot.lastModified,
          slice: (start = 0, end = data.length) => ({ arrayBuffer: async () => data.slice(start, end).buffer }),
        };
      },
    };
    if (!options.withoutSyncAccess) {
      handle.createSyncAccessHandle = async (): Promise<OpfsSyncAccessHandle> => {
        const target = node();
        if (target.locked) throw domError('NoModificationAllowedError', 'Access Handles cannot be created if there is another open Access Handle');
        target.locked = true;
        let open = true;
        const live = (): FileNode => {
          if (!open) throw domError('InvalidStateError', 'handle is closed');
          return target;
        };
        return {
          read(buffer, at = {}) {
            const file = live();
            const chunk = file.data.subarray(Math.min(at.at ?? 0, file.data.length), Math.min((at.at ?? 0) + buffer.length, file.data.length));
            buffer.set(chunk);
            return chunk.length;
          },
          write(buffer, at = {}) {
            const file = live();
            const offset = at.at ?? 0;
            const size = Math.max(file.data.length, offset + buffer.length);
            if (options.quotaBytes !== undefined && size > options.quotaBytes) throw domError('QuotaExceededError', 'quota exceeded');
            const next = new Uint8Array(size);
            next.set(file.data);
            next.set(buffer, offset);
            file.data = next;
            file.lastModified = ++clock;
            return buffer.length;
          },
          truncate(size) {
            const file = live();
            if (options.quotaBytes !== undefined && size > options.quotaBytes) throw domError('QuotaExceededError', 'quota exceeded');
            const next = new Uint8Array(size);
            next.set(file.data.subarray(0, size));
            file.data = next;
            file.lastModified = ++clock;
          },
          getSize: () => live().data.length,
          flush() {
            live();
          },
          close() {
            if (open) target.locked = false;
            open = false;
          },
        };
      };
    }
    if (!options.withoutFileMove) {
      handle.move = async (destination, newName) => {
        checkName(newName);
        const source = node();
        if (source.locked) throw domError('NoModificationAllowedError', 'file is locked');
        const destNode = dirNodes.get(destination);
        if (destNode === undefined) throw domError('NotFoundError', 'destination was removed');
        const existing = destNode.children.get(newName);
        if (existing?.kind === 'directory') throw domError('InvalidModificationError', 'cannot replace a directory');
        if (existing?.kind === 'file' && existing.locked) throw domError('NoModificationAllowedError', 'destination is locked');
        currentParent.children.delete(currentName);
        destNode.children.set(newName, source);
        currentParent = destNode;
        currentName = newName;
      };
    }
    return handle;
  }

  const dirNodes = new WeakMap<OpfsDirectoryHandle, DirNode>();

  function dirHandle(node: DirNode, name: string, parent: DirNode | null): OpfsDirectoryHandle {
    let currentParent = parent;
    let currentName = name;
    const handle: OpfsDirectoryHandle = {
      kind: 'directory',
      get name() {
        return currentName;
      },
      async getDirectoryHandle(childName, { create = false } = {}) {
        checkName(childName);
        const existing = node.children.get(childName);
        if (existing?.kind === 'file') throw domError('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.');
        if (existing?.kind === 'directory') return dirHandle(existing, childName, node);
        if (!create) throw domError('NotFoundError', 'A requested file or directory could not be found');
        const created: DirNode = { kind: 'directory', children: new Map() };
        node.children.set(childName, created);
        return dirHandle(created, childName, node);
      },
      async getFileHandle(childName, { create = false } = {}) {
        checkName(childName);
        const existing = node.children.get(childName);
        if (existing?.kind === 'directory') throw domError('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.');
        if (existing === undefined) {
          if (!create) throw domError('NotFoundError', 'A requested file or directory could not be found');
          node.children.set(childName, { kind: 'file', data: new Uint8Array(), lastModified: ++clock, locked: false });
        }
        return fileHandle(node, childName);
      },
      async removeEntry(childName, { recursive = false } = {}) {
        checkName(childName);
        const existing = node.children.get(childName);
        if (existing === undefined) throw domError('NotFoundError', 'A requested file or directory could not be found');
        if (existing.kind === 'directory' && existing.children.size > 0 && !recursive) {
          throw domError('InvalidModificationError', 'The object can not be modified in this way.');
        }
        if (existing.kind === 'file' && existing.locked) throw domError('NoModificationAllowedError', 'file is locked');
        node.children.delete(childName);
      },
      async *entries() {
        for (const [childName, childNode] of [...node.children]) {
          yield [childName, childNode.kind === 'file' ? fileHandle(node, childName) : dirHandle(childNode, childName, node)] as [string, OpfsFileHandle | OpfsDirectoryHandle];
        }
      },
    };
    if (options.withDirectoryMove) {
      handle.move = async (destination, newName) => {
        checkName(newName);
        if (currentParent === null) throw domError('InvalidModificationError', 'cannot move the root');
        const destNode = dirNodes.get(destination);
        if (destNode === undefined) throw domError('NotFoundError', 'destination was removed');
        if (destNode.children.has(newName)) throw domError('InvalidModificationError', 'destination exists');
        currentParent.children.delete(currentName);
        destNode.children.set(newName, node);
        currentParent = destNode;
        currentName = newName;
      };
    }
    dirNodes.set(handle, node);
    return handle;
  }

  return dirHandle(root, '', null);
}
