/**
 * Chat 移动页顶栏「右侧 ≤2 动作」source 契约（0824 Wave2-C R5）
 *
 * 规范来源：docs/dev/mobile-uiux-unify/README.md 第 3 条——
 * 「次级页面或当前页不超过 2 个快捷动作（每个 ≥44px）。更多动作收进页内『更多』菜单。」
 *
 * 锁定对象：src/features/chat/pages/useChatPageLayout.tsx（chat-v2 顶栏唯一注册点，
 * 由 mobileHeaderViewRegistryContract 锁定唯一性）。该 hook 的每个顶栏分支
 * （沙箱右屏 / 资源预览 / 资源库列表 / 分组编辑器 / browser 视图 / 极简首页 / 默认聊天）
 * 都各自声明 rightActions，本契约逐分支静态计数：
 * - 每个分支的交互动作数在 1..2 之间（新增第 3 个动作必须改走「更多」菜单）；
 * - 动作载体只允许 DsButton——coarse 指针下的 44px 命中保底已下沉到
 *   buttonPrimitiveContract 尺寸类（由 buttonPrimitiveContract.coarse.source.test.ts
 *   锁定），因此「≥44px」由 primitive 契约继承，这里刻意不数尺寸类名
 *   （与 touchTargetOwnership.contract.test.ts 的机制无关原则一致）；
 * - rightActions 的来源全部入账：子屏分支的内联 JSX 块 + 命名动作 memo
 *   （session/homepage/browser NewChatAction）+ 默认分支三元末段 fragment，
 *   出现未入账的新来源时本契约直接红，逼迫新来源显式纳入计数。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_FILE = 'src/features/chat/pages/useChatPageLayout.tsx';
const source = readFileSync(resolve(process.cwd(), SOURCE_FILE), 'utf-8');

/** 从 openIndex（必须指向 '('）起返回配平括号内的内容 */
const extractBalancedParens = (text: string, openIndex: number): string => {
  if (text[openIndex] !== '(') {
    throw new Error(`extractBalancedParens: offset ${openIndex} 处不是 '('`);
  }
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new Error(`extractBalancedParens: offset ${openIndex} 起括号不配平`);
};

