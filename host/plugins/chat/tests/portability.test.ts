/**
 * chat 进入 `host/profiles/mobile.json` 的条件：运行时闭包（`import type` 不计）不得触达 Node 专有依赖。
 * 同步文件系统能力（AGENTS.md 发现、附件落盘、runtime roots）经 `local-fs.ts` / `runtime-roots.ts`
 * 端口隔离，桌面实现在 `*.node.ts` 里只由 `index.ts` 注入，移动端入口不导入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeSource, checkModulesClosure, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CHAT = 'host/plugins/chat';

function productionFiles(): string[] {
  const files = [`${CHAT}/api.ts`, `${CHAT}/mobile.ts`];
  for (const dir of ['src', 'repository']) {
    for (const name of fs.readdirSync(path.join(ROOT, CHAT, dir))) {
      if (!name.endsWith('.ts') || name.endsWith('.node.ts')) continue;
      files.push(`${CHAT}/${dir}/${name}`);
    }
  }
  return files;
}

describe('chat mobile portability', () => {
  it('no chat module other than the desktop-only node ports has its own Node-specific runtime dep', () => {
    const own: string[] = [];
    for (const file of productionFiles()) {
      const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const finding of analysis.findings) {
        if (!finding.typeOnly) own.push(`${file}:${finding.line} ${findingKey(finding)}`);
      }
    }
    expect(own).toEqual([]);
  });

  it('the runtime closure of host/plugins/chat/mobile.ts is free of Node-specific deps', () => {
    expect(checkModulesClosure(ROOT, [`${CHAT}/mobile.ts`])).toEqual([]);
  });

  it('host/profiles/mobile.json installs chat from the mobile entry', () => {
    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'host/profiles/mobile.json'), 'utf8'));
    const entry = profile.plugins.find((plugin: { id: string }) => plugin.id === 'dstu.chat');
    expect(entry?.module).toBe('../plugins/chat/mobile.ts');
  });
});
