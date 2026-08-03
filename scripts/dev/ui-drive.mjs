#!/usr/bin/env node
/**
 * ui-drive — Deep Student 本地 UI 驱动 CLI（Playwright-MCP 风格）
 *
 * 前置：
 *   npm run ui:lab          （一键：桥 + 手机比例 dev 窗口）
 *   或手动：
 *     node scripts/dev/ui-bridge-server.mjs
 *     VITE_DS_UI_BRIDGE=1 npm run dev:tauri -- --config config/dev-phone-window.json
 *
 * Cursor 里更推荐启用 MCP server「dstu-ui-drive」，工具名 ui_*，用法与 Playwright MCP 接近。
 *
 * 命令（全部输出 JSON，截图额外落盘）：
 *   status | snapshot [--all] | click | type | key | scroll | swipe | back
 *   reload | reset-view | errors [--clear] | shot | eval | resize | devices | wait
 */
import {
  status,
  snapshot,
  formatSnapshot,
  click,
  typeText,
  pressKey,
  scroll,
  swipe,
  back,
  reload,
  resetMobileView,
  errors,
  evalJs,
  resize,
  wait,
  captureWindow,
  DEVICES,
} from './ui-drive-core.mjs';

function out(obj) {
  console.log(JSON.stringify(obj, null, 1));
}

const [, , cmd, ...args] = process.argv;
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

async function main() {
  switch (cmd) {
    case 'status':
      out(await status());
      break;
    case 'snapshot': {
      const r = await snapshot({ all: flags.has('--all') });
      if (flags.has('--text')) {
        console.log(formatSnapshot(r));
      } else {
        out(r);
      }
      break;
    }
    case 'click':
      out(await click(positional[0], { tap: flags.has('--tap') }));
      break;
    case 'type':
      out(
        await typeText(positional[0], positional.slice(1).join(' '), {
          clear: !flags.has('--append'),
          enter: flags.has('--enter'),
        }),
      );
      break;
    case 'key':
      out(
        await pressKey(positional[0], {
          meta: flags.has('--meta'),
          ctrl: flags.has('--ctrl'),
          alt: flags.has('--alt'),
          shift: flags.has('--shift'),
        }),
      );
      break;
    case 'scroll':
      out(await scroll(Number(positional[0]), positional[1] || null));
      break;
    case 'swipe': {
      const [x1, y1] = positional[0].split(',').map(Number);
      const [x2, y2] = positional[1].split(',').map(Number);
      out(await swipe([x1, y1], [x2, y2], Number(positional[2] || 250)));
      break;
    }
    case 'back':
      out(await back());
      break;
    case 'reload':
      out(await reload());
      break;
    case 'reset-view':
      out(await resetMobileView());
      break;
    case 'errors':
      out(await errors(flags.has('--clear')));
      break;
    case 'shot':
      out(captureWindow(positional[0] || `shot-${Date.now()}`, { full: flags.has('--full') }));
      break;
    case 'eval':
      out(await evalJs(positional.join(' ')));
      break;
    case 'resize':
      out(await resize(Number(positional[0]), Number(positional[1])));
      break;
    case 'devices':
      out(DEVICES);
      break;
    case 'wait':
      out(await wait(Number(positional[0] || 500)));
      break;
    default:
      console.error(`unknown command: ${cmd || '(none)'}`);
      console.error('see header comment or docs/dev/ui-drive.md');
      process.exit(1);
  }
}

main().catch((e) => {
  out({ ok: false, error: String(e) });
  process.exit(1);
});
