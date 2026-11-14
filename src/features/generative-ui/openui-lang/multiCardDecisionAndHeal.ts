import {
  isOpenUIComponentNode,
  parseOpenUILang,
  type OpenUIComponentNode,
  type OpenUIProgram,
  type OpenUIValue,
} from './parser';

// ============================================================================
// 1. reply 模式多卡分步批处理决策收集器 (MultiCardDecisionCollector)
// ============================================================================

const FORM_FIELD_COMPONENTS = new Set(['Choice', 'Input', 'DateInput', 'Slider']);

const KNOWN_OPENUI_CATALOG_COMPONENTS = new Set([
  'Root',
  'Stack',
  'Row',
  'Card',
  'Tabs',
  'Tab',
  'Details',
  'Accordion',
  'Text',
  'TextContent',
  'Header',
  'Badge',
  'Callout',
  'KeyValue',
  'Table',
  'Stat',
  'Progress',
  'Steps',
  'BarChart',
  'LineChart',
  'Chart',
  'Series',
  'Choice',
  'Input',
  'DateInput',
  'Slider',
  'Button',
]);

export interface DecisionCardOption {
  label: string;
  value: string;
  variant: string;
}

export interface DecisionCardUnit {
  cardId: string;
  title: string;
  options: DecisionCardOption[];
  chosenLabel: string | null;
  chosenValue: string | null;
  answeredWithNoteOnly: boolean;
  note: string;
  collapsed: boolean;
  summaryLine: string | null;
}

export interface MultiCardProgress {
  chosenCount: number;
  totalCount: number;
  isComplete: boolean;
}

export interface SynthesizedCardDecision {
  cardId: string;
  title: string;
  optionLabel: string | null;
  optionValue: string | null;
  answeredWithNoteOnly: boolean;
  note?: string;
}

export interface MultiCardBatchPayload {
  decisions: SynthesizedCardDecision[];
  notes: Record<string, string>;
  skipped: string[];
  partial: boolean;
  synthetic: true;
  summaryText: string;
}

export interface MultiCardStepOutcome {
  card: DecisionCardUnit;
  progress: MultiCardProgress;
  autoSubmittedPayload: MultiCardBatchPayload | null;
}

export interface MultiCardCollectorOptions {
  onAutoSubmit?: (payload: MultiCardBatchPayload) => void;
}

function toStringArg(val: OpenUIValue | undefined): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return '';
}

function readDecisionButtonOption(node: OpenUIComponentNode): DecisionCardOption | null {
  if (node.name !== 'Button') return null;

  // 支持位置参数 Button(label, variant, value)、对象参数 Button(label, { variant, value })
  // 与具名参数 Button(label = "…", value = "…", variant = "…")
  const named = node.namedArgs ?? {};
  const label = toStringArg(named.label ?? named.title ?? named.text ?? node.args[0]).trim();
  if (!label) return null;

  let variant = 'primary';
  let value = '';

  const namedVariant = toStringArg(named.variant).trim();
  const namedValue = toStringArg(named.value ?? named.action).trim();
  if (namedVariant) variant = namedVariant;
  if (namedValue) value = namedValue;

  const second = node.args[1];
  if (
    second &&
    typeof second === 'object' &&
    !Array.isArray(second) &&
    !isOpenUIComponentNode(second)
  ) {
    const propsObj = second as Record<string, OpenUIValue>;
    if (typeof propsObj.variant === 'string' && propsObj.variant.trim()) {
      variant = propsObj.variant.trim();
    }
    if (typeof propsObj.value === 'string' && propsObj.value.trim()) {
      value = propsObj.value.trim();
    }
  } else {
    if (!namedVariant && typeof second === 'string' && second.trim()) {
      variant = second.trim();
    }
    if (!namedValue && typeof node.args[2] === 'string' && node.args[2].trim()) {
      value = node.args[2].trim();
    }
  }

  if (!value) return null;
  return { label, variant, value };
}

