import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import enLearningHub from '@/locales/en-US/learningHub.json';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import {
  MEMORY_SYSTEM_FOLDER_TITLES,
  getMemoryFolderLabelKey,
  isMemoryRootFolder,
  isPathInMemoryRoot,
  localizeMemoryBreadcrumbs,
  localizeMemoryFolderPath,
  localizeMemoryFolderTitle,
} from '../memoryFolderLabels';

function makeT(catalog: Record<string, unknown>): TFunction {
  return ((key: string, options?: { defaultValue?: string }) => {
    const [ns, path] = key.includes(':') ? key.split(':') : ['learningHub', key];
    if (ns !== 'learningHub') return options?.defaultValue ?? key;
    const value = path.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      catalog,
    );
    return typeof value === 'string' ? value : options?.defaultValue ?? key;
  }) as unknown as TFunction;
}

const tEn = makeT(enLearningHub);
const tZh = makeT(zhLearningHub);

describe('memoryFolderLabels', () => {
  it('maps every system-defined memory folder and keeps zh-CN labels identical to stored names', () => {
    for (const title of MEMORY_SYSTEM_FOLDER_TITLES) {
      const key = getMemoryFolderLabelKey(title);
      expect(key).toMatch(/^learningHub:memoryFolders\./);
      expect(localizeMemoryFolderTitle(title, tZh)).toBe(title);
      expect(localizeMemoryFolderTitle(title, tEn)).not.toBe(title);
    }
  });

  it('translates known system names to English', () => {
    expect(localizeMemoryFolderTitle('记忆', tEn)).toBe('Memory');
    expect(localizeMemoryFolderTitle('经历', tEn)).toBe('Experience');
    expect(localizeMemoryFolderTitle('学科状态', tEn)).toBe('Subject status');
    expect(localizeMemoryFolderTitle('偏好', tEn)).toBe('Preferences');
    expect(localizeMemoryFolderTitle('工作环境', tEn)).toBe('Work environment');
    expect(localizeMemoryFolderTitle('学习日志', tEn)).toBe('Study log');
  });

  it('leaves model-chosen / user folder names untouched', () => {
    expect(getMemoryFolderLabelKey('笔记风格')).toBeNull();
    expect(getMemoryFolderLabelKey('高考复习')).toBeNull();
    expect(localizeMemoryFolderTitle('高考复习', tEn)).toBe('高考复习');
  });

  it('localizes relative memory paths segment by segment', () => {
    expect(localizeMemoryFolderPath('经历/学科状态', tEn)).toBe('Experience/Subject status');
    expect(localizeMemoryFolderPath('偏好 / 笔记风格', tEn)).toBe('Preferences / 笔记风格');
  });

  it('determines memory-root membership by id, falling back to the root title', () => {
    expect(isMemoryRootFolder({ id: 'fld_mem', title: '随便' }, { id: 'fld_mem' })).toBe(true);
    expect(isMemoryRootFolder({ id: 'fld_other', title: '记忆' }, { id: 'fld_mem' })).toBe(false);
    expect(isMemoryRootFolder({ id: 'fld_x', title: '记忆' }, null)).toBe(true);
    expect(isMemoryRootFolder({ id: 'fld_x', title: '记忆' }, null, { topLevel: false })).toBe(false);
    expect(isPathInMemoryRoot('/记忆/经历', null)).toBe(true);
    expect(isPathInMemoryRoot('/资料/经历', null)).toBe(false);
  });

  it('only localizes breadcrumbs from the memory root onward', () => {
    const crumbs = [
      { id: 'fld_a', name: '经历' },
      { id: 'fld_mem', name: '记忆' },
      { id: 'fld_b', name: '经历' },
      { id: 'fld_c', name: '笔记风格' },
    ];
    expect(localizeMemoryBreadcrumbs(crumbs, { id: 'fld_mem' }, tEn).map((c) => c.name)).toEqual([
      '经历', 'Memory', 'Experience', '笔记风格',
    ]);
    // 未知根 ID：首段等于记忆根标题时回退
    expect(localizeMemoryBreadcrumbs(crumbs.slice(1), null, tEn).map((c) => c.name)).toEqual([
      'Memory', 'Experience', '笔记风格',
    ]);
    // 非记忆路径保持引用不变
    const plain = [{ id: 'x', name: '经历' }];
    expect(localizeMemoryBreadcrumbs(plain, { id: 'fld_mem' }, tEn)).toBe(plain);
  });
});
