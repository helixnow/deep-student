/**
 * WallpaperManagerDialog 测试：
 * open 门控 / 预设网格与选中态 / 点击预设持久化 + settings-changed /
 * 自定义库加载与应用 / 导入成功刷新并应用 / 删除当前壁纸回退默认 /
 * 图片调节滑块防抖落盘 / 库上限禁用导入 / localStorage 回退
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { convertFileSrcMock, invokeMock, settingsStore, listMock, importMock, removeMock } =
  vi.hoisted(() => {
    const settingsStore = new Map<string, string>();
    const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'save_setting') {
        settingsStore.set(String(args?.key), String(args?.value));
        return null;
      }
      if (command === 'get_setting') {
        return settingsStore.get(String(args?.key)) ?? null;
      }
      return null;
    });
    return {
      convertFileSrcMock: vi.fn((path: string) => `asset://localhost/${path}`),
      invokeMock,
      settingsStore,
      listMock: vi.fn(async (): Promise<Array<{ path: string; fileName: string }>> => []),
      importMock: vi.fn(),
      removeMock: vi.fn(async () => {}),
    };
  });

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: convertFileSrcMock,
  invoke: invokeMock,
}));

vi.mock('@/features/settings/components/wallpaperLibrary', () => ({
  CUSTOM_WALLPAPER_LIBRARY_LIMIT: 24,
  listCustomWallpapers: listMock,
  importWallpaperToLibrary: importMock,
  removeCustomWallpaper: removeMock,
}));

import {
  WallpaperManagerDialog,
  OPEN_WALLPAPER_MANAGER_EVENT,
} from '../WallpaperManagerDialog';
import {
  WALLPAPER_PRESETS,
  DEFAULT_WALLPAPER,
  type WallpaperConfig,
} from '../WallpaperLayer';

const WALLPAPER_KEY = 'desktop.workbenchWallpaper';

function readPersisted(): WallpaperConfig | null {
  const raw = settingsStore.get(WALLPAPER_KEY);
  return raw ? (JSON.parse(raw) as WallpaperConfig) : null;
}

function listenSettingsChanged(): { events: Array<{ key: string; value: unknown }>; dispose: () => void } {
  const events: Array<{ key: string; value: unknown }> = [];
  const onChanged = (event: Event) => {
    events.push((event as CustomEvent<{ key: string; value: unknown }>).detail);
  };
  window.addEventListener('workbench:settings-changed', onChanged);
  return { events, dispose: () => window.removeEventListener('workbench:settings-changed', onChanged) };
}

beforeEach(() => {
  settingsStore.clear();
  localStorage.clear();
  invokeMock.mockClear();
  convertFileSrcMock.mockClear();
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  importMock.mockReset();
  removeMock.mockReset();
  removeMock.mockResolvedValue(undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('WallpaperManagerDialog', () => {
  it('导出入口事件名契约', () => {
    expect(OPEN_WALLPAPER_MANAGER_EVENT).toBe('workbench:open-wallpaper-manager');
  });

  it('open=false 渲染 null', () => {
    render(
      <WallpaperManagerDialog open={false} wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('wpm-dialog')).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('渲染全部预设卡片，当前生效项带选中态', () => {
    render(
      <WallpaperManagerDialog
        open
        wallpaper={{ kind: 'theme', value: 'lagoon' }}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByTestId('wpm-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (const preset of WALLPAPER_PRESETS) {
      expect(screen.getByTestId(`wpm-preset-${preset.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('wpm-preset-lagoon')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('wpm-preset-aurora')).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击预设 → save_setting 持久化 + 派发 settings-changed，面板不关闭', async () => {
    const onClose = vi.fn();
    const { events, dispose } = listenSettingsChanged();
    try {
      render(
        <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={onClose} />,
      );
      fireEvent.click(screen.getByTestId('wpm-preset-nebula'));

      const expected = { kind: 'theme', value: 'nebula' };
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('save_setting', {
          key: WALLPAPER_KEY,
          value: JSON.stringify(expected),
        });
      });
      expect(events).toContainEqual({ key: WALLPAPER_KEY, value: expected });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('wpm-dialog')).toBeInTheDocument();
    } finally {
      dispose();
    }
  });

  it('非 Tauri 环境回退 localStorage', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('wpm-preset-sand'));
    await waitFor(() => {
      expect(localStorage.getItem(WALLPAPER_KEY)).toBe(
        JSON.stringify({ kind: 'theme', value: 'sand' }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('加载自定义列表，缩略图走 convertFileSrc，点击应用并保留调节参数', async () => {
    const path = '/appdata/workbench-wallpapers/wallpaper-a.png';
    listMock.mockResolvedValue([{ path, fileName: 'wallpaper-a.png' }]);
    render(
      <WallpaperManagerDialog
        open
        wallpaper={{
          kind: 'image',
          value: '/appdata/workbench-wallpapers/wallpaper-old.png',
          imageBlur: 12,
          imageDim: 0.2,
          imageVignette: false,
        }}
        onClose={() => {}}
      />,
    );

    const card = await screen.findByTestId('wpm-custom-wallpaper-a.png');
    expect(convertFileSrcMock).toHaveBeenCalledWith(path);
    fireEvent.click(card);

    await waitFor(() => {
      expect(readPersisted()).toEqual({
        kind: 'image',
        value: path,
        imageBlur: 12,
        imageDim: 0.2,
        imageVignette: false,
      });
    });
  });

  it('空库显示空态文案', async () => {
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    expect(await screen.findByTestId('wpm-empty')).toBeInTheDocument();
  });

  it('导入成功 → 刷新列表并立即应用新导入项', async () => {
    const newPath = '/appdata/workbench-wallpapers/wallpaper-new.png';
    listMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ path: newPath, fileName: 'wallpaper-new.png' }]);
    importMock.mockResolvedValue({
      status: 'success',
      entry: { path: newPath, fileName: 'wallpaper-new.png' },
    });

    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('wpm-import'));

    await screen.findByTestId('wpm-custom-wallpaper-new.png');
    await waitFor(() => {
      expect(readPersisted()).toMatchObject({ kind: 'image', value: newPath });
    });
    expect(importMock).toHaveBeenCalledWith(
      expect.objectContaining({ pickerTitle: expect.any(String) }),
    );
    expect(screen.queryByTestId('wpm-import-error')).toBeNull();
  });

  it('导入 cancelled 忽略；limit-exceeded / error 显示内联错误', async () => {
    importMock.mockResolvedValueOnce({ status: 'cancelled' });
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    const importButton = screen.getByTestId('wpm-import');

    fireEvent.click(importButton);
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('wpm-import-error')).toBeNull();

    importMock.mockResolvedValueOnce({ status: 'limit-exceeded', limit: 24 });
    fireEvent.click(importButton);
    expect(await screen.findByTestId('wpm-import-error')).toBeInTheDocument();

    importMock.mockResolvedValueOnce({ status: 'error', error: new Error('boom') });
    fireEvent.click(importButton);
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('wpm-import-error')).toBeInTheDocument();
    expect(readPersisted()).toBeNull();
  });

  it('导入进行中按钮禁用（loading）', async () => {
    let resolveImport!: (value: { status: 'cancelled' }) => void;
    importMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    const importButton = screen.getByTestId('wpm-import');
    fireEvent.click(importButton);

    await waitFor(() => expect(importButton).toBeDisabled());
    expect(importButton).toHaveAttribute('data-loading', 'true');
    resolveImport({ status: 'cancelled' });
    await waitFor(() => expect(importButton).not.toBeDisabled());
  });

  it('删除当前生效壁纸 → 移除后回退应用 DEFAULT_WALLPAPER', async () => {
    const path = '/appdata/workbench-wallpapers/wallpaper-current.png';
    listMock
      .mockResolvedValueOnce([{ path, fileName: 'wallpaper-current.png' }])
      .mockResolvedValue([]);

    render(
      <WallpaperManagerDialog
        open
        wallpaper={{ kind: 'image', value: path }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId('wpm-remove-wallpaper-current.png'));

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith(path));
    await waitFor(() => {
      expect(readPersisted()).toEqual(DEFAULT_WALLPAPER);
    });
    await screen.findByTestId('wpm-empty');
  });

  it('删除非当前壁纸只刷新列表，不改当前设置', async () => {
    const path = '/appdata/workbench-wallpapers/wallpaper-other.png';
    listMock
      .mockResolvedValueOnce([{ path, fileName: 'wallpaper-other.png' }])
      .mockResolvedValue([]);

    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('wpm-remove-wallpaper-other.png'));

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith(path));
    await screen.findByTestId('wpm-empty');
    expect(readPersisted()).toBeNull();
  });

  it('图片调节：滑块防抖写入 imageBlur/imageDim，开关写入 imageVignette', async () => {
    const path = '/appdata/workbench-wallpapers/wallpaper-cur.png';
    render(
      <WallpaperManagerDialog
        open
        wallpaper={{ kind: 'image', value: path }}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('wpm-blur'), { target: { value: '20' } });
    await waitFor(() => {
      expect(readPersisted()).toEqual({
        kind: 'image',
        value: path,
        imageBlur: 20,
        imageDim: 0,
        imageVignette: true,
      });
    });

    fireEvent.change(screen.getByTestId('wpm-dim'), { target: { value: '0.3' } });
    await waitFor(() => {
      expect(readPersisted()).toMatchObject({ imageBlur: 20, imageDim: 0.3 });
    });

    fireEvent.click(screen.getByTestId('wpm-vignette'));
    await waitFor(() => {
      expect(readPersisted()).toMatchObject({ imageVignette: false });
    });
  });

  it('主题壁纸不显示图片调节区', () => {
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('wpm-adjust')).toBeNull();
  });

  it('数量达到上限 → 禁用导入按钮并显示上限提示', async () => {
    listMock.mockResolvedValue(
      Array.from({ length: 24 }, (_, i) => ({
        path: `/appdata/workbench-wallpapers/wallpaper-${i}.png`,
        fileName: `wallpaper-${i}.png`,
      })),
    );
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId('wpm-import')).toBeDisabled());
    expect(screen.getByTestId('wpm-limit-hint')).toBeInTheDocument();
  });

  it('Esc 与点击遮罩关闭面板', () => {
    const onClose = vi.fn();
    render(
      <WallpaperManagerDialog open wallpaper={DEFAULT_WALLPAPER} onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId('wpm-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);

    // 点面板本体不关闭
    fireEvent.mouseDown(screen.getByTestId('wpm-dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