function collectDecisionButtonsWithinCard(
  value: OpenUIValue,
  out: DecisionCardOption[],
  isRootCard = false,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => collectDecisionButtonsWithinCard(child, out, false));
    return;
  }
  if (!isOpenUIComponentNode(value)) return;

  // 嵌套子 Card 独立结算，不归入外层 Card
  if (value.name === 'Card' && !isRootCard) {
    return;
  }

  const btn = readDecisionButtonOption(value);
  if (btn) {
    out.push(btn);
    return;
  }

  value.args.forEach((arg) => collectDecisionButtonsWithinCard(arg, out, false));
  if (value.namedArgs) {
    Object.values(value.namedArgs).forEach((arg) =>
      collectDecisionButtonsWithinCard(arg, out, false),
    );
  }
}

function normalizeAstRootList(
  input: OpenUIComponentNode | readonly OpenUIValue[] | OpenUIProgram | string,
): OpenUIValue[] {
  if (typeof input === 'string') {
    const program = parseOpenUILang(input);
    return program.root ? [program.root] : [];
  }
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input && typeof input === 'object' && 'statements' in input && 'root' in input) {
    const prog = input as OpenUIProgram;
    return prog.root ? [prog.root] : [];
  }
  if (isOpenUIComponentNode(input)) {
    return [input];
  }
  return [];
}

/**
 * 扫描 openui-lang AST 中所有包含决策 Button（带 value）的具名 Card，
 * 每张卡作为一个独立决策单元 DecisionCardUnit。
 */
export function scanDecisionCardUnits(
  input: OpenUIComponentNode | readonly OpenUIValue[] | OpenUIProgram | string,
): DecisionCardUnit[] {
  const roots = normalizeAstRootList(input);
  const rawCards: Array<{ id?: string; title: string; options: DecisionCardOption[] }> = [];

  const walk = (val: OpenUIValue): void => {
    if (!val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      val.forEach(walk);
      return;
    }
    if (!isOpenUIComponentNode(val)) return;

    if (val.name === 'Card') {
      const hasTitle = val.args.length >= 2 || typeof val.args[0] === 'string';
      const title = (
        toStringArg(val.namedArgs?.title ?? val.namedArgs?.header) ||
        (hasTitle ? toStringArg(val.args[0]) : '')
      ).trim();
      if (title) {
        const options: DecisionCardOption[] = [];
        collectDecisionButtonsWithinCard(val, options, true);
        if (options.length > 0) {
          rawCards.push({ id: val.id, title, options });
        }
      }
    }

    val.args.forEach(walk);
    if (val.namedArgs) Object.values(val.namedArgs).forEach(walk);
  };

  roots.forEach(walk);

  const usedIds = new Set<string>();
  return rawCards.map((card, index) => {
    let candidateId = card.id && !card.id.startsWith('__anon_') ? card.id : card.title;
    if (usedIds.has(candidateId)) {
      candidateId = `${candidateId}_${index + 1}`;
    }
    usedIds.add(candidateId);

    return {
      cardId: candidateId,
      title: card.title,
      options: card.options,
      chosenLabel: null,
      chosenValue: null,
      answeredWithNoteOnly: false,
      note: '',
      collapsed: false,
      summaryLine: null,
    };
  });
}

function buildCardSummaryLine(unit: DecisionCardUnit): string | null {
  if (!unit.collapsed) return null;
  const trimmedNote = unit.note.trim();
  if (unit.answeredWithNoteOnly) {
    return `${unit.title}: ${trimmedNote}`;
  }
  const choicePart = unit.chosenLabel ?? '';
  return trimmedNote
    ? `${unit.title}: ${choicePart} (${trimmedNote})`
    : `${unit.title}: ${choicePart}`;
}

function isCardAnswered(unit: DecisionCardUnit): boolean {
  return unit.chosenValue !== null || unit.answeredWithNoteOnly;
}

/**
 * reply 模式多卡分步批处理决策收集器：
 * - 每答完一张卡立即 collapsed: true 折叠为单行摘要，支持 reopenCard 重新展开修改；
 * - 支持逐卡独立备注 setCardNote 与“仅用备注回答” answerCardWithNoteOnly；
 * - 支持 flushChosenEarly 提前提交已选部分；
 * - 当 chosenCount === totalCount 时自动合成单条 { decisions, notes, synthetic: true } 载荷。
 */
export class MultiCardDecisionCollector {
  private readonly units: DecisionCardUnit[];
  private readonly onAutoSubmit?: (payload: MultiCardBatchPayload) => void;
  private lastSynthesizedPayload: MultiCardBatchPayload | null = null;

