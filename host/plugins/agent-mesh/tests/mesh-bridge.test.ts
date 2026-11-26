import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { FileLeaseTable } from '../src/file-leases.ts';
import {
  MESH_MCP_TOOLS,
  MeshMcpServer,
  buildMcpInjectionConfig,
  type MeshAgentTokenScope,
  type MeshBridgeHostCallbacks,
} from '../src/mesh-mcp-server.ts';
import {
  buildCliShimEnv,
  createCliShim,
  removeCliShim,
  type CreatedCliShim,
} from '../src/cli-shim.ts';

const servers: MeshMcpServer[] = [];
const shims: CreatedCliShim[] = [];
const leaseTables: FileLeaseTable[] = [];
const tempDirs: string[] = [];

function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as { code?: unknown }).code === 'number'
        ? ((error as { code: number }).code)
        : error
          ? 1
          : 0;
      resolve({
        code: exitCode,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
  while (shims.length > 0) {
    await removeCliShim(shims.pop()!);
  }
  while (leaseTables.length > 0) {
    leaseTables.pop()!.dispose();
  }
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Dual-Channel Bidirectional Agent Mesh Bridge (Loopback MCP + CLI Shim)', () => {
  it('enforces Bearer token authentication, serves Streamable HTTP MCP JSON-RPC 2.0, and dispatches all 8 tools via both /mcp and dstu-mesh CLI shim', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-bridge-ws-'));
    tempDirs.push(workspaceRoot);

    const leaseTable = new FileLeaseTable();
    leaseTables.push(leaseTable);

    const boardPosts: Array<{
      seq: number;
      sender: string;
      text: string;
      mentions?: string[];
      channel?: string;
      replyToSeq?: number;
    }> = [];
    const recordedCalls: Array<{ method: string; scope: MeshAgentTokenScope; input: unknown }> = [];

    const callbacks: MeshBridgeHostCallbacks = {
      postBoard(scope, input) {
        recordedCalls.push({ method: 'postBoard', scope, input });
        const entry = {
          seq: boardPosts.length + 1,
          sender: scope.rosterName,
          text: input.text,
          ...(input.mentions ? { mentions: input.mentions } : {}),
          ...(input.channel ? { channel: input.channel } : {}),
          ...(input.replyToSeq !== undefined ? { replyToSeq: input.replyToSeq } : {}),
        };
        boardPosts.push(entry);
        return entry;
      },
      readBoard(scope, input) {
        recordedCalls.push({ method: 'readBoard', scope, input });
        const since = input.sinceSeq ?? 0;
        const limit = input.limit ?? 50;
        return {
          messages: boardPosts.filter((m) => m.seq > since).slice(0, limit),
          headSeq: boardPosts.length,
        };
      },
      askPeer(scope, input) {
        recordedCalls.push({ method: 'askPeer', scope, input });
        return {
          exchangeId: 'peer-1',
          from: scope.rosterName,
          to: input.targetAgent,
          answer: `Confirmed contract for: ${input.question}`,
        };
      },
      handoff(scope, input) {
        recordedCalls.push({ method: 'handoff', scope, input });
        leaseTable.releaseAgentLeases(scope.rosterName, scope.threadId);
        return {
          handedOffTo: input.targetAgent,
          summary: input.summary,
          nextTask: input.nextTask,
          changedFiles: input.changedFiles ?? [],
        };
      },
      park(scope, input) {
        recordedCalls.push({ method: 'park', scope, input });
        return {
          status: 'parked',
          rosterName: scope.rosterName,
          summary: input.summary ?? null,
        };
      },
      readStudyContext(scope, input) {
        recordedCalls.push({ method: 'readStudyContext', scope, input });
        return {
          query: input.query,
          resourceId: input.resourceId ?? 'lecture-raft-pdf',
          excerpt: 'Raft Section 5.2: Leader election uses randomized election timeouts (150-300ms).',
        };
      },
    };

    const server = new MeshMcpServer({
      callbacks,
      fileLeaseTable: leaseTable,
    });
    servers.push(server);

    const listening = await server.start();
    expect(listening.port).toBeGreaterThan(0);
    expect(listening.baseUrl).toBe(`http://127.0.0.1:${listening.port}`);

    const claudeScope: MeshAgentTokenScope = {
      chatSessionId: 'chat-raft-1',
      agentId: 'claude',
      rosterName: 'arch-claude',
      threadId: 'thread-claude-1',
      rootPath: workspaceRoot,
    };
    const codexScope: MeshAgentTokenScope = {
      chatSessionId: 'chat-raft-1',
      agentId: 'codex',
      rosterName: 'impl-codex',
      threadId: 'thread-codex-1',
      rootPath: workspaceRoot,
    };

    const claudeToken = server.issueAgentToken(claudeScope);
    const codexToken = server.issueAgentToken(codexScope);

    // 1. Rejects missing or forged tokens on BOTH `/mcp` and `/api/call`
    const noAuthMcp = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noAuthMcp.status).toBe(401);

    const badAuthApi = await fetch(listening.apiCallUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer forged-invalid-token-0000000000000000',
      },
      body: JSON.stringify({ tool: 'mesh_read_board', args: {} }),
    });
    expect(badAuthApi.status).toBe(401);

    // 2. Full MCP JSON-RPC lifecycle (`initialize` -> `notifications/initialized` -> `tools/list` -> `tools/call`)
    const initRes = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claudeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1.0.0' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('mcp-session-id')).toBe('chat-raft-1:thread-claude-1');
    const initJson = (await initRes.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(initJson.result.protocolVersion).toBe('2025-03-26');
    expect(initJson.result.serverInfo.name).toBe('dstu-mesh');

    const notifRes = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claudeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(notifRes.status).toBe(202);

    const listRes = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claudeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(MESH_MCP_TOOLS.map((t) => t.name));

    // Call `mesh_claim_files` and `mesh_post_board` over MCP as `arch-claude`
    const mcpClaimRes = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claudeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'mesh_claim_files',
          arguments: { paths: ['src/raft/types.ts'] },
        },
      }),
    });
    const mcpClaimJson = (await mcpClaimRes.json()) as {
      result: { isError: boolean; structuredContent: { granted: boolean } };
    };
    expect(mcpClaimJson.result.isError).toBe(false);
    expect(mcpClaimJson.result.structuredContent.granted).toBe(true);

    const mcpPostRes = await fetch(listening.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claudeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'mesh_post_board',
          arguments: {
            text: '@impl-codex Raft RPC types are ready in src/raft/types.ts',
            mentions: ['impl-codex'],
            channel: 'design',
          },
        },
      }),
    });
    const mcpPostJson = (await mcpPostRes.json()) as {
      result: { isError: boolean; structuredContent: { seq: number; sender: string } };
    };
    expect(mcpPostJson.result.isError).toBe(false);
    expect(mcpPostJson.result.structuredContent).toMatchObject({
      seq: 1,
      sender: 'arch-claude',
    });

    // 3. Real `dstu-mesh` CLI Shim E2E via `PATH` as `impl-codex`
    const shim = await createCliShim();
    shims.push(shim);

    const codexEnv = buildCliShimEnv({
      shimBinDir: shim.binDir,
      endpointUrl: listening.baseUrl,
      token: codexToken,
    });

    // Rejects bad token in CLI shim with exit code 2
    const badShimEnv = buildCliShimEnv({
      shimBinDir: shim.binDir,
      endpointUrl: listening.baseUrl,
      token: 'invalid-cli-token-0000000000000000',
    });
    const rejectedCli = await runCommand('/bin/sh', ['-c', 'dstu-mesh read'], badShimEnv);
    expect(rejectedCli.code).toBe(2);
    expect(rejectedCli.stderr).toContain('401');

    // `dstu-mesh read`
    const readCli = await runCommand('/bin/sh', ['-c', 'dstu-mesh read --since 0 --limit 10'], codexEnv);
    expect(readCli.code).toBe(0);
    const readPayload = JSON.parse(readCli.stdout) as { headSeq: number; messages: Array<{ sender: string }> };
    expect(readPayload.headSeq).toBe(1);
    expect(readPayload.messages[0]!.sender).toBe('arch-claude');

    // `dstu-mesh claim` on a path held by `arch-claude` shows conflict, while disjoint path succeeds!
    const conflictClaimCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh claim src/raft/types.ts --wait 0'],
      codexEnv,
    );
    expect(conflictClaimCli.code).toBe(0);
    expect(JSON.parse(conflictClaimCli.stdout)).toMatchObject({
      granted: false,
      conflict: { holderAgentId: 'arch-claude' },
    });

    const disjointClaimCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh claim src/raft/election.ts --wait 0'],
      codexEnv,
    );
    expect(disjointClaimCli.code).toBe(0);
    expect(JSON.parse(disjointClaimCli.stdout)).toMatchObject({ granted: true });

    // `dstu-mesh ask`
    const askCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh ask @arch-claude "Should votedFor reset on higher term?" --context src/raft/types.ts'],
      codexEnv,
    );
    expect(askCli.code).toBe(0);
    expect(JSON.parse(askCli.stdout)).toMatchObject({
      from: 'impl-codex',
      to: '@arch-claude',
    });

    // `dstu-mesh context`
    const contextCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh context "leader election timeout" --resource lecture-raft-pdf --max-chars 2000'],
      codexEnv,
    );
    expect(contextCli.code).toBe(0);
    expect(JSON.parse(contextCli.stdout)).toMatchObject({
      resourceId: 'lecture-raft-pdf',
    });

    // `dstu-mesh post`
    const postCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh post "@coordinator Election tests pass" --mention coordinator --reply-to 1'],
      codexEnv,
    );
    expect(postCli.code).toBe(0);
    expect(JSON.parse(postCli.stdout)).toMatchObject({
      seq: 2,
      sender: 'impl-codex',
      replyToSeq: 1,
    });

    // `dstu-mesh release`
    const releaseCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh release src/raft/election.ts'],
      codexEnv,
    );
    expect(releaseCli.code).toBe(0);
    expect(JSON.parse(releaseCli.stdout)).toMatchObject({
      released: true,
      releasedCount: 1,
    });

    // `dstu-mesh handoff`
    const handoffCli = await runCommand(
      '/bin/sh',
      [
        '-c',
        'dstu-mesh handoff @deepstudent --summary "Implemented Raft election" --next "Generate study flashcards" --files src/raft/election.ts',
      ],
      codexEnv,
    );
    expect(handoffCli.code).toBe(0);
    expect(JSON.parse(handoffCli.stdout)).toMatchObject({
      handedOffTo: '@deepstudent',
      changedFiles: ['src/raft/election.ts'],
    });

    // `dstu-mesh park`
    const parkCli = await runCommand(
      '/bin/sh',
      ['-c', 'dstu-mesh park "All election unit tests green"'],
      codexEnv,
    );
    expect(parkCli.code).toBe(0);
    expect(JSON.parse(parkCli.stdout)).toMatchObject({
      status: 'parked',
      rosterName: 'impl-codex',
      summary: 'All election unit tests green',
    });

    // Token revocation immediately blocks subsequent requests
    expect(server.revokeThreadTokens('thread-codex-1')).toBe(1);
    const afterRevoke = await runCommand('/bin/sh', ['-c', 'dstu-mesh read'], codexEnv);
    expect(afterRevoke.code).toBe(2);
  });

  it('generates ready-to-pass ephemeral MCP injection configs for Claude, Codex, OpenCode, and Pi without touching user home configs', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-mcp-cfg-'));
    tempDirs.push(tempDir);
    const endpoint = 'http://127.0.0.1:43210';
    const token = 'secret-session-token-1234567890abcdef';

    const claudeCfg = buildMcpInjectionConfig('claude', endpoint, token, tempDir);
    expect(claudeCfg.cliArgs[0]).toBe('--mcp-config');
    expect(claudeCfg.configFilePath).toBeDefined();
    const claudeFileJson = JSON.parse(fs.readFileSync(claudeCfg.configFilePath!, 'utf8')) as {
      mcpServers: { dstu_mesh: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(claudeFileJson.mcpServers.dstu_mesh).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:43210/mcp',
      headers: { Authorization: `Bearer ${token}` },
    });

    const codexCfg = buildMcpInjectionConfig('codex', endpoint, token, tempDir);
    expect(codexCfg.cliArgs[0]).toBe('-c');
    expect(codexCfg.cliArgs[1]).toContain('mcp_servers.dstu_mesh=');
    expect(codexCfg.cliArgs[1]).toContain('http://127.0.0.1:43210/mcp');

    const opencodeCfg = buildMcpInjectionConfig('opencode', endpoint, token, tempDir);
    expect(opencodeCfg.mcpServers.dstu_mesh?.url).toBe('http://127.0.0.1:43210/mcp');
    expect(opencodeCfg.acpMcpServers[0]?.headers[0]).toEqual({
      name: 'Authorization',
      value: `Bearer ${token}`,
    });

    const piCfg = buildMcpInjectionConfig('pi', endpoint, token, tempDir);
    expect(piCfg.configFilePath).toBeDefined();
    expect(piCfg.envVars.DSTU_MESH_TOKEN).toBe(token);
  });
});
