import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const tauriMacosConfigPath = path.join(root, 'src-tauri/tauri.macos.conf.json');

type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

type TauriConfig = {
  app?: {
    windows?: Array<{
      trafficLightPosition?: {
        x: number;
        y: number;
      };
    }>;
  };
};

function main() {
  const config = JSON.parse(readFileSync(tauriMacosConfigPath, 'utf8')) as TauriConfig;
  const mainWindow = config.app?.windows?.[0];

  if (!mainWindow) {
    throw new Error('Expected src-tauri/tauri.macos.conf.json to define app.windows[0].');
  }

  delete mainWindow.trafficLightPosition;

  writeFileSync(tauriMacosConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

main();