  constructor(
    astOrSource: OpenUIComponentNode | readonly OpenUIValue[] | OpenUIProgram | string,
    options: MultiCardCollectorOptions = {},
  ) {
    this.units = scanDecisionCardUnits(astOrSource);
    this.onAutoSubmit = options.onAutoSubmit;
  }

  private findTargetCard(cardIdOrTitle: string): DecisionCardUnit {
    const byId = this.units.find((u) => u.cardId === cardIdOrTitle);
    if (byId) return byId;
    const byTitle = this.units.filter((u) => u.title === cardIdOrTitle);
    if (byTitle.length === 1) return byTitle[0];
    throw new Error(`[MultiCardDecisionCollector] Unknown decision card: ${cardIdOrTitle}`);
  }

  private cloneUnit(unit: DecisionCardUnit): DecisionCardUnit {
    return {
      ...unit,
      options: unit.options.map((o) => ({ ...o })),
    };
  }

  public getCards(): DecisionCardUnit[] {
    return this.units.map((u) => this.cloneUnit(u));
  }

  public getCard(cardId: string): DecisionCardUnit | undefined {
    const found =
      this.units.find((u) => u.cardId === cardId) ??
      this.units.find((u) => u.title === cardId);
    return found ? this.cloneUnit(found) : undefined;
  }

  public getProgress(): MultiCardProgress {
    const totalCount = this.units.length;
    const chosenCount = this.units.filter(isCardAnswered).length;
    return {
      chosenCount,
      totalCount,
      isComplete: totalCount > 0 && chosenCount === totalCount,
    };
  }

  public setCardNote(cardId: string, note: string): DecisionCardUnit {
    const unit = this.findTargetCard(cardId);
    unit.note = note;
    unit.summaryLine = buildCardSummaryLine(unit);
    return this.cloneUnit(unit);
  }

  public chooseCardOption(
    cardId: string,
    optionLabel: string,
    optionValue: string,
  ): MultiCardStepOutcome {
    const unit = this.findTargetCard(cardId);
    unit.chosenLabel = optionLabel;
    unit.chosenValue = optionValue;
    unit.answeredWithNoteOnly = false;
    unit.collapsed = true;
    unit.summaryLine = buildCardSummaryLine(unit);

    const progress = this.getProgress();
    let autoSubmittedPayload: MultiCardBatchPayload | null = null;
    if (progress.isComplete) {
      autoSubmittedPayload = this.synthesizePayload(false);
      this.lastSynthesizedPayload = autoSubmittedPayload;
      this.onAutoSubmit?.(autoSubmittedPayload);
    }

    return {
      card: this.cloneUnit(unit),
      progress,
      autoSubmittedPayload,
    };
  }

  public answerCardWithNoteOnly(cardId: string, note?: string): MultiCardStepOutcome {
    const unit = this.findTargetCard(cardId);
    const nextNote = (note !== undefined ? note : unit.note).trim();
    if (!nextNote) {
      throw new Error(
        `[MultiCardDecisionCollector::answerCardWithNoteOnly] Note cannot be empty for card "${unit.cardId}"`,
      );
    }

    unit.note = nextNote;
    unit.chosenLabel = null;
    unit.chosenValue = null;
    unit.answeredWithNoteOnly = true;
    unit.collapsed = true;
    unit.summaryLine = buildCardSummaryLine(unit);

    const progress = this.getProgress();
    let autoSubmittedPayload: MultiCardBatchPayload | null = null;
    if (progress.isComplete) {
      autoSubmittedPayload = this.synthesizePayload(false);
      this.lastSynthesizedPayload = autoSubmittedPayload;
      this.onAutoSubmit?.(autoSubmittedPayload);
    }

    return {
      card: this.cloneUnit(unit),
      progress,
      autoSubmittedPayload,
    };
  }

  public reopenCard(cardId: string): DecisionCardUnit {
    const unit = this.findTargetCard(cardId);
    unit.chosenLabel = null;
    unit.chosenValue = null;
    unit.answeredWithNoteOnly = false;
    unit.collapsed = false;
    unit.summaryLine = null;
    this.lastSynthesizedPayload = null;
    return this.cloneUnit(unit);
  }

