/**
 * 资源应用群注册元数据测试（P8）
 *
 * 七类内容 + mindmap + files 的 register 元数据符合设计文档 §9.1 /
 * 编排文档 P8 章节的规定（weight / instanceMode / canClose）。
 */
import { describe, expect, it, vi } from 'vitest';

// files register 会启动 resourceSync（dstu.watch），mock 掉真实 DSTU 链路
vi.mock('@/dstu', () => ({
  dstu: {
    watch: vi.fn(() => () => {}),
  },
}));

import { appRegistry } from '../../../core/appRegistry';
import { CONTENT_APP_DEFINITIONS } from '../register';
import { MINDMAP_APP_DEFINITION } from '../../mindmap/register';
import { notesAppDefinition } from '../../notes/register';
import { FILES_APP_DEFINITION } from '../../files/register';

const EXPECTED_WEIGHTS: Record<string, 1 | 2 | 3> = {
  textbook: 3,
  exam: 2,
  translation: 2,
  essay: 2,
  image: 1,
  file: 1,
};

describe('content app registers', () => {
  it('注册独立内容应用，但 note 由统一 Notes 应用承载', () => {
    expect(CONTENT_APP_DEFINITIONS.map((d) => d.typeId).sort()).toEqual(
      Object.keys(EXPECTED_WEIGHTS).sort(),
    );
    for (const typeId of Object.keys(EXPECTED_WEIGHTS)) {
      expect(appRegistry.get(typeId)?.typeId).toBe(typeId);
    }
    expect(appRegistry.get('note')).toBeUndefined();
  });

  it('weight 与 instanceMode 符合章节规定', () => {
    for (const def of CONTENT_APP_DEFINITIONS) {
      expect(def.memoryWeight, `${def.typeId} weight`).toBe(EXPECTED_WEIGHTS[def.typeId]);
      const expectedMode = def.typeId === 'exam' || def.typeId === 'essay' ? 'single' : 'multi';
      expect(def.instanceMode, `${def.typeId} instanceMode`).toBe(expectedMode);
      expect(def.nameKey).toBe(`workbench:apps.${def.typeId}`);
      expect(def.defaultFrame.w).toBeGreaterThan(0);
      expect(def.minSize.w).toBeGreaterThan(0);
      expect(def.render).toBeTruthy();
    }
  });

  it('独立编辑类应用接了 canClose 未保存拦截', () => {
    for (const typeId of ['translation', 'essay']) {
      expect(appRegistry.get(typeId)?.canClose, `${typeId} canClose`).toBeTypeOf('function');
    }
    for (const typeId of ['textbook', 'exam', 'image', 'file']) {
      expect(appRegistry.get(typeId)?.canClose, `${typeId} canClose`).toBeUndefined();
    }
  });
});

describe('mindmap app register', () => {
  it('保留 mindmap 激活定义但不注册独立应用', () => {
    expect(MINDMAP_APP_DEFINITION.typeId).toBe('mindmap');
    expect(MINDMAP_APP_DEFINITION.instanceMode).toBe('multi');
    expect(MINDMAP_APP_DEFINITION.memoryWeight).toBe(2);
    expect(appRegistry.get('mindmap')).toBeUndefined();
  });
});

describe('notes workspace register', () => {
  it('notes：single，统一承载 note 与 mindmap', () => {
    expect(notesAppDefinition.typeId).toBe('notes');
    expect(notesAppDefinition.instanceMode).toBe('single');
    expect(appRegistry.get('notes')).toBe(notesAppDefinition);
  });
});

describe('files app register', () => {
  it('files：single，weight=1', () => {
    expect(FILES_APP_DEFINITION.typeId).toBe('files');
    expect(FILES_APP_DEFINITION.instanceMode).toBe('single');
    expect(FILES_APP_DEFINITION.memoryWeight).toBe(1);
    expect(appRegistry.get('files')).toBe(FILES_APP_DEFINITION);
  });

  it('files register 启动资源删除联动订阅', async () => {
    const { dstu } = await import('@/dstu');
    expect(vi.mocked(dstu.watch)).toHaveBeenCalledWith('*', expect.any(Function));
  });
});