/** 顶栏配置里内联声明的 rightActions: ( <JSX> ) 块（沙箱/资源预览/资源库列表/分组编辑器） */
const collectInlineRightActionBlocks = (): string[] =>
  [...source.matchAll(/rightActions:\s*\(/g)].map((match) =>
    extractBalancedParens(source, match.index! + match[0].length - 1)
  );

/** 命名动作 memo（sessionNewChatAction / homepageNewChatAction / browserNewChatAction）的 JSX */
const collectNamedActionMemoBlocks = (): string[] =>
  [...source.matchAll(/const \w+NewChatAction = useMemo\(\(\) => \(/g)].map((match) =>
    extractBalancedParens(source, match.index! + match[0].length - 1)
  );

/** 默认聊天分支的三元分派结构：browser 视图 / 极简首页 / 默认聊天 */
const DEFAULT_BRANCH_DISPATCH_RE =
  /rightActions:\s*viewMode === 'browser'\s*\?\s*browserNewChatAction\s*:\s*isMinimalChatHeader\s*\?\s*homepageNewChatAction\s*:\s*\(/;

/** 默认聊天分支三元末段的内联 fragment（GoalStatusChip + sessionNewChatAction） */
const collectDefaultChatBranchFragment = (): string => {
  const dispatch = source.match(DEFAULT_BRANCH_DISPATCH_RE);
  if (!dispatch) {
    throw new Error(
      `${SOURCE_FILE} 默认分支应以三元按 viewMode/isMinimalChatHeader 分派 rightActions`,
    );
  }
  return extractBalancedParens(source, dispatch.index! + dispatch[0].length - 1);
};

const countDsButtons = (jsx: string): number => (jsx.match(/<DsButton\b/g) ?? []).length;

describe('chat header right actions contract (spec #3: ≤2 actions, 44px via DsButton)', () => {
  const inlineBlocks = collectInlineRightActionBlocks();
  const namedActionBlocks = collectNamedActionMemoBlocks();
  const defaultChatFragment = collectDefaultChatBranchFragment();
  const dsButtonBlocks = [...inlineBlocks, ...namedActionBlocks];

  it('accounts for every rightActions source in the chat layout hook', () => {
    // 防空断言：当前 4 个子屏分支内联声明（沙箱/资源预览/资源库列表/分组编辑器）
    expect(inlineBlocks.length).toBeGreaterThanOrEqual(4);
    // 命名动作 memo 三个视图分支：默认聊天 / 极简首页 / browser 视图
    expect(namedActionBlocks.length).toBe(3);
    expect(source).toMatch(DEFAULT_BRANCH_DISPATCH_RE);

    // 全部 rightActions 出现次数 = 内联块数 + 1 次默认分支三元分派。
    // 新增第三来源（另一个 memo、第二个标识符引用等）会让等式失衡，
    // 必须显式把新来源纳入本契约的计数后才能转绿。
    const totalDeclarations = (source.match(/[^a-zA-Z]rightActions\s*:/g) ?? []).length;
    expect(totalDeclarations).toBe(inlineBlocks.length + 1);
  });

  it('keeps every top-bar branch at 1..2 quick actions', () => {
    const violations = dsButtonBlocks
      .map((jsx, index) => ({ index, count: countDsButtons(jsx) }))
      .filter(({ count }) => count < 1 || count > 2)
      .map(({ index, count }) =>
        `rightActions 分支 #${index} 含 ${count} 个动作（规范：1..2，超出请收进页内「更多」菜单）`
      );
    expect(violations).toEqual([]);

    // 默认聊天分支 fragment 只组合已入账的动作引用：GoalStatusChip + sessionNewChatAction
    const defaultBranchActions =
      (defaultChatFragment.match(/<GoalStatusChip\b/g) ?? []).length +
      (defaultChatFragment.match(/\{sessionNewChatAction\}/g) ?? []).length;
    expect(
      defaultBranchActions,
      `默认聊天分支含 ${defaultBranchActions} 个动作（规范：1..2，超出请收进页内「更多」菜单）`,
    ).toBeGreaterThanOrEqual(1);
    expect(defaultBranchActions).toBeLessThanOrEqual(2);
  });

  it('only ever renders actions through DsButton (inherits coarse 44px floor)', () => {
    // 其他交互载体（裸 button/a、其他按钮组件、可点 span）不继承
    // buttonPrimitiveContract 的 coarse min-h/min-w 保底，禁止混入右侧动作区；
    // onClick 数与 DsButton 数一致，拦截「挂在包装节点上的隐形动作」。
    for (const [index, jsx] of dsButtonBlocks.entries()) {
      const foreignTags = jsx.match(/<(?:button|a|Button|IconButton|TouchTarget|AppMenuTrigger)\b/g) ?? [];
      expect(foreignTags, `rightActions 分支 #${index} 出现非 DsButton 交互载体`).toEqual([]);
      const clickHandlers = (jsx.match(/onClick=/g) ?? []).length;
      expect(clickHandlers, `rightActions 分支 #${index} 的 onClick 数应等于 DsButton 数`).toBe(countDsButtons(jsx));
    }
    // 默认分支 fragment 不私带交互载体/点击句柄（GoalStatusChip 内部交互由其自身契约管辖）
    const defaultForeign = defaultChatFragment.match(
      /<(?:button|a|Button|IconButton|TouchTarget|AppMenuTrigger|DsButton)\b/g,
    ) ?? [];
    expect(defaultForeign, '默认聊天分支 fragment 出现未入账的交互载体').toEqual([]);
    expect(defaultChatFragment).not.toContain('onClick=');
    expect(source).toContain("import { DsButton } from '@/components/ui/DsButton'");
  });
});