  public flushChosenEarly(): MultiCardBatchPayload | null {
    const progress = this.getProgress();
    if (progress.chosenCount === 0) return null;
    const payload = this.synthesizePayload(!progress.isComplete);
    this.lastSynthesizedPayload = payload;
    return payload;
  }

  public getSynthesizedPayload(): MultiCardBatchPayload | null {
    return this.lastSynthesizedPayload;
  }

  private synthesizePayload(partial: boolean): MultiCardBatchPayload {
    const decisions: SynthesizedCardDecision[] = [];
    const notes: Record<string, string> = {};
    const skipped: string[] = [];
    const lines = ['The user answered the UI block in your previous reply:'];

    for (const unit of this.units) {
      const trimmedNote = unit.note.trim();
      if (trimmedNote) {
        notes[unit.cardId] = trimmedNote;
      }

      if (isCardAnswered(unit)) {
        const item: SynthesizedCardDecision = {
          cardId: unit.cardId,
          title: unit.title,
          optionLabel: unit.chosenLabel,
          optionValue: unit.chosenValue,
          answeredWithNoteOnly: unit.answeredWithNoteOnly,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        };
        decisions.push(item);
        const answerLabel = unit.chosenLabel ?? 'no option chosen';
        lines.push(`- ${unit.title}: ${answerLabel}`);
        if (trimmedNote) {
          lines.push(`  Their note: ${trimmedNote}`);
        }
      } else {
        skipped.push(unit.cardId);
      }
    }

    if (skipped.length > 0) {
      lines.push(`They sent it without a choice for: ${skipped.join(', ')}.`);
    }

    return {
      decisions,
      notes,
      skipped,
      partial,
      synthetic: true,
      summaryText: lines.join('\n'),
    };
  }
}

// ============================================================================
// 2. 漏写提交按钮自动兜底 (ensureAwaitAnswerSubmitButton)
// ============================================================================

export interface NoteSlotPlacement {
  target: 'root' | 'last_tab' | 'before_buttons';
  tabIndex?: number;
  index: number;
  fieldName: 'note';
}

export interface EnsureAwaitAnswerOptions {
  awaitAnswer?: boolean;
}

export interface EnsureAwaitAnswerResult {
  nodes: OpenUIComponentNode[];
  root: OpenUIComponentNode | null;
  injectedSubmitButton: boolean;
  injectedTarget: 'none' | 'root' | 'last_tab';
  noteSlot: NoteSlotPlacement | null;
}

function cloneOpenUIValue<T extends OpenUIValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneOpenUIValue(item)) as unknown as T;
  }
  if (isOpenUIComponentNode(value)) {
    const cloned: OpenUIComponentNode = {
      ...value,
      args: value.args.map((arg) => cloneOpenUIValue(arg)),
    };
    if (value.namedArgs) {
      const namedArgs: Record<string, OpenUIValue> = {};
      for (const [key, arg] of Object.entries(value.namedArgs)) {
        namedArgs[key] = cloneOpenUIValue(arg);
      }
      cloned.namedArgs = namedArgs;
    }
    return cloned as unknown as T;
  }
  const copy: Record<string, OpenUIValue> = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = cloneOpenUIValue(v);
  }
  return copy as unknown as T;
}

function scanFormControlsAndButtons(
  value: OpenUIValue,
  state: { hasFormField: boolean; hasButton: boolean; hasNoteField: boolean },
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => scanFormControlsAndButtons(child, state));
    return;
  }
  if (!isOpenUIComponentNode(value)) {
    Object.values(value).forEach((v) => scanFormControlsAndButtons(v, state));
    return;
  }

  if (FORM_FIELD_COMPONENTS.has(value.name)) {
    state.hasFormField = true;
    const fieldName = toStringArg(
      value.namedArgs?.name ?? value.namedArgs?.field ?? value.args[0],
    ).trim();
    if (value.name === 'Input' && fieldName === 'note') {
      state.hasNoteField = true;
    }
  }
  if (value.name === 'Button') {
    state.hasButton = true;
  }
  value.args.forEach((arg) => scanFormControlsAndButtons(arg, state));
  if (value.namedArgs) {
    Object.values(value.namedArgs).forEach((arg) => scanFormControlsAndButtons(arg, state));
  }
}

