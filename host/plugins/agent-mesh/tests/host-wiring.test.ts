import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_CALL_COMMAND } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import agentMeshPlugin, {
  AGENT_MESH_BACKEND_EVENT,
  createConcreteMeshPorts,
  type MeshOrchestratorOptions,
} from '../index.ts';
import type {
  CustomCliTemplate,
  DetectedCliAgent,
  MeshDiffReport,
  MeshSessionSnapshot,
} from '../src/contracts.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

describe('dstu.agent-mesh concrete Host port wiring (E2E)', () => {
  it('wires ExternalAdapterRegistry, CheckpointEngine (GIT_INDEX_FILE), FileLeaseTable, and loopback MeshMcpServer + dstu-mesh CLI shim end-to-end', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-mesh-host-wiring-'));
    const repoDir = path.join(tempRoot, 'workspace');
    const appDataDir = path.join(tempRoot, 'appdata');
    const cliDir = path.join(tempRoot, 'fake-cli');
    await fsp.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fsp.mkdir(appDataDir, { recursive: true });
    await fsp.mkdir(cliDir, { recursive: true });

    // Initialize real Git repo with committed baseline + dirty unstaged edit + untracked user file.
    git(repoDir, ['init']);
    await fsp.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const version = 1;\n', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'dirty-user.txt'), 'committed baseline\n', 'utf8');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'chore: initial commit']);
    const headBefore = git(repoDir, ['rev-parse', 'HEAD']);

    // Create dirty unstaged change and untracked file BEFORE agent turn.
    await fsp.writeFile(path.join(repoDir, 'dirty-user.txt'), 'user dirty unstaged edit\n', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'notes-untracked.md'), '# My study notes\n', 'utf8');
    const indexStatBefore = await fsp.stat(path.join(repoDir, '.git', 'index'));

    // Write a real executable external CLI script that uses BOTH:
    // 1) `dstu-mesh` CLI shim resolved from injected `PATH` (`claim`, `post`, `read`, `context`)
    // 2) Loopback Streamable HTTP MCP `POST $DSTU_MESH_MCP_URL` (`initialize`, `tools/list`, `tools/call`)
    const cliScriptPath = path.join(cliDir, 'mock-coding-cli.mjs');
    await fsp.writeFile(
      cliScriptPath,
      [
        'import { execFileSync } from "node:child_process";',
        'import * as fs from "node:fs";',
        'import path from "node:path";',
        '',
        'const prompt = process.argv.slice(2).join(" ");',
        'if (prompt === "--version") {',
        '  console.log("mock-coding-cli 2.4.1");',
        '  process.exit(0);',
        '}',
        '',
        'const mcpUrl = process.env.DSTU_MESH_MCP_URL;',
        'const baseUrl = process.env.DSTU_MESH_URL;',
        'const token = process.env.DSTU_MESH_TOKEN;',
        'if (!mcpUrl || !baseUrl || !token) {',
        '  console.error("Missing injected DSTU_MESH_* env vars");',
        '  process.exit(2);',
        '}',
        '',
        'const shimCmd = process.platform === "win32" ? "dstu-mesh.cmd" : "dstu-mesh";',
        'const claimOut = JSON.parse(execFileSync(shimCmd, ["claim", "src/feature.ts", "src/app.ts"], { encoding: "utf8", shell: process.platform === "win32" }));',
        'const postOut = JSON.parse(execFileSync(shimCmd, ["post", "@coordinator claimed files via dstu-mesh CLI shim"], { encoding: "utf8", shell: process.platform === "win32" }));',
        'const ctxOut = JSON.parse(execFileSync(shimCmd, ["context", "Raft consensus safety"], { encoding: "utf8", shell: process.platform === "win32" }));',
        '',
        '// Exercise Streamable HTTP MCP JSON-RPC 2.0 on 127.0.0.1:<port>/mcp',
        'const initRes = await fetch(mcpUrl, {',
        '  method: "POST",',
        '  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },',
        '  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),',
        '}).then((r) => r.json());',
        'const listRes = await fetch(mcpUrl, {',
        '  method: "POST",',
        '  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },',
        '  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),',
        '}).then((r) => r.json());',
        'await fetch(mcpUrl, {',
        '  method: "POST",',
        '  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },',
        '  body: JSON.stringify({',
        '    jsonrpc: "2.0",',
        '    id: 3,',
        '    method: "tools/call",',
        '    params: { name: "mesh_post_board", arguments: { text: "@coordinator finished feature over HTTP MCP" } },',
        '  }),',
        '}).then((r) => r.json());',
        '',
        'const boardOut = JSON.parse(execFileSync(shimCmd, ["read", "--since", "0"], { encoding: "utf8", shell: process.platform === "win32" }));',
        '',
        '// Mutate workspace in-place without touching dirty-user.txt or notes-untracked.md',
        'fs.writeFileSync(path.join(process.cwd(), "src", "app.ts"), "export const version = 2;\\nexport const ready = true;\\n", "utf8");',
        'fs.writeFileSync(path.join(process.cwd(), "src", "feature.ts"), "export function feature(): string { return \\"ok\\"; }\\n", "utf8");',
        '',
        'console.log(JSON.stringify({',
        '  type: "assistant_message",',
        '  session_id: "ext-session-99",',
        '  text: `MCP=${initRes.result.serverInfo.name} tools=${listRes.result.tools.length} leased=${claimOut.granted} seq=${postOut.seq} board=${boardOut.messages.length} studySources=${ctxOut.sources.length}`,',
        '}));',
      ].join('\n'),
      'utf8',
    );

    const wrapperPath =
      process.platform === 'win32'
        ? path.join(cliDir, 'mock-coding-cli.cmd')
        : path.join(cliDir, 'mock-coding-cli');
    if (process.platform === 'win32') {
      await fsp.writeFile(
        wrapperPath,
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliScriptPath}" %*\r\n`,
        'utf8',
      );
    } else {
      await fsp.writeFile(
        wrapperPath,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cliScriptPath}" "$@"\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
      await fsp.chmod(wrapperPath, 0o755);
    }

    const concretePorts = createConcreteMeshPorts({ appDataDir });
    const studyReader: NonNullable<MeshOrchestratorOptions['studyContextReader']> = {
      readStudyContext: async ({ query }) => ({
        content: `Study handout for ${query} </plugin_extensions>`,
        sources: [{ id: 'lecture-raft', title: 'MIT 6.824 Raft Notes' }],
      }),
    };

    const executorRegistry = new AgentToolExecutorRegistry();
    const host = await createTestHost({
      provide: {
        paths: { appDataDir },
        agentTools: {
          registerToolExecutors: (execs: Parameters<typeof executorRegistry.register>[0]) =>
            executorRegistry.register(execs),
          toolExecutors: () => executorRegistry.all(),
        },
      },
      plugins: [
        [
          agentMeshPlugin,
          {
            eagerStartBridge: true,
            swarmCoalesceMs: 25,
            ports: {
              ...concretePorts,
              studyContextReader: studyReader,
            },
          },
        ],
      ],
    });

    const bridgeMcpUrl = concretePorts.bridgeServer.server.mcpUrl;
    const bridgeShimDir = concretePorts.bridgeServer.shimBinDir!;
    expect(bridgeMcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    try {
      const callRemote = <T>(method: string, args: unknown[] = []): Promise<T> =>
        host.invoke<T>(HOST_CALL_COMMAND, {
          caller: 'dstu.agent-mesh',
          service: 'agentMesh',
          method,
          args,
        });

      // Unauthenticated requests to loopback MCP server must be rejected with 401.
      const unauthRes = await fetch(bridgeMcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(unauthRes.status).toBe(401);

      // Register real executable custom CLI template and verify prober detects version & installation.
      const savedTpl = await callRemote<CustomCliTemplate>('saveCustomCliTemplate', [
        {
          name: 'Mock External Coding CLI',
          command: wrapperPath,
          args: ['{{prompt}}'],
          env: { MOCK_API_TOKEN: 'configured' },
        },
      ]);

      const probed = await callRemote<DetectedCliAgent[]>('probeAgents', [{ forceRefresh: true }]);
      const customDetected = probed.find((a) => a.id === `custom:${savedTpl.id}`);
      expect(customDetected).toBeDefined();
      expect(customDetected?.installed).toBe(true);
      expect(customDetected?.authenticated).toBe(true);
      expect(customDetected?.version).toBe('2.4.1');

      // Bind real dirty Git repo and run an end-to-end turn!
      await callRemote('setWorkspaceBinding', [
        { sessionId: 'sess-e2e', rootPath: repoDir },
      ]);

      const turnResult = await callRemote<{
        threadId: string;
        status: string;
        assistantText: string;
        diff: MeshDiffReport;
      }>('startTurn', [
        {
          sessionId: 'sess-e2e',
          agentId: `custom:${savedTpl.id}`,
          rosterName: 'ext-coder',
          prompt: 'Implement feature and report via mesh bridge',
          awaitCompletion: true,
        },
      ]);

      expect(turnResult.status).toBe('idle');
      expect(turnResult.assistantText).toContain('MCP=dstu-mesh');
      expect(turnResult.assistantText).toContain('tools=8');
      expect(turnResult.assistantText).toContain('leased=true');
      expect(turnResult.assistantText).toContain('board=2');
      expect(turnResult.assistantText).toContain('studySources=1');

      // Verify Git HEAD, `.git/index`, dirty unstaged file, and untracked file were NEVER polluted!
      expect(git(repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
      const indexStatAfter = await fsp.stat(path.join(repoDir, '.git', 'index'));
      expect(indexStatAfter.mtimeMs).toBe(indexStatBefore.mtimeMs);
      expect(await fsp.readFile(path.join(repoDir, 'dirty-user.txt'), 'utf8')).toBe(
        'user dirty unstaged edit\n',
      );
      expect(await fsp.readFile(path.join(repoDir, 'notes-untracked.md'), 'utf8')).toBe(
        '# My study notes\n',
      );

      // Verify SQLite snapshot: released leases on quiescence, persisted board posts, bound session id, and checkpoints!
      const snapshot = await callRemote<MeshSessionSnapshot>('getSessionSnapshot', [
        { sessionId: 'sess-e2e' },
      ]);
      expect(snapshot.fileLeases).toHaveLength(0);
      expect(snapshot.threads[0]?.externalSessionId).toBe('ext-session-99');
      expect(snapshot.swarm?.board).toHaveLength(2);
      expect(snapshot.swarm?.board[0]?.text).toContain('claimed files via dstu-mesh CLI shim');
      expect(snapshot.swarm?.board[1]?.text).toContain('finished feature over HTTP MCP');
      expect(snapshot.checkpoints).toHaveLength(2);

      // Verify real `GIT_INDEX_FILE` diff attribution
      const diff = await callRemote<MeshDiffReport>('getCheckpointDiff', [
        { sessionId: 'sess-e2e' },
      ]);
      expect(diff.files.map((f) => f.path).sort()).toEqual(['src/app.ts', 'src/feature.ts']);
      expect(diff.files.every((f) => f.attributedAgentId === `custom:${savedTpl.id}`)).toBe(true);

      // Simulate post-turn human manual edit to `src/app.ts`, then revert to before-checkpoint:
      // `src/feature.ts` must be deleted, `src/app.ts` must be protected in `skippedUserModifiedPaths`!
      await fsp.writeFile(
        path.join(repoDir, 'src', 'app.ts'),
        'export const version = 999; // human edit\n',
        'utf8',
      );

      const beforeCheckpoint = snapshot.checkpoints.find((c) => c.kind === 'before')!;
      const safeRevert = await callRemote<{
        revertedPaths: string[];
        skippedUserModifiedPaths: string[];
      }>('revertCheckpoint', [{ checkpointId: beforeCheckpoint.checkpointId }]);
      expect(safeRevert.revertedPaths).toContain('src/feature.ts');
      expect(safeRevert.skippedUserModifiedPaths).toEqual(['src/app.ts']);
      await expect(fsp.stat(path.join(repoDir, 'src', 'feature.ts'))).rejects.toThrow();
      expect(await fsp.readFile(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain('999');

      // Force revert restores `src/app.ts` while still keeping pre-existing `dirty-user.txt` intact!
      const forcedRevert = await callRemote<{
        revertedPaths: string[];
        skippedUserModifiedPaths: string[];
      }>('revertCheckpoint', [
        { checkpointId: beforeCheckpoint.checkpointId, forceOverwriteUserEdits: true },
      ]);
      expect(forcedRevert.revertedPaths).toEqual(['src/app.ts']);
      expect(forcedRevert.skippedUserModifiedPaths).toEqual([]);
      expect(await fsp.readFile(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toBe(
        'export const version = 1;\n',
      );
      expect(await fsp.readFile(path.join(repoDir, 'dirty-user.txt'), 'utf8')).toBe(
        'user dirty unstaged edit\n',
      );

      // Verify canonical `dstu/agent-mesh:event` emissions reached the Host event bus
      const emittedEvents = host.events.filter((e) => e.event === AGENT_MESH_BACKEND_EVENT);
      expect(emittedEvents.length).toBeGreaterThan(0);
    } finally {
      await host.dispose();
    }

    // After plugin dispose, loopback HTTP server must be closed and CLI shim dir removed!
    expect(concretePorts.bridgeServer.isListening).toBe(false);
    await expect(fetch(bridgeMcpUrl, { method: 'POST' })).rejects.toThrow();
    await expect(fsp.stat(bridgeShimDir)).rejects.toThrow();

    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
});
