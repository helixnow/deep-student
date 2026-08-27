import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 契约意图：check-i18n 脚本必须可作为独立 npm script 消费，
 * 且具备 CI 可用的退出语义：
 *   - 默认模式：跨语言缺键 / 叶子非字符串 / JSON 解析失败 / locale 文件缺失 → exit 1
 *   - --strict：额外将 t() 引用键缺失、命名空间缺文件计入失败
 * 本测试只做源码断言，不执行脚本（不 spawn node）。
 */

const scriptPath = resolve(process.cwd(), 'scripts/check-i18n.mjs');

describe('check-i18n script wiring contract', () => {
  it('script file exists', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  const source = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf-8') : '';

  it('parses a --strict CLI flag', () => {
    expect(source).toContain("const STRICT = cliArgs.includes('--strict')");
  });

  it('tracks the default failure categories in a summary', () => {
    expect(source).toContain('missingKeys: 0');
    expect(source).toContain('nonStringLeaves: 0');
    expect(source).toContain('parseErrors: 0');
    expect(source).toContain('missingLocaleFiles: 0');
  });

  it('tracks strict-only failure categories in the summary', () => {
    expect(source).toContain('missingUsedKeys: 0');
    expect(source).toContain('missingNamespaceFiles: 0');
  });

  it('detects non-string leaves while allowing arrays as structured leaves', () => {
    expect(source).toContain('function collectNonStringLeaves(');
    expect(source).toContain('if (Array.isArray(value)) continue;');
    expect(source).toContain("typeof value !== 'string'");
  });

  it('scans t() / i18n.t / i18nKey static references bilingually', () => {
    expect(source).toContain('function checkUsedTranslationKeys(');
    expect(source).toContain('const T_CALL_RE =');
    expect(source).toContain('const I18N_KEY_ATTR_RE =');
    expect(source).toContain('buildLangKeyIndex(path.join(projectRoot, \'src/locales/zh-CN\'))');
    expect(source).toContain('buildLangKeyIndex(path.join(projectRoot, \'src/locales/en-US\'))');
  });

  it('computes exit code: hard errors always fail, strict errors only with --strict', () => {
    expect(source).toContain('function computeExitCode(');
    expect(source).toContain('if (hardErrors > 0) return 1;');
    expect(source).toContain('if (STRICT && strictErrors > 0) return 1;');
    expect(source).toContain('return 0;');
    expect(source).toContain('process.exit(exitCode)');
  });

  it('exits non-zero when the check itself throws', () => {
    expect(source).toMatch(/catch \(error\) \{[\s\S]*?process\.exit\(1\);/);
  });
});

describe('check-i18n npm script wiring', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')
  ) as { scripts: Record<string, string> };

  it('exposes check:i18n as an independent npm script', () => {
    expect(pkg.scripts['check:i18n']).toBe('node scripts/check-i18n.mjs');
  });

  it('exposes check:i18n:strict with the --strict flag', () => {
    expect(pkg.scripts['check:i18n:strict']).toBe('node scripts/check-i18n.mjs --strict');
  });
});