function findFirstButtonIndex(children: readonly OpenUIValue[]): number {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!isOpenUIComponentNode(child)) continue;
    if (child.name === 'Button') return i;
    if (
      child.name === 'Row' &&
      Array.isArray(child.args[0]) &&
      child.args[0].some((c) => isOpenUIComponentNode(c) && c.name === 'Button')
    ) {
      return i;
    }
  }
  return -1;
}

function createSynthesizedNoteNode(): OpenUIComponentNode {
  return {
    kind: 'component',
    name: 'Input',
    args: ['note', '', '', false],
    id: '__await_answer_note_slot',
  };
}

function createSynthesizedSubmitButtonNode(): OpenUIComponentNode {
  return {
    kind: 'component',
    name: 'Button',
    args: ['Send', 'primary', 'submit'],
    id: '__await_answer_submit_button',
  };
}

/**
 * 漏写提交按钮自动兜底：
 * 当 awaitAnswer === true 的表单包含输入控件（Choice / Input / DateInput / Slider）
 * 但模型漏写了 Button 时，自动在末尾补齐一个主 Button("Send", "primary", "submit")；
 * 若根容器末尾是 Tabs，则精准注入到最后一个 Tab 的 children 末尾，并挂载 note 备注槽位。
 */
export function ensureAwaitAnswerSubmitButton(
  astNodes: OpenUIComponentNode | readonly OpenUIComponentNode[],
  optionsOrAwaitAnswer: boolean | EnsureAwaitAnswerOptions = true,
): EnsureAwaitAnswerResult {
  const awaitAnswer =
    typeof optionsOrAwaitAnswer === 'boolean'
      ? optionsOrAwaitAnswer
      : (optionsOrAwaitAnswer.awaitAnswer ?? true);

  const isSingleRootInput = !Array.isArray(astNodes);
  const clonedNodes: OpenUIComponentNode[] = isSingleRootInput
    ? [cloneOpenUIValue(astNodes as OpenUIComponentNode)]
    : (astNodes as readonly OpenUIComponentNode[]).map((n) => cloneOpenUIValue(n));

  const scanState = { hasFormField: false, hasButton: false, hasNoteField: false };
  clonedNodes.forEach((node) => scanFormControlsAndButtons(node, scanState));

  const resolveRoot = (nodes: OpenUIComponentNode[]): OpenUIComponentNode | null => {
    if (nodes.length === 0) return null;
    if (nodes.length === 1 && isSingleRootInput) return nodes[0];
    return {
      kind: 'component',
      name: 'Stack',
      args: [nodes],
    };
  };

  if (!awaitAnswer || !scanState.hasFormField) {
    return {
      nodes: clonedNodes,
      root: resolveRoot(clonedNodes),
      injectedSubmitButton: false,
      injectedTarget: 'none',
      noteSlot: null,
    };
  }

  // 若已有显式 Button，不重复注入提交按钮，仅定位按钮行前的 note 槽位
  if (scanState.hasButton) {
    const containerChildren =
      clonedNodes.length === 1 &&
      clonedNodes[0].name === 'Stack' &&
      Array.isArray(clonedNodes[0].args[0])
        ? (clonedNodes[0].args[0] as OpenUIValue[])
        : clonedNodes;
    const btnIdx = findFirstButtonIndex(containerChildren);
    return {
      nodes: clonedNodes,
      root: resolveRoot(clonedNodes),
      injectedSubmitButton: false,
      injectedTarget: 'none',
      noteSlot: {
        target: 'before_buttons',
        index: btnIdx >= 0 ? btnIdx : containerChildren.length,
        fieldName: 'note',
      },
    };
  }

  // 获取根容器的直接 children 列表（支持 Stack([...]) 单根节点或顶层节点数组）
  const isRootStack =
    clonedNodes.length === 1 &&
    clonedNodes[0].name === 'Stack' &&
    Array.isArray(clonedNodes[0].args[0]);
  const rootChildren: OpenUIValue[] = isRootStack
    ? (clonedNodes[0].args[0] as OpenUIValue[])
    : clonedNodes;

  const tailNode = rootChildren.at(-1);
  if (isOpenUIComponentNode(tailNode) && tailNode.name === 'Tabs') {
    const rawTabs = Array.isArray(tailNode.args[0]) ? tailNode.args[0] : tailNode.args;
    let lastTabIndex = -1;
    for (let i = rawTabs.length - 1; i >= 0; i -= 1) {
      const candidate = rawTabs[i];
      if (isOpenUIComponentNode(candidate) && candidate.name === 'Tab') {
        lastTabIndex = i;
        break;
      }
    }

    if (lastTabIndex >= 0) {
      const lastTab = rawTabs[lastTabIndex] as OpenUIComponentNode;
      const tabChildren: OpenUIValue[] = Array.isArray(lastTab.args[1])
        ? (lastTab.args[1] as OpenUIValue[])
        : lastTab.args[1] !== undefined && lastTab.args[1] !== null
          ? [lastTab.args[1]]
          : [];

      const noteSlotIndex = tabChildren.length;
      if (!scanState.hasNoteField) {
        tabChildren.push(createSynthesizedNoteNode());
      }
      tabChildren.push(createSynthesizedSubmitButtonNode());
      lastTab.args[1] = tabChildren;

      return {
        nodes: clonedNodes,
        root: resolveRoot(clonedNodes),
        injectedSubmitButton: true,
        injectedTarget: 'last_tab',
        noteSlot: {
          target: 'last_tab',
          tabIndex: lastTabIndex,
          index: noteSlotIndex,
          fieldName: 'note',
        },
      };
    }
  }

  // 根容器末尾不是 Tabs：在根容器末尾挂载 note 槽位与 Button("Send", "primary", "submit")
  const noteSlotIndex = rootChildren.length;
  if (!scanState.hasNoteField) {
    const noteNode = createSynthesizedNoteNode();
    if (isRootStack) {
      rootChildren.push(noteNode);
    } else {
      clonedNodes.push(noteNode);
    }
  }

  const submitNode = createSynthesizedSubmitButtonNode();
  if (isRootStack) {
    rootChildren.push(submitNode);
  } else {
    clonedNodes.push(submitNode);
  }

  return {
    nodes: clonedNodes,
    root: resolveRoot(clonedNodes),
    injectedSubmitButton: true,
    injectedTarget: 'root',
    noteSlot: {
      target: 'root',
      index: noteSlotIndex,
      fieldName: 'note',
    },
  };
}

