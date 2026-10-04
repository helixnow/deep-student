import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 防回归契约：发布版 CSP 不得屏蔽 innerHTML 写入的 style 属性。
 *
 * 背景：v0.9.43–v0.9.73 的 index.html 带内联 <style>（启动画面）。打包时
 * Tauri 把它的 sha256 追加进 CSP 的 style-src，而 style-src 里一旦出现
 * hash/nonce，浏览器就忽略 'unsafe-inline'——经 innerHTML 写入的
 * style="top:…;height:…" 全部被拦。KaTeX（renderToString +
 * dangerouslySetInnerHTML）靠这些内联定位排布分子分母与上下标，结果
 * 发布版公式全面错位；tauri dev 不内嵌资源、不注入 hash，开发时看不出来。
 *
 * 同理，运行时注入的 <style> 元素（如引用徽章样式）也会被连带拦截。
 *
 * 修复：CSP 显式声明 style-src-elem / style-src-attr。Tauri 只往 style-src
 * 注入 hash，不碰这两条细分指令，浏览器对元素与属性改按它们判定。
 */

const readText = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

const parseCsp = (csp: string): Map<string, string[]> =>
  new Map(
    csp
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name, sources] as [string, string[]]),
  );

const confFiles = readdirSync(resolve(process.cwd(), 'src-tauri')).filter((name) =>
  /^tauri(\.[a-z]+)?\.conf\.json$/.test(name),
);

describe('CSP inline style attribute contract', () => {
  it('base config allows style attributes independently of style-src hashes', () => {
    const conf = JSON.parse(readText('src-tauri/tauri.conf.json'));
    const csp = parseCsp(conf.app.security.csp);
    expect(csp.get('style-src-attr')).toContain("'unsafe-inline'");
    expect(csp.get('style-src-elem')).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
  });

  it.each(confFiles)('%s does not override CSP without style-src-attr', (file) => {
    const conf = JSON.parse(readText(`src-tauri/${file}`));
    const csp: unknown = conf.app?.security?.csp;
    if (typeof csp !== 'string') return;
    const parsed = parseCsp(csp);
    expect(parsed.get('style-src-attr')).toContain("'unsafe-inline'");
    expect(parsed.get('style-src-elem')).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
  });
});
