import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import { normalizeFolderSegments } from '../src/service.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }

describe('memory commands', () => {
  it('normalize_folder_segments_strips_root_prefix_and_noise', () => {
    const norm = (path: string) => normalizeFolderSegments(path, '记忆');
    const expected = ['经历', '学科状态'];
    expect(norm('经历/学科状态')).toEqual(expected);
    expect(norm('记忆/经历/学科状态')).toEqual(expected);
    expect(norm('/记忆/经历/学科状态/')).toEqual(expected);
    expect(norm(' 记忆 / 经历 /学科状态 ')).toEqual(expected);
    expect(norm('记忆／经历＼学科状态')).toEqual(expected);
    expect(norm('记忆\\经历\\学科状态')).toEqual(expected);
    expect(norm('记忆/记忆/./经历//学科状态')).toEqual(expected);
    expect(norm('记忆')).toEqual([]);
    expect(norm(' / ')).toEqual([]);
    expect(norm('经历/记忆')).toEqual(['经历', '记忆']);
    expect(normalizeFolderSegments('记忆/经历', null)).toEqual(['记忆', '经历']);
  });

  it('root_prefixed_folder_paths_reuse_existing_memory_folder', async () => {
    const { host } = await setup();
    const rootId = await host.invoke('memory_get_or_create_root_folder', {}) as string;
    const root = await host.invoke('memory_get_config', {}) as { memoryRootFolderTitle: string };
    const rootTitle = root.memoryRootFolderTitle;
    expect(rootId).toMatch(/^fld_/);
    expect(rootTitle).toBe('记忆');

    const canonical = await host.invoke('memory_write', {
      folderPath: '经历/学科状态', title: '数学弱项', content: '数学是弱项',
    }) as { noteId: string };
    for (const [index, path] of [rootTitle + '/经历/学科状态', `/${rootTitle}/经历/学科状态/`,
      '经历／学科状态'].entries()) {
      await host.invoke('memory_write', {
        folderPath: path, title: `雅思备考${index}`, content: '雅思目标 7 分',
      });
    }
    const listed = await host.invoke('memory_list', { folderPath: `${rootTitle}/经历` }) as unknown[];
    expect(listed).toHaveLength(4);
    expect((listed[0] as { folderPath: string }).folderPath).toBe('经历/学科状态');
    const tree = await host.invoke('memory_get_tree', {}) as { children: { folder: { title: string } }[] };
    expect(tree.children.filter(child => child.folder.title === rootTitle)).toHaveLength(0);
    const read = await host.invoke('memory_read', { noteId: canonical.noteId }) as { folderPath: string };
    expect(read.folderPath).toBe(`${rootTitle}/经历/学科状态`);
    await host.invoke('memory_move_to_folder', {
      noteId: canonical.noteId, targetFolderPath: `${rootTitle}/偏好`,
    });
    const moved = await host.invoke('memory_read', { noteId: canonical.noteId }) as { folderPath: string };
    expect(moved.folderPath).toBe(`${rootTitle}/偏好`);
  });

  it('reserved_folder_check_uses_normalized_separators', async () => {
    const { host } = await setup();
    await expect(host.invoke('memory_write', {
      folderPath: '经历／__system__', title: 'a', content: 'b',
    })).rejects.toThrow("Invalid argument 'folder_path': 路径包含系统保留目录（'__*'）");
    await expect(host.invoke('memory_write', {
      folderPath: '记忆/__system__', title: 'a', content: 'b',
    })).rejects.toThrow("Invalid argument 'folder_path': 路径包含系统保留目录（'__*'）");
    await expect(host.invoke('memory_write', {
      folderPath: '记忆/经历', title: 'ok', content: 'content',
    })).resolves.toBeTruthy();
  });

  it('memory_write rejects reserved titles and empty input after trimming', async () => {
    const { host } = await setup();
    await expect(host.invoke('memory_write', { title: ' ', content: ' ' }))
      .rejects.toThrow('标题与内容不能同时为空');
    await expect(host.invoke('memory_write', { title: '__user_profile__', content: 'x' }))
      .rejects.toThrow("Invalid argument 'title': 标题使用系统保留前缀 '__'，请更换标题");
  });
});
