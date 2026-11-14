import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cancelRender, continueRender, delayRender } from 'remotion';

/**
 * 逐帧渲染时，主应用组件的内部状态（选中项、展开层数……）不能靠真实点击推进：每一帧都可能在一个新页面里渲染。
 * Staged 按 step 重放前 step 个动作：step 变化时整棵子树重挂载，再一步一次提交地执行动作，
 * 期间用 delayRender 挡住截帧。同一个 step 永远得到同一个界面状态。
 */
export type StageAction = (root: HTMLElement) => void | Promise<void>;

export const click = (selector: string, index = 0): StageAction => (root) => {
  const el = root.querySelectorAll<HTMLElement>(selector)[index];
  if (!el) throw new Error(`[Staged] no element matches ${selector} [${index}]`);
  el.click();
};

const until = (root: HTMLElement, ready: () => boolean, what: string, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    if (ready()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`[Staged] ${what} did not appear within ${timeoutMs}ms`));
    }, timeoutMs);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  });

/** 等某个元素出现：界面要等一次异步返回（取数、结算请求）才更新时用。 */
export const waitFor = (selector: string, timeoutMs = 5000): StageAction => (root) =>
  until(root, () => root.querySelector(selector) !== null, selector, timeoutMs);

/** 等某段文字出现：没有稳定选择器可等时用。 */
export const waitForText = (text: string, timeoutMs = 5000): StageAction => (root) =>
  until(root, () => root.textContent?.includes(text) ?? false, `text "${text}"`, timeoutMs);

/** 往输入框里填字（走 React 认的原生 setter + input 事件）。打字过程由镜头按 t 传入逐步变长的 text。 */
export const typeText = (selector: string, text: string): StageAction => (root) => {
  const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`[Staged] no element matches ${selector}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** 镜头里按时间推进 step：times 是各动作发生的时刻（升序），返回 t 时刻已经发生的动作数。 */
export const stepAt = (t: number, times: number[]): number => times.filter((at) => t >= at).length;

const Replay = ({ actions, children }: { actions: StageAction[]; children: ReactNode }) => {
  const root = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(0);
  const handle = useRef<number | null>(null);
  if (handle.current === null && done < actions.length) handle.current = delayRender('Staged: replaying UI actions');
  const release = () => {
    if (handle.current !== null) {
      continueRender(handle.current);
      handle.current = null;
    }
  };
  useEffect(() => {
    if (done >= actions.length) {
      release();
      return undefined;
    }
    let stale = false;
    new Promise<void>((resolve) => resolve(root.current ? actions[done](root.current) : undefined)).then(
      () => {
        if (!stale) setDone(done + 1);
      },
      (error: unknown) => cancelRender(error),
    );
    return () => {
      stale = true;
    };
  }, [done]);
  useEffect(() => release, []);
  return (
    <div ref={root} style={{ display: 'contents' }}>
      {children}
    </div>
  );
};

export const Staged = ({ actions, step, children }: { actions: StageAction[]; step: number; children: ReactNode }) => (
  <Replay key={step} actions={actions.slice(0, Math.max(0, step))}>
    {children}
  </Replay>
);
