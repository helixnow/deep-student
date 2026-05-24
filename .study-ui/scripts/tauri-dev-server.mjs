import { spawn } from 'node:child_process';

const DEFAULT_DEV_URL = 'http://127.0.0.1:1420/';
const REQUIRED_MARKERS = ['<div id="root">', '/@vite/client'];

export async function canReuseDevServer(url = DEFAULT_DEV_URL) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      headers: {
        accept: 'text/html',
      },
    });

    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return false;
    }

    const body = await response.text();
    return REQUIRED_MARKERS.every((marker) => body.includes(marker));
  } catch {
    return false;
  }
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function main() {
  const devUrl = process.env.TAURI_DEV_URL ?? DEFAULT_DEV_URL;

  if (await canReuseDevServer(devUrl)) {
    console.log(`[tauri-dev-server] Reusing existing dev server at ${devUrl}`);
    return;
  }

  const child = spawn(getNpmCommand(), ['run', 'dev'], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error('[tauri-dev-server] Failed to start npm run dev');
    console.error(error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  await main();
}