// ============================================================================
// 3. DSL 语法错误自动回传自愈 (buildOnNotDrawnAutoHealResult)
// ============================================================================

export interface OnNotDrawnAutoHealResult {
  answered: false;
  notDrawn: true;
  reason: 'ui-not-drawn';
  errors: string[];
  rawProgramLength: number;
  suppressRawSourceFallback: true;
  autoHealPrompt: string;
}

/**
 * 严格检测完整 openui-lang 程序的语法与结构问题（供渲染前门禁或 onNotDrawn 使用）：
 * 捕获未闭合引号、括号不配平、命名参数 `Component(key: val)`、未知组件名与解析报错。
 */
export function detectOpenUILangSyntaxErrors(rawProgram: string): string[] {
  const errors: string[] = [];
  const trimmed = (rawProgram ?? '').trim();
  if (!trimmed) {
    return ['Empty openui-lang program: root = Stack([...]) is required'];
  }

  // 扫描字符串闭合、括号栈与调用内命名参数 `Component(key: value)`
  const stack: Array<'(' | '[' | '{'> = [];
  const matchingCloser: Record<')' | ']' | '}', '(' | '[' | '{'> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };
  let quote: '"' | "'" | null = null;
  let line = 1;
  let quoteStartLine = 1;
  const namedArgHits = new Set<string>();

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\n') line += 1;

    if (quote) {
      if (ch === '\\' && i + 1 < trimmed.length) {
        i += 1;
        if (trimmed[i] === '\n') line += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if ((ch === '/' && trimmed[i + 1] === '/') || (ch === '#' && (i === 0 || /[\s;([{,]/.test(trimmed[i - 1])))) {
      while (i < trimmed.length && trimmed[i] !== '\n') {
        i += 1;
      }
      line += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteStartLine = line;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      const expected = matchingCloser[ch];
      const top = stack.at(-1);
      if (top !== expected) {
        errors.push(`Unmatched delimiter "${ch}" at line ${line}`);
      } else {
        stack.pop();
      }
      continue;
    }

    // 在函数调用小括号顶层检测 `key: value` 命名参数误写（参考 OpenChamber namedArgumentError）
    if (ch === ':' && stack.at(-1) === '(') {
      const before = trimmed.slice(0, i);
      const match = /(?:[(,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
      if (match) {
        namedArgHits.add(match[1]);
      }
    }
  }

  if (quote) {
    errors.push(`Unterminated string literal (${quote}) starting at line ${quoteStartLine}`);
  }
  if (stack.length > 0) {
    errors.push(`Unclosed delimiter(s): ${stack.join(' ')} (block ended mid-statement)`);
  }
  if (namedArgHits.size > 0) {
    errors.push(
      `Named arguments are not supported in openui-lang calls: pass ${[...namedArgHits].join(', ')} by position`,
    );
  }

  const parsed = parseOpenUILang(trimmed);
  errors.push(...parsed.errors);

  if (!parsed.root) {
    errors.push('Missing valid entry component: define `root = Stack([...])`');
  } else {
    const checkKnownComponents = (val: OpenUIValue): void => {
      if (!val || typeof val !== 'object') return;
      if (Array.isArray(val)) {
        val.forEach(checkKnownComponents);
        return;
      }
      if (isOpenUIComponentNode(val)) {
        if (!KNOWN_OPENUI_CATALOG_COMPONENTS.has(val.name)) {
          errors.push(`Unknown component "${val.name}" is not in the openui-lang catalog`);
        }
        val.args.forEach(checkKnownComponents);
        if (val.namedArgs) Object.values(val.namedArgs).forEach(checkKnownComponents);
      }
    };
    checkKnownComponents(parsed.root);
  }

  return [...new Set(errors)];
}

function normalizeSyntaxErrors(syntaxError: string | readonly string[] | Error): string[] {
  const rawList =
    typeof syntaxError === 'string'
      ? [syntaxError]
      : syntaxError instanceof Error
        ? [syntaxError.message]
        : Array.from(syntaxError);

  const cleaned = rawList
    .map((item) => String(item ?? '').trim().slice(0, 500))
    .filter((item) => item.length > 0)
    .slice(0, 20);

  return cleaned.length > 0 ? cleaned : ['Unknown openui-lang syntax error'];
}

/**
 * 当 openui-lang 源码解析报错时，构造结构化工具返回 `{ answered: false, notDrawn: true, autoHealPrompt }`，
 * 指导模型在同一轮内自动修正语法并重绘，而不把半截源码甩给用户。
 */
export function buildOnNotDrawnAutoHealResult(
  rawProgram: string,
  syntaxError: string | readonly string[] | Error,
): OnNotDrawnAutoHealResult {
  const source = typeof rawProgram === 'string' ? rawProgram : '';
  const errors = normalizeSyntaxErrors(syntaxError);
  const previewSnippet =
    source.trim().length > 600 ? `${source.trim().slice(0, 600)}\n...` : source.trim();

  const promptLines = [
    'The chat could not draw this openui-lang UI block, and raw source was hidden from the user.',
    'Do NOT ask the user to read raw DSL or apologize at length; fix the syntax errors below and call the render tool again in this same turn:',
    '',
    'Detected parser/schema errors:',
    ...errors.map((err, idx) => `${idx + 1}. ${err}`),
    '',
    'Required openui-lang repair checklist:',
    '- Define `root = Stack([...])` as the entry node.',
    '- Pass all component arguments positionally (never `Component(key: value)`).',
    '- Ensure all quotes, parentheses `()`, brackets `[]`, and braces `{}` are balanced.',
    '- Use only supported catalog components (Stack, Row, Card, Tabs, Tab, Details, Text, Badge, Callout, KeyValue, Table, Stat, Progress, Steps, BarChart, LineChart, Series, Choice, Input, DateInput, Slider, Button).',
  ];

  if (previewSnippet) {
    promptLines.push('', 'Submitted program excerpt:', '```openui-lang', previewSnippet, '```');
  }

  return {
    answered: false,
    notDrawn: true,
    reason: 'ui-not-drawn',
    errors,
    rawProgramLength: source.length,
    suppressRawSourceFallback: true,
    autoHealPrompt: promptLines.join('\n'),
  };
}
