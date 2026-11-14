/**
 * `plugin:fs|*` 的命令面必须与本仓库实际编译的 `tauri-plugin-fs` 2.4.5 一致：
 * 该 crate 的 `watch` feature 不是默认 feature（Cargo.toml `[features] watch = [...]`），
 * 本仓库 `src-tauri/Cargo.toml:97` 用默认 features，`src-tauri/Cargo.lock` 没有 `notify` /
 * `notify-debouncer-full`，因此 Rust 版本没有注册 `plugin:fs|watch`；`unwatch` 也不是上游命令
 * （JS 侧通过 `plugin:resources|close` 释放 watcher）。TS 插件同样不注册这两个命令，
 * 未知命令仍由 runtime 的 not-found 分支拒绝。
 */
import { describe, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import { fsPlugin } from '../shell/plugins/fs.ts';

describe('fs plugin surface (tauri-plugin-fs 2.4.5 without the watch feature)', () => {
  it('registers the compiled command table and omits watch/unwatch', () => {
    const scopes = {
      global: new FsScope({ platform: 'linux' }),
      runtime: new FsScope({ platform: 'linux' }),
    };
    const plugin = fsPlugin(scopes);
    expect(Object.keys(plugin)).toContain('read_file');
    expect(Object.keys(plugin)).toContain('write_text_file');
    expect(Object.keys(plugin)).not.toContain('watch');
    expect(Object.keys(plugin)).not.toContain('unwatch');
  });
});
