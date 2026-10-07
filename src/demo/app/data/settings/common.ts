/**
 * 设置窗口外壳（缩放、字体、路径解析等）都会碰到的命令。models / data-sync 两章共用。
 * 只依赖演示数据模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';

export function handleDemoSettingsShell(cmd: string, _args: DemoArgs): unknown {
  switch (cmd) {
    case 'plugin:webview|set_webview_zoom':
      return null;
    case 'plugin:path|resolve_directory':
      return '/Users/demo/Library/Application Support/com.deepstudent.app';
    case 'plugin:http|fetch':
      // 余额查询、硅基流动模型列表等直连网络的请求
      throw new Error(tr('联网请求请在桌面版中使用。', 'Network requests are available in the desktop app.'));
    default:
      return undefined;
  }
}
