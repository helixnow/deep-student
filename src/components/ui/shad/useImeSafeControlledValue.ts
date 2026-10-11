import * as React from 'react';

/**
 * 受控输入框的 IME 组字保护（#455）。
 *
 * 背景：Android WebView 下搜狗等输入法的英文/日文模式会把正在输入的单词作为
 * composition（setComposingText）放进输入框。受控输入框每个 input 事件都会把
 * 值抛给父组件，父组件的过滤 / store 写入 / 列表重排随之发生；一旦父组件回写的
 * 值与 DOM 不一致（异步写回、规范化、上一帧旧值），React 就会在组字途中改写
 * input.value，Chromium 随即重启输入连接——表现为输入内容不显示、输入法界面
 * 抖动，输入法状态被打乱后连中文也无法上屏。
 *
 * 做法与 Vue v-model 一致：组字期间只在本地 draft 里跟随 DOM（React 渲染值恒等于
 * DOM 值，不会回写），不向父组件派发 onChange；compositionend（或组字中失焦）时
 * 用最终值补发一次 onChange。非组字输入（英文硬键盘、粘贴、删除）照常逐次派发。
 *
 * 只在「受控」（同时有 value 与 onChange）时生效；非受控输入原样透传。
 */

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export interface ImeSafeControlledProps<E extends FieldElement> {
  value?: string | number | readonly string[];
  onChange?: React.ChangeEventHandler<E>;
  onCompositionStart?: React.CompositionEventHandler<E>;
  onCompositionEnd?: React.CompositionEventHandler<E>;
  onBlur?: React.FocusEventHandler<E>;
}

/** 组字结束 / 失焦补发的 onChange：沿用原事件的原型链（preventDefault 等方法可用），target 指向输入框 */
function asChangeEvent<E extends FieldElement>(
  event: React.SyntheticEvent<E>,
): React.ChangeEvent<E> {
  const element = event.currentTarget;
  return Object.create(event, {
    type: { value: 'change' },
    target: { value: element },
    currentTarget: { value: element },
  }) as React.ChangeEvent<E>;
}

export function useImeSafeControlledValue<E extends FieldElement>(
  props: ImeSafeControlledProps<E>,
): Required<Pick<ImeSafeControlledProps<E>, 'onChange' | 'onCompositionStart' | 'onCompositionEnd' | 'onBlur'>> &
  Pick<ImeSafeControlledProps<E>, 'value'> {
  const { value, onChange, onCompositionStart, onCompositionEnd, onBlur } = props;
  const controlled = value !== undefined && typeof onChange === 'function';

  // 组字期间的本地值；null = 跟随父组件 value
  const [draft, setDraft] = React.useState<string | null>(null);
  const composingRef = React.useRef(false);
  // 组字结束时已补发的值：WebKit 会在 compositionend 之后再派发一次同值 input，去重用
  const flushedValueRef = React.useRef<string | null>(null);

  // 事件处理器读最新 props，避免闭包拿到上一帧的 value / onChange
  const latestRef = React.useRef(props);
  latestRef.current = props;

  const flush = (event: React.SyntheticEvent<E>) => {
    composingRef.current = false;
    setDraft(null);
    const nextValue = event.currentTarget.value;
    const current = latestRef.current.value;
    if (current !== undefined && nextValue === String(current)) return;
    flushedValueRef.current = nextValue;
    latestRef.current.onChange?.(asChangeEvent(event));
  };

  const handleCompositionStart = (event: React.CompositionEvent<E>) => {
    latestRef.current.onCompositionStart?.(event);
    if (!controlled) return;
    composingRef.current = true;
    flushedValueRef.current = null;
    setDraft(event.currentTarget.value);
  };

  const handleChange = (event: React.ChangeEvent<E>) => {
    if (!controlled) {
      latestRef.current.onChange?.(event);
      return;
    }
    // 个别输入法丢失 compositionend：原生 input 事件明确报告不在组字中时，视为组字已结束
    if (composingRef.current && (event.nativeEvent as InputEvent).isComposing === false) {
      composingRef.current = false;
    }
    if (composingRef.current) {
      setDraft(event.target.value);
      return;
    }
    const flushed = flushedValueRef.current;
    flushedValueRef.current = null;
    if (draft !== null) setDraft(null);
    if (flushed !== null && flushed === event.target.value) return;
    latestRef.current.onChange?.(event);
  };

  const handleCompositionEnd = (event: React.CompositionEvent<E>) => {
    latestRef.current.onCompositionEnd?.(event);
    if (!controlled || !composingRef.current) return;
    flush(event);
  };

  const handleBlur = (event: React.FocusEvent<E>) => {
    // 组字中失焦（输入法未派发 compositionend）：把已上屏的内容交给父组件，不丢字
    if (controlled && composingRef.current) flush(event);
    latestRef.current.onBlur?.(event);
  };

  return {
    value: controlled && draft !== null ? draft : value,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    onBlur: handleBlur,
  };
}
