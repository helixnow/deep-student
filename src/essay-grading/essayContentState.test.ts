import { describe, it, expect } from 'vitest';
import {
  essayDirtySnapshot,
  essayGradedSnapshot,
  evaluateRoundSwitch,
  fromPersistedImages,
  parseSessionContext,
  serializeSessionContext,
  toPersistedImages,
  type EssayContentState,
} from './essayContentState';

const img = (id: string, fileName = `${id}.png`, base64 = 'QUJD') => ({
  id,
  fileName,
  base64,
  ocrText: '',
});

const state = (patch: Partial<EssayContentState> = {}): EssayContentState => ({
  inputText: '正文',
  topicText: '题目',
  uploadedImages: [img('a')],
  topicImages: [img('t')],
  ...patch,
});

describe('essayDirtySnapshot（脏基准包含题目与图片）', () => {
  it('相同内容快照一致', () => {
    expect(essayDirtySnapshot(state())).toBe(essayDirtySnapshot(state()));
  });

  it('正文 / 题目 / 作文图 / 题目图 任一变化都会改变快照', () => {
    const base = essayDirtySnapshot(state());
    expect(essayDirtySnapshot(state({ inputText: '改过的正文' }))).not.toBe(base);
    expect(essayDirtySnapshot(state({ topicText: '换题目' }))).not.toBe(base);
    expect(essayDirtySnapshot(state({ uploadedImages: [img('a'), img('b')] }))).not.toBe(base);
    expect(essayDirtySnapshot(state({ topicImages: [] }))).not.toBe(base);
  });

  it('回看轮次语义：基准只补丁正文后，展示旧轮次不误报脏', () => {
    // 基准 = 已持久化状态（最新轮次正文 + 已保存题目/图片）
    const baseline = state({ inputText: '第 2 轮正文' });
    // 用户切到第 1 轮：UI 正文变为旧轮次正文，题目/图片不变
    const viewingOldRound = state({ inputText: '第 1 轮正文' });
    // 未修正基准 → 误报脏
    expect(essayDirtySnapshot(viewingOldRound)).not.toBe(essayDirtySnapshot(baseline));
    // 修正基准（只补丁 inputText）→ 不再误报
    const patched = { ...baseline, inputText: '第 1 轮正文' };
    expect(essayDirtySnapshot(viewingOldRound)).toBe(essayDirtySnapshot(patched));
  });

  it('回看轮次时题目的未保存修改仍保持脏态（基准题目/图片不被吞掉）', () => {
    const baseline = state({ inputText: '第 2 轮正文' });
    const patched = { ...baseline, inputText: '第 1 轮正文' };
    const viewingWithDirtyTopic = state({ inputText: '第 1 轮正文', topicText: '改过的题目' });
    expect(essayDirtySnapshot(viewingWithDirtyTopic)).not.toBe(essayDirtySnapshot(patched));
  });
});

describe('essayGradedSnapshot（内容 + 批改配置）', () => {
  const config = {
    modeId: 'practice',
    modelId: 'm1',
    essayType: 'other',
    gradeLevel: 'high_school',
    customPrompt: '',
  };

  it('内容相同、配置变化（如换模式）时快照不同，允许重新批阅', () => {
    const a = essayGradedSnapshot(state(), config);
    const b = essayGradedSnapshot(state(), { ...config, modeId: 'gaokao' });
    expect(a).not.toBe(b);
  });

  it('恢复题目或图片后必须重建上一轮快照，避免未修改也误提交新轮次', () => {
    const beforeContextRestore = essayGradedSnapshot(
      state({ topicText: '', uploadedImages: [], topicImages: [] }),
      config,
    );
    const afterContextRestore = essayGradedSnapshot(state(), config);
    expect(afterContextRestore).not.toBe(beforeContextRestore);
    expect(afterContextRestore).toBe(essayGradedSnapshot(state(), config));
  });

  it('内容与配置都相同时快照一致（阻止重复提交）', () => {
    expect(essayGradedSnapshot(state(), config)).toBe(essayGradedSnapshot(state(), config));
  });
});

describe('evaluateRoundSwitch（轮次切换守卫）', () => {
  const base = {
    targetIndex: 0,
    currentIndex: 1,
    roundCount: 3,
    isGrading: false,
    hasUnsavedBody: false,
  };

  it('批改中忽略切换', () => {
    expect(evaluateRoundSwitch({ ...base, isGrading: true })).toBe('ignore');
  });

  it('目标越界或与当前轮相同时忽略', () => {
    expect(evaluateRoundSwitch({ ...base, targetIndex: -1 })).toBe('ignore');
    expect(evaluateRoundSwitch({ ...base, targetIndex: 3 })).toBe('ignore');
    expect(evaluateRoundSwitch({ ...base, targetIndex: 1 })).toBe('ignore');
  });

  it('正文有未保存编辑时要求确认', () => {
    expect(evaluateRoundSwitch({ ...base, hasUnsavedBody: true })).toBe('needs-confirm');
  });

  it('干净状态直接切换', () => {
    expect(evaluateRoundSwitch(base)).toBe('apply');
  });
});

describe('会话上下文持久化（题目/图片重开可恢复）', () => {
  it('serialize → parse → fromPersistedImages 往返保持题目与图片', () => {
    const raw = serializeSessionContext({
      topicText: '以「坚持」为题',
      uploadedImages: [{ id: 'a', fileName: 'a.png', base64: 'QUJD', ocrText: '识别文本' }],
      topicImages: [{ id: 't', fileName: 't.webp', base64: 'REVG' }],
    });
    const parsed = parseSessionContext(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.topicText).toBe('以「坚持」为题');

    const uploaded = fromPersistedImages(parsed!.uploadedImages);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatchObject({
      id: 'a',
      fileName: 'a.png',
      base64: 'QUJD',
      ocrText: '识别文本',
      ocrStatus: 'done',
    });
    expect(uploaded[0].dataUrl).toBe('data:image/png;base64,QUJD');

    const topicImages = fromPersistedImages(parsed!.topicImages);
    expect(topicImages[0].dataUrl).toBe('data:image/webp;base64,REVG');
    expect(topicImages[0].ocrText).toBe('');
  });

  it('parseSessionContext 对空值 / 非法 JSON / 非对象结构返回 null', () => {
    expect(parseSessionContext(null)).toBeNull();
    expect(parseSessionContext('')).toBeNull();
    expect(parseSessionContext('not-json')).toBeNull();
    expect(parseSessionContext('"just a string"')).toBeNull();
  });

  it('fromPersistedImages 过滤缺字段 / 空 base64 的脏记录', () => {
    const restored = fromPersistedImages([
      { id: 'ok', fileName: 'ok.jpg', base64: 'QQ==' },
      { id: 'no-base64', fileName: 'x.png', base64: '' },
      { fileName: 'no-id.png', base64: 'QQ==' },
      null,
      'garbage',
    ]);
    expect(restored.map(r => r.id)).toEqual(['ok']);
  });

  it('toPersistedImages 省略空 ocrText，保留非空 ocrText', () => {
    const persisted = toPersistedImages([
      { id: 'a', fileName: 'a.png', base64: 'QQ==', ocrText: '' },
      { id: 'b', fileName: 'b.png', base64: 'Qg==', ocrText: '文字' },
    ]);
    expect(persisted[0].ocrText).toBeUndefined();
    expect(persisted[1].ocrText).toBe('文字');
  });
});
