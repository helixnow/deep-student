import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemoryConfig } from '../src/config.ts';
import {
  createFolder, createNote, folderExists, listFoldersByParent,
} from '../repository/vfs.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}
function configOf(service: MemoryServiceImpl): MemoryConfig {
  return service._config;
}

describe('nested memory root repair', () => {
  it('nested_duplicate_root_is_merged_back_on_first_root_lookup', async () => {
    const { host, db, deps } = await setup();
    const service = serviceOf(host);
    const config = configOf(service);

    const newFolder = (title: string, parent: string | null): string =>
      createFolder(deps, db, title, parent).id;
    const newNote = (title: string, folderId: string): string =>
      createNote(deps, db, { title, content: `${title} 内容`, tags: [] }, folderId).id;

    // Manufactured legacy corruption (not through the service, so the
    // one-shot repair has not run yet):
    //   记忆/经历/学科状态/(数学弱项)
    //   记忆/记忆/经历/学科状态/(雅思备考)
    //   记忆/记忆/经历/项目/(发布记录)
    //   记忆/记忆/(根级笔记)
    const rootId = newFolder('记忆', null);
    config.setRootFolderId(rootId);
    const experience = newFolder('经历', rootId);
    const subjectState = newFolder('学科状态', experience);
    const math = newNote('数学弱项', subjectState);

    const duplicateRoot = newFolder('记忆', rootId);
    const duplicateExperience = newFolder('经历', duplicateRoot);
    const duplicateSubjectState = newFolder('学科状态', duplicateExperience);
    const ielts = newNote('雅思备考', duplicateSubjectState);
    const duplicateProject = newFolder('项目', duplicateExperience);
    const release = newNote('发布记录', duplicateProject);
    const loose = newNote('根级笔记', duplicateRoot);

    // The first root lookup triggers the repair.
    const items = service.list(null, 50, 0);
    expect(items).toHaveLength(4);

    const rootChildren = listFoldersByParent(db, rootId);
    expect(rootChildren.every(folder => folder.title !== '记忆')).toBe(true);
    expect(folderExists(db, duplicateRoot)).toBe(false);

    expect(service.read(math)?.folderPath).toBe('经历/学科状态');
    expect(service.read(ielts)?.folderPath).toBe('经历/学科状态');
    expect(service.read(release)?.folderPath).toBe('经历/项目');
    expect(service.read(loose)?.folderPath).toBe('');

    // Existing same-title children are merged, not duplicated.
    expect(rootChildren.filter(folder => folder.title === '经历')).toHaveLength(1);
    const mergedExperience = rootChildren.find(folder => folder.title === '经历');
    expect(mergedExperience).toBeDefined();
    const mergedSubject = listFoldersByParent(db, mergedExperience!.id)
      .find(folder => folder.title === '学科状态');
    expect(mergedSubject?.id).toBe(subjectState);

    // Running the repair again is idempotent.
    expect(config.repairNestedRootDuplicates(rootId)).toBe(0);
  });
});
