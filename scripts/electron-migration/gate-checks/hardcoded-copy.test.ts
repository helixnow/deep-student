import { describe, expect, it } from 'vitest';
import { applyBaseline, baselineFrom, baselineGrowth, inventory, looksLikeCopy, scanHardcodedCopy } from './hardcoded-copy.mjs';

const scan = (text: string, file = 'src/features/x/Panel.tsx') =>
  scanHardcodedCopy([{ file, text }]).map((f) => `${f.rule}:${f.text}`);

describe('looksLikeCopy', () => {
  it('accepts Chinese, sentences, capitalised words and i18n-style templates', () => {
    for (const s of ['保存', '  加载中…  ', 'Load more', 'Saved.', 'Save', 'Cancel', 'Hello {{name}}', '共 3 项', 'Delete?']) {
      expect(looksLikeCopy(s), s).toBe(true);
    }
  });
  it('rejects keys, identifiers, class names, paths, URLs, numbers and symbols', () => {
    for (const s of ['common:save', 'chat.title', 'error', 'btn-primary', 'flex items-center', 'https://example.com/a b',
      '/settings', './a.png', '#top', '@user', '42', '·', '—', '%', '⌘K', '', '   ', 'ok', 'x', 'Aa', 'OK',
      'read_file, write_file, list_directory']) {
      expect(looksLikeCopy(s), s).toBe(false);
    }
  });
  it('treats multi-word lowercase class lists as copy only when words look like words, not utilities', () => {
    // A class list in a copy position is still flagged: className is never inspected, so this only matters for
    // literals that reach a copy attribute or JSX text.
    expect(looksLikeCopy('text-sm font-medium')).toBe(false);
  });
});

describe('scanHardcodedCopy: what is counted', () => {
  it('JSX text, JSX expression literals and copy attributes', () => {
    expect(scan(`export const A = () => (
      <div title="设置" aria-label={'Close dialog'} placeholder={busy ? '请稍候' : \`Search \${n} items\`}>
        保存失败
        {loading ? '加载中' : 'Load more'}
        <span>Save</span>
      </div>
    );`)).toEqual([
      'jsx-attribute:设置',
      'jsx-attribute:Close dialog',
      'jsx-attribute:请稍候',
      'jsx-attribute:Search {} items',
      'jsx-text:保存失败',
      'jsx-expression:加载中',
      'jsx-expression:Load more',
      'jsx-text:Save',
    ]);
  });

  it('notification calls, including member callees, object payloads and handlers inside JSX attributes', () => {
    expect(scan(`
      showGlobalNotification('error', '导入失败');
      showGlobalNotification('success', \`\${t('a:b')}：已复制\`);
      deps.showNotification('info', 'Link copied to clipboard');
      toast.success('同步完成');
      window.alert('确定吗');
      notify({ title: '提醒', type: 'warning' });
      export const B = () => <button onClick={() => showGlobalNotification('error', '删除失败')} />;
    `, 'src/features/x/actions.tsx')).toEqual([
      'notification:导入失败',
      'notification:{} ：已复制',
      'notification:Link copied to clipboard',
      'notification:同步完成',
      'notification:确定吗',
      'notification:提醒',
      'notification:删除失败',
    ]);
  });
});

describe('scanHardcodedCopy: what is not counted', () => {
  it('i18n calls (key and defaultValue), comments, logs, errors and non-copy attributes', () => {
    expect(scan(`
      // 这里是注释：保存失败
      /* Load more items */
      console.log('加载失败', 'Something went wrong');
      debugLog.warn('[X] 初始化失败');
      throw new Error('无效的参数');
      showGlobalNotification('error', t('notes:save_failed', { defaultValue: '保存失败' }));
      showGlobalNotification('error', i18n.t('notes:save_failed', '保存失败'));
      export const C = () => (
        <div className="flex items-center 设置" id="main-panel" data-tour-id="新建" key="保存" style={{ content: '"文本"' }}
          title={t('common:settings', '设置')} aria-label={t('common:close')} href="/settings" type="button" role="dialog">
          {t('common:save', { defaultValue: 'Save changes' })}
          {count}
          {' '}
          ·
          <Trans i18nKey="a">你好 <b>世界</b></Trans>
          <kbd>Ctrl</kbd><code>npm run build</code>
        </div>
      );
    `)).toEqual([]);
  });

  it('tests, declaration files, the demo shell and golden fixtures are out of scope', () => {
    const text = 'export const D = () => <p>保存失败</p>;';
    for (const file of ['src/features/x/__tests__/a.test.tsx', 'src/features/x/a.test.tsx', 'src/types/a.d.ts',
      'src/demo/app/packs/notes.tsx', 'src/ui-plugins/testing/__golden__/a.tsx', 'tests/vitest/a.tsx', 'host/a.tsx']) {
      expect(scanHardcodedCopy([{ file, text }]), file).toEqual([]);
    }
  });
});

describe('ratchet baseline', () => {
  const findings = scanHardcodedCopy([
    { file: 'src/a.tsx', text: 'export const A = () => <><p>一</p><p>二</p></>;' },
    { file: 'src/b.tsx', text: "showGlobalNotification('error', '失败');" },
  ]);

  it('counts by rule and file; new literals beyond the count are errors, fewer are stale info', () => {
    const baseline = { entries: baselineFrom(findings) };
    expect(baseline.entries).toEqual([
      { rule: 'jsx-text', file: 'src/a.tsx', count: 2 },
      { rule: 'notification', file: 'src/b.tsx', count: 1 },
    ]);
    expect(applyBaseline(findings, baseline)).toEqual({ fresh: [], stale: [] });

    const more = scanHardcodedCopy([{ file: 'src/a.tsx', text: 'export const A = () => <><p>一</p><p>二</p><p>三</p></>;' }]);
    const { fresh, stale } = applyBaseline(more, baseline);
    expect(fresh.map((f) => `${f.severity}:${f.text}`)).toEqual(['error:三']);
    expect(stale.map((e) => `${e.severity}:${e.file}:${e.present}/${e.count}`)).toEqual(['info:src/b.tsx:0/1']);
  });

  it('rewriting the baseline may only lower counts', () => {
    const previous = { entries: baselineFrom(findings) };
    const grown = baselineFrom([...findings, ...scanHardcodedCopy([{ file: 'src/c.tsx', text: 'export const C = () => <p>新</p>;' }])]);
    expect(baselineGrowth(previous, grown)).toEqual([{ rule: 'jsx-text', file: 'src/c.tsx', from: 0, to: 1 }]);
    expect(baselineGrowth(previous, baselineFrom(findings.slice(1)))).toEqual([]);
  });

  it('inventory ranks files by count', () => {
    expect(inventory(findings, 1)).toEqual({ total: 3, files: 2, byRule: { 'jsx-text': 2, notification: 1 }, top: [{ file: 'src/a.tsx', count: 2 }] });
  });
});
