// relativizeFolderPath 处理的是 VFS 虚拟路径（repository/vfs.ts buildFolderPath：文件夹标题以 `/` 连接），
// 不是磁盘路径，与平台分隔符无关；Rust 同（dstu-memory memory/service.rs:565 relativize_folder_path）。
import { expect, it } from 'vitest';
import { normalizeFolderSegments, relativizeFolderPath } from '../src/memory-utils.ts';

it('VFS 虚拟路径只以 `/` 分隔：Windows 宿主上也不把 `\\` 当分隔符', () => {
  expect(relativizeFolderPath('记忆', '记忆')).toBe('');
  expect(relativizeFolderPath('记忆/学科/数学', '记忆')).toBe('学科/数学');
  // 文件夹标题本身可以含 `\`（例如 "C:\\notes"），按标题原样保留
  expect(relativizeFolderPath('记忆/C:\\notes', '记忆')).toBe('C:\\notes');
  expect(relativizeFolderPath('记忆\\学科', '记忆')).toBe('记忆\\学科');
  // 前缀相同但不是子路径
  expect(relativizeFolderPath('记忆库/a', '记忆')).toBe('记忆库/a');
});

it('模型给出的文件夹参数接受 `\\`、全角斜杠作为分隔符（normalize_folder_segments）', () => {
  expect(normalizeFolderSegments('记忆\\学科／数学＼代数', '记忆')).toEqual(['学科', '数学', '代数']);
});
