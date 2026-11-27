import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createExternalLlmConfigsService } from '../external-llm-configs.ts';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ext-cfg-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('externalLlmConfigs platform reader', () => {
  it('discovers Magpie, CC Switch SQLite (custom dir), OpenCode, Claude Code, and Codex in read-only mode', async () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const configDir = path.join(home, '.config');
    const dataDir = path.join(home, '.local', 'share');
    const tempDir = path.join(root, 'tmp');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    // 1. Magpie providers.json + plugin-providers.json
    const magpieDir = path.join(configDir, 'magpie');
    fs.mkdirSync(magpieDir, { recursive: true });
    fs.writeFileSync(
      path.join(magpieDir, 'providers.json'),
      JSON.stringify([
        {
          id: 'deepseek',
          name: 'DeepSeek Official',
          baseAPI: 'openai',
          chat: 'https://api.deepseek.com/v1',
          key: 'sk-magpie-ds-1234567890',
        },
      ]),
    );
    fs.writeFileSync(
      path.join(magpieDir, 'plugin-providers.json'),
      JSON.stringify({ deepseek: ['deepseek-v4-pro'] }),
    );

    // 2. CC Switch settings.json pointing to custom directory with cc-switch.db
    const defaultCcDir = path.join(home, '.cc-switch');
    const customCcDir = path.join(root, 'icloud-cc-switch');
    fs.mkdirSync(defaultCcDir, { recursive: true });
    fs.mkdirSync(customCcDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultCcDir, 'settings.json'),
      JSON.stringify({ currentConfigDir: customCcDir }),
    );

    const dbPath = path.join(customCcDir, 'cc-switch.db');
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE providers (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        website_url TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, app_type)
      );
      CREATE TABLE universal_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        models TEXT
      );
    `);
    db.prepare(
      'INSERT INTO providers (id, app_type, name, settings_config, website_url, meta) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'relay-1',
      'claude',
      'Packy Relay',
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.packycode.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-packy-secret-9999',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
        },
      }),
      'https://packycode.com',
      '{}',
    );
    db.prepare(
      'INSERT INTO universal_providers (id, name, base_url, api_key, models) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'uni-1',
      'Uni Hub',
      'https://api.unihub.example/v1',
      'sk-unihub-8888',
      JSON.stringify(['gpt-5.4']),
    );
    db.close();

    // 3. OpenCode jsonc + auth.json
    const opencodeCfgDir = path.join(configDir, 'opencode');
    const opencodeDataDir = path.join(dataDir, 'opencode');
    fs.mkdirSync(opencodeCfgDir, { recursive: true });
    fs.mkdirSync(opencodeDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeCfgDir, 'opencode.jsonc'),
      `{
        // OpenCode comment
        "provider": {
          "siliconflow": {
            "options": { "baseURL": "https://api.siliconflow.cn/v1" },
            "models": { "Qwen/Qwen3-32B": { "limit": { "context": 131072 } } },
          }
        }
      }`,
    );
    fs.writeFileSync(
      path.join(opencodeDataDir, 'auth.json'),
      JSON.stringify({ siliconflow: { type: 'api', key: 'sk-sf-opencode-7777' } }),
    );

    // 4. Claude Code & Codex
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'magpie' } }),
    );
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      'model = "gpt-5.4"\nmodel_provider = "openai"\n',
    );
    fs.writeFileSync(
      path.join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-codex-direct-6666' }),
    );

    const service = createExternalLlmConfigsService({
      home,
      config: configDir,
      data: dataDir,
      dataLocal: dataDir,
      temp: tempDir,
      env: {},
    });

    const scanned = await service.scanDefaultSources();
    expect(scanned.supported).toBe(true);
    const bySource = new Map(scanned.sources.map((s) => [s.source, s]));

    expect(bySource.get('magpie')?.pathLabel).toBe('~/.config/magpie/providers.json');
    expect(bySource.get('magpie')?.companionText).toContain('deepseek-v4-pro');

    const ccSource = bySource.get('cc-switch');
    expect(ccSource?.kind).toBe('sqlite-rows');
    expect(ccSource?.sqliteTables?.providers).toHaveLength(1);
    expect(ccSource?.sqliteTables?.universalProviders).toHaveLength(1);

    expect(bySource.get('opencode')?.companionText).toContain('sk-sf-opencode-7777');
    expect(bySource.get('claude-code')?.pathLabel).toBe('~/.claude/settings.json');
    expect(bySource.get('codex')?.companionText).toContain('sk-codex-direct-6666');

    // Explicit file reading detects SQLite magic even on arbitrary extension
    const backupCopy = path.join(root, 'cc-switch.backup');
    fs.copyFileSync(dbPath, backupCopy);
    const singleFile = await service.readExternalFile(backupCopy);
    expect(singleFile.kind).toBe('sqlite-rows');
    expect(singleFile.sqliteTables?.providers).toHaveLength(1);
  });
});
