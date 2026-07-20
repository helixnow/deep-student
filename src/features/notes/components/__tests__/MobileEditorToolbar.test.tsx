/**
 * MobileEditorToolbar — 按钮回调触发 + visible 受控 + visualViewport bottom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MobileEditorToolbar,
  computeViewportBottomOffset,
  type MobileEditorToolbarCommands,
} from '../MobileEditorToolbar';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key.split('.').at(-1) ?? key,
  }),
}));

function mockCommands(): MobileEditorToolbarCommands {
  return {
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleStrikethrough: vi.fn(),
    insertHeading: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleTaskList: vi.fn(),
    indent: vi.fn(),
    outdent: vi.fn(),
    insertImage: vi.fn(),
    openSlash: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
}

function byAction(id: string): HTMLButtonElement {
  return document.querySelector(`[data-action="${id}"]`) as HTMLButtonElement;
}

function actionOrder(): string[] {
  return Array.from(document.querySelectorAll('.mobile-editor-toolbar__btn')).map(
    (el) => (el as HTMLElement).dataset.action ?? '',
  );
}

afterEach(() => {
  cleanup();
});

describe('MobileEditorToolbar', () => {
  it('visible=false 时不渲染', () => {
    const commands = mockCommands();
    const { container } = render(
      <MobileEditorToolbar commands={commands} visible={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('mobile-editor-toolbar')).not.toBeInTheDocument();
  });

  it('visible=true 时渲染横向可滚动工具条', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    expect(screen.getByRole('toolbar', { name: '移动端编辑工具条' })).toBeInTheDocument();
    expect(screen.getByTestId('mobile-editor-toolbar-scroller')).toBeInTheDocument();
  });

  it('按钮按逻辑分组顺序：插入开关 | 撤销重做 | B/I/S | 标题列表 | 缩进', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    expect(actionOrder()).toEqual([
      'insert-toggle',
      'undo',
      'redo',
      'bold',
      'italic',
      'strikethrough',
      'h1',
      'h2',
      'h3',
      'bullet',
      'task',
      'outdent',
      'indent',
    ]);
    // 每组前一条分隔线（4 组 → 4 sep）
    expect(screen.getAllByTestId('mobile-editor-toolbar-sep')).toHaveLength(4);
  });

  it('各按钮点击触发对应 commands 回调', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);

    fireEvent.click(byAction('undo'));
    expect(commands.undo).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('redo'));
    expect(commands.redo).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('outdent'));
    expect(commands.outdent).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('indent'));
    expect(commands.indent).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('bold'));
    expect(commands.toggleBold).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('italic'));
    expect(commands.toggleItalic).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('strikethrough'));
    expect(commands.toggleStrikethrough).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('h1'));
    expect(commands.insertHeading).toHaveBeenCalledWith(1);

    fireEvent.click(byAction('h2'));
    expect(commands.insertHeading).toHaveBeenCalledWith(2);

    fireEvent.click(byAction('h3'));
    expect(commands.insertHeading).toHaveBeenCalledWith(3);

    fireEvent.click(byAction('bullet'));
    expect(commands.toggleBulletList).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('task'));
    expect(commands.toggleTaskList).toHaveBeenCalledTimes(1);
  });

  it('插入条：展开后含 image/slash，点击后触发回调并收起', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);

    expect(screen.queryByTestId('mobile-editor-toolbar-insert-row')).not.toBeInTheDocument();
    fireEvent.click(byAction('insert-toggle'));
    expect(screen.getByTestId('mobile-editor-toolbar-insert-row')).toBeInTheDocument();

    fireEvent.click(byAction('image'));
    expect(commands.insertImage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('mobile-editor-toolbar-insert-row')).not.toBeInTheDocument();

    fireEvent.click(byAction('insert-toggle'));
    fireEvent.click(byAction('slash'));
    expect(commands.openSlash).toHaveBeenCalledTimes(1);
  });

  it('可选插入命令（link/table）注入后出现在插入条', () => {
    const commands: MobileEditorToolbarCommands = {
      ...mockCommands(),
      insertLink: vi.fn(),
      insertTable: vi.fn(),
    };
    render(<MobileEditorToolbar commands={commands} visible />);

    fireEvent.click(byAction('insert-toggle'));
    fireEvent.click(byAction('link'));
    expect(commands.insertLink).toHaveBeenCalledTimes(1);

    fireEvent.click(byAction('insert-toggle'));
    fireEvent.click(byAction('table'));
    expect(commands.insertTable).toHaveBeenCalledTimes(1);
  });

  it('未注入可选命令时不渲染对应按钮', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    fireEvent.click(byAction('insert-toggle'));
    expect(byAction('link')).toBeNull();
    expect(byAction('table')).toBeNull();
    expect(byAction('codeblock')).toBeNull();
    expect(byAction('find')).toBeNull();
  });

  it('openFind 注入后展示查找入口并触发回调', () => {
    const commands: MobileEditorToolbarCommands = {
      ...mockCommands(),
      openFind: vi.fn(),
    };
    render(<MobileEditorToolbar commands={commands} visible />);

    const find = byAction('find');
    expect(find).toBeTruthy();
    expect(find.getAttribute('aria-label')).toBe('查找');
    fireEvent.click(find);
    expect(commands.openFind).toHaveBeenCalledTimes(1);
  });

  it('toggleStrikethrough 未注入时点击删除线不抛错', () => {
    const commands = mockCommands();
    delete commands.toggleStrikethrough;
    render(<MobileEditorToolbar commands={commands} visible />);
    expect(() => fireEvent.click(byAction('strikethrough'))).not.toThrow();
  });

  it('activeStates 透传 data-active 与 aria-pressed', () => {
    const commands = mockCommands();
    render(
      <MobileEditorToolbar
        commands={commands}
        visible
        activeStates={{ bold: true, italic: false, h2: true }}
      />,
    );
    expect(byAction('bold').getAttribute('data-active')).toBe('true');
    expect(byAction('bold').getAttribute('aria-pressed')).toBe('true');
    expect(byAction('italic').getAttribute('data-active')).toBeNull();
    expect(byAction('italic').getAttribute('aria-pressed')).toBe('false');
    expect(byAction('h2').getAttribute('data-active')).toBe('true');
    expect(byAction('undo').getAttribute('aria-pressed')).toBeNull();
  });

  it('未传 activeStates 时无 data-active', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    expect(byAction('bold').getAttribute('data-active')).toBeNull();
    expect(byAction('bold').getAttribute('aria-pressed')).toBe('false');
  });

  it('按钮带 44px 命中区 class 契约', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    const btn = document.querySelector('.mobile-editor-toolbar__btn');
    expect(btn).toBeTruthy();
    expect(btn?.className).toContain('mobile-editor-toolbar__btn');
  });

  it('mousedown 默认 preventDefault，避免抢走编辑器焦点', () => {
    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);
    const btn = byAction('bold');
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !btn.dispatchEvent(ev);
    expect(prevented || ev.defaultPrevented).toBe(true);
  });

});

describe('computeViewportBottomOffset', () => {
  const originalInnerHeight = window.innerHeight;
  const originalVV = window.visualViewport;

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVV,
    });
  });

  it('无 visualViewport 时返回 0', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: null,
    });
    expect(computeViewportBottomOffset()).toBe(0);
  });

  it('按 innerHeight - (offsetTop + height) 计算键盘占用', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { offsetTop: 0, height: 500 },
    });
    expect(computeViewportBottomOffset()).toBe(300);
  });

  it('visible 时监听 visualViewport 并写入 keyboard offset CSS 变量', () => {
    const listeners = new Map<string, Set<() => void>>();
    const vv = {
      offsetTop: 0,
      height: 700,
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: vv,
    });

    const commands = mockCommands();
    render(<MobileEditorToolbar commands={commands} visible />);

    const toolbar = screen.getByTestId('mobile-editor-toolbar');
    expect(toolbar.style.getPropertyValue('--mobile-toolbar-keyboard-offset')).toBe('100px');

    // 模拟键盘再升高：visualViewport 变矮
    (vv as { height: number }).height = 400;
    act(() => {
      listeners.get('resize')?.forEach((fn) => fn());
    });
    expect(toolbar.style.getPropertyValue('--mobile-toolbar-keyboard-offset')).toBe('400px');
  });
});
