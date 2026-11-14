import { describe, expect, it } from 'vitest';
import { resolveCliStartOptions } from '../server/main.ts';

describe('resolveCliStartOptions', () => {
  it('keeps env fallbacks alive by omitting flags that were not given', () => {
    // DS_WEB_PROD / DS_WEB_NO_AUTH 按文档等价于 --prod / --no-auth；命令行没写时
    // 不能写入 false，否则会盖掉环境变量。
    expect(resolveCliStartOptions([])).toEqual({});
  });

  it('maps flags and both value forms', () => {
    expect(resolveCliStartOptions(['--prod', '--no-auth', '--host', '0.0.0.0', '--port', '1431'])).toEqual({
      host: '0.0.0.0',
      port: 1431,
      prod: true,
      disableAuth: true,
    });
    expect(resolveCliStartOptions(['--port=1432'])).toEqual({ port: 1432 });
  });

  it('ignores an unusable port so the env or default port still applies', () => {
    expect(resolveCliStartOptions(['--port', 'abc'])).toEqual({});
    expect(resolveCliStartOptions(['--port', '0'])).toEqual({});
    expect(resolveCliStartOptions(['--port', '-1'])).toEqual({});
  });
});
