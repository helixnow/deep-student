/**
 * P8「标签恢复重绑/删除语义 + 持久化写透缓存」source 契约（0824 Wave2-B 第 7 轮，测试员-5）
 *
 * 本轮只写不跑；预期第 8 轮跑测全绿。
 *
 * 被测行为（对照 docs/dev/wave2-B-r3-tab-restore.md P8-1 / P8-2）：
 * 1. 资源被移动/重命名后重启：恢复校验必须按稳定 resourceId 请求
 *    `dstu.get('/' + resourceId)`（不能用过期的 dstuPath），成功则保留标签
 *    并重绑最新 dstuPath/title（node.path / node.name）——「已移动」不得
 *    误判为「已失效」而删标签（r1 §2b 的回归防线）。
 * 2. 只有实体确认不存在（VfsErrorCode.NOT_FOUND）才删标签；网络/超时/内部
 *    等瞬态错误一律保留标签，交由面板加载自行报错。
 * 3. savePersistedTabs 写透模块级缓存：先更新 persistedTabsCache 再写
 *    localStorage（写 storage 失败也不影响缓存），消除 r1 §2a「同 renderer
 *    重挂时首次持久化 effect 用过期快照回滚 localStorage」的时序缺陷。
 *
 * 测试形态说明：上述逻辑全部是 LearningHubPage.tsx 的模块私有代码
 * （parsePersistedTab / loadPersistedTabs / savePersistedTabs / 恢复校验
 * effect 均未导出），且本轮禁改 LearningHubPage 实现，无法直接 import
 * 行为测试。按「可测纯函数则抽测；否则源码契约」的约定，本文件走源码
 * 契约断言；配套的行为测试见同目录
 * tabsPersistenceWriteThrough.test.ts（探测式：第 8 轮若把纯函数抽成
 * 独立模块即自动激活，未抽出则整组 skip）。
 *
 * 若第 8 轮实现员重构了这段代码（如抽出纯函数模块），本文件的字符串锚点
 * 需同步收敛为对新模块的行为断言——届时请优先删本文件、保留行为测试。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/features/learning-hub/LearningHubPage.tsx'),
  'utf8',
);

/** 按锚点截取源码片段；锚点缺失时抛错并给出可读原因（提示实现已被重构） */
function section(start: string, end: string, from: string = source): string {
  const i = from.indexOf(start);
  if (i < 0) {
    throw new Error(
      `源码契约锚点缺失（实现可能已重构，请同步更新本测试）: ${start}`,
    );
  }
  const j = from.indexOf(end, i);
  if (j < 0) {
    throw new Error(
      `源码契约结束锚点缺失（实现可能已重构，请同步更新本测试）: ${end}`,
    );
  }
  return from.slice(i, j);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// 恢复校验 effect（P8-2）：从一次性守卫 ref 到 openTab 定义之间
const restoreEffect = section('const restoredValidationDone', 'const openTab = useCallback');
// 校验主循环：逐标签请求 + 分支归类
const validationLoop = section('for (const tab of restored) {', 'if (invalidIds.size === 0', restoreEffect);
// 提交步：按归类结果重建 tabs
const commitStep = section('setTabs(prev => {', 'return () => { cancelled = true; };', restoreEffect);
// savePersistedTabs（P8-1）函数体（到组件定义为止，段内 localStorage.setItem 唯一）
const saveSection = section('const savePersistedTabs', 'export const LearningHubPage');

describe('P8-2 恢复校验：按稳定 resourceId 请求（移动/重命名不误删）', () => {
  it('requests dstu.get by /${resourceId}, never by the stale dstuPath', () => {
    expect(validationLoop).toContain('const result = await dstu.get(`/${tab.resourceId}`);');
    // dstuPath 是人类可读路径，资源移动后即过期；用它校验会把「已移动」
    // 误判为「已失效」（r1 §2b 原缺陷），恢复校验里必须绝迹
    expect(restoreEffect).not.toContain('dstu.get(tab.dstuPath)');
  });

  it('on success, records a rebind of dstuPath/title from the fresh node', () => {
    expect(validationLoop).toContain('if (result.ok) {');
    expect(validationLoop).toContain('rebinds.set(tab.tabId, {');
    // 重绑最新真实路径；node.path 为空时回退加载键 /${resourceId}
    expect(validationLoop).toContain('dstuPath: node.path || `/${tab.resourceId}`');
    // node.name 为空时保留旧 title，不把标签刷成空白
    expect(validationLoop).toContain('title: node.name || tab.title');
  });

  it('rebinding preserves the tab in the commit step (rebound !== deleted)', () => {
    // 提交步里重绑的标签必须继续 push 进 next（展开合并，不丢字段）
    expect(commitStep).toContain('next.push({ ...tab, ...rebind });');
    // 未变化/未归类的标签原样保留
    expect(commitStep).toContain('next.push(tab);');
  });

  it('runs at most once per mount (one-shot guard ref)', () => {
    expect(restoreEffect).toContain('if (restoredValidationDone.current) return;');
    expect(restoreEffect).toContain('restoredValidationDone.current = true;');
  });
});

describe('P8-2 恢复校验：只有 NOT_FOUND 才删标签', () => {
  it('imports VfsErrorCode from the shared result module', () => {
    expect(source).toContain("import { VfsErrorCode } from '@/shared/result';");
  });

  it('marks a tab invalid only inside the NOT_FOUND branch', () => {
    expect(validationLoop).toMatch(
      /else if \(result\.error\.code === VfsErrorCode\.NOT_FOUND\) \{\s*invalidIds\.add\(tab\.tabId\);/,
    );
    // invalidIds.add 全文件唯一：除 NOT_FOUND 外没有任何路径能把标签判死
    expect(countOccurrences(source, 'invalidIds.add(')).toBe(1);
  });

  it('has no fallthrough branch for transient errors (network/timeout keep the tab)', () => {
    // NOT_FOUND 分支之后不允许再挂 else：非 NOT_FOUND 失败必须什么都不做
    expect(validationLoop).not.toMatch(/VfsErrorCode\.NOT_FOUND\) \{[\s\S]*?\}\s*else\b/);
    // 循环内对标签的归类出口只有两个：重绑（成功）与判死（NOT_FOUND）
    expect(countOccurrences(validationLoop, 'rebinds.set(')).toBe(1);
    expect(countOccurrences(validationLoop, 'invalidIds.add(')).toBe(1);
  });

  it('deletes tabs in the commit step only via the invalidIds set', () => {
    // 唯一的删除路径：invalidIds 命中 → continue（不 push 进 next）
    expect(commitStep).toMatch(/if \(invalidIds\.has\(tab\.tabId\)\) \{\s*changed = true;\s*continue;/);
    // 提交步内不得出现其他按条件丢弃标签的 filter
    expect(commitStep).not.toContain('.filter(');
  });
});

describe('P8-1 savePersistedTabs 写透缓存', () => {
  it('updates the module-level cache before touching localStorage', () => {
    const cacheWrite = saveSection.indexOf('persistedTabsCache = { tabs, activeTabId };');
    const storageWrite = saveSection.indexOf('localStorage.setItem(');
    const tryBlock = saveSection.indexOf('try {');
    expect(cacheWrite).toBeGreaterThanOrEqual(0);
    expect(storageWrite).toBeGreaterThanOrEqual(0);
    // 缓存写入必须在 try 之外、storage 写入之前：storage 抛异常也不能
    // 让缓存停留在过期快照（r1 §2a 回滚时序的根因）
    expect(cacheWrite).toBeLessThan(tryBlock);
    expect(cacheWrite).toBeLessThan(storageWrite);
  });

  it('persists a versioned payload and swallows storage failures', () => {
    expect(saveSection).toContain('JSON.stringify({ version: TABS_STORAGE_VERSION, tabs, activeTabId })');
    // storage 失败静默（缓存已更新，同会话 remount 恢复不受影响）
    expect(saveSection).toMatch(/catch \{/);
  });

  it('state initializers read through loadPersistedTabs so the cache write-through matters', () => {
    // useState 惰性初始化走 loadPersistedTabs（命中模块缓存）；配合写透，
    // Page 卸载重挂后首次持久化 effect 不会再用旧快照覆盖 localStorage
    expect(source).toContain('useState<OpenTab[]>(() => loadPersistedTabs().tabs)');
    expect(source).toContain('useState<string | null>(() => loadPersistedTabs().activeTabId)');
    expect(source).toMatch(/savePersistedTabs\(tabs, activeTabId\);\s*\}, \[tabs, activeTabId\]\);/);
  });
});
