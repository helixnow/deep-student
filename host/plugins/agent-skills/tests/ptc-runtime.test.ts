import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PTC_ALLOWED_TOOLS, PTC_WRITE_TOOLS, PtcBrokerState, argsFingerprint,
  isPtcAllowedTool, isPtcWritableTool, normalizePtcToolName, runPtcScript,
  runPtcScriptWithLimits, type PtcDispatchEnvelope, type PtcScriptOutcome,
} from '../src/tools/ptc-runtime.ts';
import { BUILTIN_DESCRIPTORS, isPtcAllowed } from '../../agent-orchestration/api.ts';
import { starlark } from '../../../platform/native/starlark/index.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ptc-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handler = (seq: number, tool: string, args: unknown) => Promise<PtcDispatchEnvelope> | PtcDispatchEnvelope;

function brokerForTest(
  maxCalls = 10,
  artifactRoot: string | null = null,
  handler: Handler = async () => ({ ok: true, output: null }),
  signal = new AbortController().signal,
): PtcBrokerState {
  return new PtcBrokerState({
    maxCalls,
    signal,
    deadlineMs: Date.now() + 30_000,
    artifactRoot,
    dispatch: async (seq, tool, args) => handler(seq, tool, args),
    logger: {},
    nativeStarlark: starlark,
  });
}

function brokerWithRoot(maxCalls: number, root: string, handler?: Handler): PtcBrokerState {
  return brokerForTest(maxCalls, root, handler);
}

function valueOf(outcome: PtcScriptOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected success, got: ${outcome.error}`);
  return outcome.value;
}

function errorOf(outcome: PtcScriptOutcome): string {
  if (outcome.ok) throw new Error(`expected failure, got: ${JSON.stringify(outcome.value)}`);
  return outcome.error;
}

describe('ptc_runtime.rs', () => {
  it('whitelist_exact_membership_and_fail_closed', () => {
    expect(PTC_ALLOWED_TOOLS.length).toBe(36);
    for (const tool of [
      'builtin-unified_search', 'builtin-rag_search', 'builtin-web_search', 'builtin-web_fetch',
      'builtin-arxiv_search', 'builtin-scholar_search', 'builtin-memory_read',
      'builtin-resource_read', 'builtin-qbank_get_next_question', 'builtin-review_get_due',
    ]) expect(isPtcAllowedTool(tool), tool).toBe(true);
    for (const tool of [
      'builtin-memory_write', 'builtin-tool_pack', 'builtin-ptc_run',
      'builtin-local_shell_execute', 'builtin-subagent_call', 'builtin-ask_user',
      'attempt_completion', 'todo_init', 'builtin-todo_init', 'mcp_brave_search',
      'builtin-note_append', 'totally_unknown_tool',
    ]) expect(isPtcAllowedTool(tool), tool).toBe(false);
  });

  it('ptc_whitelist_delegates_to_descriptor_registry', () => {
    // ① 集合相等：注册表标志位是生产权威，常量仅为测试 oracle。
    const oracle = new Set(PTC_ALLOWED_TOOLS);
    const registry = new Set(
      BUILTIN_DESCRIPTORS.filter(descriptor => descriptor.ptcAllowed)
        .map(descriptor => `builtin-${descriptor.name}`),
    );
    expect(registry).toEqual(oracle);

    // ② 名单内逐名：裸名与 builtin- 形式均被注册表认领。
    for (const fullName of PTC_ALLOWED_TOOLS) {
      const bare = fullName.replace(/^builtin-/, '');
      expect(isPtcAllowedTool(fullName), fullName).toBe(true);
      expect(isPtcAllowedTool(bare), bare).toBe(true);
      expect(isPtcAllowed(fullName), fullName).toBe(true);
      expect(isPtcAllowed(bare), bare).toBe(true);
      expect(oracle.has(fullName)).toBe(true);
    }

    // ③ 名单外逐名：全部已登记非 PTC 工具均拒绝。
    for (const descriptor of BUILTIN_DESCRIPTORS.filter(candidate => !candidate.ptcAllowed)) {
      expect(isPtcAllowedTool(descriptor.name), descriptor.name).toBe(false);
      expect(isPtcAllowedTool(`builtin-${descriptor.name}`), descriptor.name).toBe(false);
    }

    // ④ 未登记名恒拒（含看似合法的 builtin 名）。
    for (const unknown of ['retired_tool', 'builtin-retired_tool', 'server::tool']) {
      expect(isPtcAllowedTool(unknown), unknown).toBe(false);
      expect(isPtcAllowed(unknown), unknown).toBe(false);
    }
  });

  it('controlled_write_policy_is_registered_non_destructive_and_disjoint', () => {
    expect(PTC_WRITE_TOOLS.length).toBe(4);
    for (const fullName of PTC_WRITE_TOOLS) {
      expect(isPtcWritableTool(fullName)).toBe(true);
      expect(isPtcAllowedTool(fullName), `${fullName} must not be read-allowed`).toBe(false);
      const bare = fullName.replace(/^builtin-/, '');
      const descriptor = BUILTIN_DESCRIPTORS.find(candidate => candidate.name === bare);
      expect(descriptor, `missing descriptor: ${bare}`).toBeDefined();
      expect(descriptor!.sideEffectClass).toBe('WriteLocal');
      expect(['Low', 'Medium']).toContain(descriptor!.sensitivity);
    }
    for (const denied of [
      'builtin-workspace_file_delete', 'builtin-workspace_file_move',
      'builtin-note_replace', 'builtin-connector_operation_commit',
    ]) {
      expect(isPtcWritableTool(denied), denied).toBe(false);
    }
  });

  it('controlled_write_call_uses_same_broker_and_marks_side_effect', async () => {
    const seen: string[] = [];
    const broker = brokerForTest(10, null, (_seq, tool) => {
      seen.push(tool);
      return { ok: true, output: { path: 'report.md' } };
    });
    const value = valueOf(await runPtcScript(
      'call("workspace_artifact_write", {"path": "report.md", "content": "ok"})',
      broker,
    ));
    expect(value).toEqual({ ok: true, output: { path: 'report.md' } });
    expect(seen).toEqual(['builtin-workspace_artifact_write']);
    expect(broker.trace).toHaveLength(1);
    expect(broker.trace[0]!.side_effect).toBe(true);
    expect(broker.trace[0]!.tool).toBe('builtin-workspace_artifact_write');
  });

  it('args_fingerprint_is_key_order_independent_and_stable', () => {
    const a = { b: 1, a: { y: [1, 2], x: true } };
    const b = { a: { x: true, y: [1, 2] }, b: 1 };
    expect(argsFingerprint(a)).toBe(argsFingerprint(b));
    expect(argsFingerprint(a).startsWith('sha256:')).toBe(true);
    expect(argsFingerprint(a)).not.toBe(argsFingerprint({ a: 2 }));
  });

  it('script_final_expression_is_result', async () => {
    expect(valueOf(await runPtcScript('1 + 2', brokerForTest()))).toBe(3);
  });

  it('script_top_level_loop_and_dict_result', async () => {
    const outcome = await runPtcScript(`
total = 0
for i in range(5):
    total += i
{"sum": total, "items": [x * 2 for x in range(3)]}
`, brokerForTest());
    expect(valueOf(outcome)).toEqual({ sum: 10, items: [0, 2, 4] });
  });

  it('script_parse_error_reported', async () => {
    expect(errorOf(await runPtcScript('def broken(:', brokerForTest()))).toContain('parse error');
  });

  it('script_fail_propagates_as_error', async () => {
    expect(errorOf(await runPtcScript('fail("boom")', brokerForTest()))).toContain('boom');
  });

  it('load_statement_is_disabled', async () => {
    expect(errorOf(await runPtcScript('load("//x.bzl", "y")', brokerForTest())))
      .toContain('parse error');
  });

  it('tick_limit_interrupts_infinite_loop', async () => {
    const outcome = await runPtcScriptWithLimits(
      'for _i in range(1000000000):\n    pass\n',
      brokerForTest(),
      {
        max_callstack_size: 256,
        max_heap_bytes: 32 * 1024 * 1024,
        max_tick_count: 1000,
      },
    );
    expect(errorOf(outcome)).toMatch(/tick|limit|exceed/);
  });

  it('callstack_limit_interrupts_recursion', async () => {
    const outcome = await runPtcScript(
      'def f(n):\n    return f(n + 1)\nf(0)\n',
      brokerForTest(),
    );
    expect(errorOf(outcome)).toMatch(/callstack|stack|recursion/i);
  }, 30_000);

  it('call_allowed_tool_returns_envelope', async () => {
    const broker = brokerForTest(10, null, (_seq, tool, args) => {
      expect(tool).toBe('builtin-rag_search');
      expect(args).toEqual({ query: 'hello' });
      return { ok: true, output: { hits: [{ id: 1 }] } };
    });
    const value = valueOf(await runPtcScript(`
res = call("rag_search", {"query": "hello"})
{"ok": res["ok"], "first": res["output"]["hits"][0]["id"]}
`, broker));
    expect(value).toEqual({ ok: true, first: 1 });
  });

  it('call_accepts_json_string_args', async () => {
    const broker = brokerForTest(10, null, (_seq, tool, args) => {
      expect(tool).toBe('builtin-web_search');
      expect(args).toEqual({ query: 'x' });
      return { ok: true, output: null };
    });
    expect((await runPtcScript('call("builtin-web_search", "{\\"query\\":\\"x\\"}")', broker)).ok)
      .toBe(true);
  });

  it('call_denied_tool_is_hard_error', async () => {
    const error = errorOf(await runPtcScript(
      'call("builtin-local_shell_execute", {"command": "ls"})', brokerForTest(),
    ));
    expect(error).toContain('allowlist');
  });

  it('call_self_recursion_is_hard_error', async () => {
    const error = errorOf(await runPtcScript(
      'call("builtin-ptc_run", {"script": "1"})', brokerForTest(),
    ));
    expect(error).toContain('recursive');
  });

  it('call_budget_exhaustion_interrupts_script', async () => {
    const broker = brokerForTest(1, null, () => ({ ok: true, output: null }));
    const error = errorOf(await runPtcScript(`
call("builtin-rag_search", {})
call("builtin-web_search", {})
`, broker));
    expect(error).toContain('budget');
  });

  it('tool_failure_returns_error_envelope_without_aborting', async () => {
    const broker = brokerForTest(10, null, () => ({
      ok: false, error: 'AUTHORITY_BLOCKED: Ask mode requires approval',
    }));
    const value = valueOf(await runPtcScript(`
res = call("builtin-rag_search", {})
if res["ok"]:
    fail("must be rejected")
res["error"]
`, broker));
    expect(String(value)).toContain('AUTHORITY_BLOCKED');
    expect(broker.trace).toHaveLength(1);
    expect(broker.trace[0]!.ok).toBe(false);
    expect(broker.trace[0]!.error).toContain('AUTHORITY_BLOCKED');
  });

  it('trace_records_successful_call', async () => {
    const broker = brokerForTest(10, null, () => ({ ok: true, output: { data: 'x' } }));
    expect((await runPtcScript('call("builtin-memory_list", {})', broker)).ok).toBe(true);
    expect(broker.trace).toHaveLength(1);
    expect(broker.trace[0]!.ok).toBe(true);
    expect(broker.trace[0]!.tool).toBe('builtin-memory_list');
    expect(broker.trace[0]!.result_bytes).toBeGreaterThan(0);
  });

  it('cancellation_interrupts_blocked_call', async () => {
    const controller = new AbortController();
    const broker = brokerForTest(
      10, null, () => new Promise(() => {}), controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    const error = errorOf(await runPtcScript('call("builtin-rag_search", {})', broker));
    expect(error).toMatch(/cancelled|timed out/);
  }, 15_000);

  it('object_read_paged_concat_matches_original_and_sha256', async () => {
    const dir = tempDir();
    let text = '';
    for (let i = 0; i < 500; i++) text += `第${i}行：深度学习与程序合成 αβγ🦀\n`;
    writeFileSync(path.join(dir, 'big.txt'), text);
    const broker = brokerWithRoot(50, dir);
    const value = valueOf(await runPtcScript(`
handle = {"root_id": "artifacts", "relative_path": "big.txt"}
chunks = []
offset = 0
sha = ""
pages = 0
for _i in range(200):
    page = object_read(handle, offset=offset, limit=4096)
    chunks.append(page["content"])
    offset = page["next_offset"]
    sha = page["sha256"]
    pages += 1
    if page["eof"]:
        break
{"joined": "".join(chunks), "sha256": sha, "pages": pages, "total": page["total_size"]}
`, broker)) as Record<string, unknown>;
    expect(value.joined).toBe(text);
    const { createHash } = await import('node:crypto');
    expect(value.sha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(value.total).toBe(Buffer.byteLength(text, 'utf8'));
    expect(Number(value.pages)).toBeGreaterThanOrEqual(3);
    expect(broker.trace).toHaveLength(Number(value.pages));
    expect(broker.trace.every(entry => entry.tool === 'object_read' && entry.ok)).toBe(true);
    expect(broker.trace.every(entry => entry.args_hash.startsWith('sha256:'))).toBe(true);
    expect(broker.trace[0]!.args_hash).not.toBe(broker.trace[1]!.args_hash);
  });

  it('object_read_accepts_materialized_handle_dict_camel_case', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'r.json'), '{"v": 1}');
    const broker = brokerWithRoot(10, dir);
    const value = valueOf(await runPtcScript(`
handle = {
    "schemaVersion": 2,
    "handleId": "ptc-result:abc",
    "kind": "artifact",
    "displayName": "r.json",
    "capabilities": {"readable": True, "materializable": True, "writable": False},
    "locator": {"rootId": "artifacts", "relativePath": "r.json"},
}
page = object_read(handle)
{"content": page["content"], "eof": page["eof"], "encoding": page["encoding"]}
`, broker)) as Record<string, unknown>;
    expect(value.content).toBe('{"v": 1}');
    expect(value.eof).toBe(true);
    expect(value.encoding).toBe('utf-8');
  });

  it('object_read_rejects_unreadable_handle', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'r.json'), '{}');
    const broker = brokerWithRoot(10, dir);
    const error = errorOf(await runPtcScript(`
handle = {
    "capabilities": {"readable": False, "materializable": True},
    "locator": {"rootId": "artifacts", "relativePath": "r.json"},
}
object_read(handle)
`, broker));
    expect(error).toContain('object_read failed');
    expect(error).toContain('readable');
    expect(broker.trace).toHaveLength(1);
    expect(broker.trace[0]!.ok).toBe(false);
    expect(broker.trace[0]!.tool).toBe('object_read');
  });

  it('object_read_rejects_path_escape_and_foreign_roots', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'inside.txt'), 'safe');
    const cases: Array<[string, string]> = [
      ['{"root_id": "artifacts", "relative_path": "../escape.txt"}', 'unsafe path segment'],
      ['{"root_id": "artifacts", "relative_path": "/etc/passwd"}', 'relative path'],
      ['{"root_id": "temp", "relative_path": "x.txt"}', 'not object-readable'],
      ['{"root_id": "workspace", "relative_path": "x.txt"}', 'not object-readable'],
    ];
    for (const [locator, needle] of cases) {
      const broker = brokerWithRoot(10, dir);
      const error = errorOf(await runPtcScript(`object_read(${locator})`, broker));
      expect(error).toContain('object_read failed');
      expect(error).toContain(needle);
    }
  });

  it('object_read_rejects_symlink_escape', async () => {
    const dir = tempDir();
    const outside = path.join(tempDir(), 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(dir, 'link.txt'));
    const broker = brokerWithRoot(10, dir);
    const error = errorOf(await runPtcScript(
      'object_read({"root_id": "artifacts", "relative_path": "link.txt"})', broker,
    ));
    expect(error).toContain('escapes the managed root');
  });

  it('object_read_offset_edges_and_negative_rejected', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    const broker = brokerWithRoot(10, dir);
    const value = valueOf(await runPtcScript(`
at_end = object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=5)
past = object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=99)
{
    "at_end": [at_end["content"], at_end["eof"], at_end["next_offset"], at_end["total_size"]],
    "past": [past["content"], past["eof"], past["next_offset"]],
}
`, broker)) as Record<string, unknown>;
    expect(value.at_end).toEqual(['', true, 5, 5]);
    expect(value.past).toEqual(['', true, 5]);

    const dir2 = tempDir();
    writeFileSync(path.join(dir2, 'a.txt'), 'hello');
    expect(errorOf(await runPtcScript(
      'object_read({"root_id": "artifacts", "relative_path": "a.txt"}, offset=-1)',
      brokerWithRoot(10, dir2),
    ))).toContain('offset must be >= 0');

    const dir3 = tempDir();
    writeFileSync(path.join(dir3, 'a.txt'), 'hello');
    expect(errorOf(await runPtcScript(
      'object_read({"root_id": "artifacts", "relative_path": "a.txt"}, limit=0)',
      brokerWithRoot(10, dir3),
    ))).toContain('limit must be > 0');
  });

  it('object_read_utf8_boundary_never_splits_chars', async () => {
    const text = '汉'.repeat(10);
    const dir = tempDir();
    writeFileSync(path.join(dir, 'han.txt'), text);
    const broker = brokerWithRoot(10, dir);
    const value = valueOf(await runPtcScript(`
h = {"root_id": "artifacts", "relative_path": "han.txt"}
p1 = object_read(h, offset=0, limit=7)
p2 = object_read(h, offset=p1["next_offset"], limit=1)
{
    "c1": p1["content"], "n1": p1["next_offset"],
    "c2": p2["content"], "n2": p2["next_offset"],
}
`, broker)) as Record<string, unknown>;
    expect(value.c1).toBe('汉汉');
    expect(value.n1).toBe(6);
    expect(value.c2).toBe('汉');
    expect(value.n2).toBe(9);

    const dir2 = tempDir();
    writeFileSync(path.join(dir2, 'han.txt'), text);
    expect(errorOf(await runPtcScript(
      'object_read({"root_id": "artifacts", "relative_path": "han.txt"}, offset=1)',
      brokerWithRoot(10, dir2),
    ))).toContain('splits a UTF-8 character');
  });

  it('object_read_binary_page_is_base64_and_limit_clamped', async () => {
    const dir = tempDir();
    const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE, 0x00, 0x01]), Buffer.alloc(40 * 1024, 7)]);
    writeFileSync(path.join(dir, 'bin.dat'), bytes);
    const broker = brokerWithRoot(10, dir);
    const value = valueOf(await runPtcScript(`
h = {"root_id": "artifacts", "relative_path": "bin.dat"}
page = object_read(h, limit=999999)
{"enc": page["encoding"], "limit": page["limit"], "next": page["next_offset"],
 "total": page["total_size"], "eof": page["eof"], "sha": page["sha256"],
 "clen": len(page["content"])}
`, broker)) as Record<string, unknown>;
    expect(value.enc).toBe('base64');
    expect(value.limit).toBe(32 * 1024);
    expect(value.next).toBe(32 * 1024);
    expect(value.total).toBe(bytes.length);
    expect(value.eof).toBe(false);
    const { createHash } = await import('node:crypto');
    expect(value.sha).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(value.clen).toBe(bytes.subarray(0, 32 * 1024).toString('base64').length);
  });

  it('object_read_shares_budget_with_call', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'f.txt'), 'data');
    const broker = brokerWithRoot(2, dir, () => ({ ok: true, output: null }));
    const error = errorOf(await runPtcScript(`
call("builtin-rag_search", {})
object_read({"root_id": "artifacts", "relative_path": "f.txt"})
object_read({"root_id": "artifacts", "relative_path": "f.txt"})
`, broker));
    expect(error).toContain('budget');
    expect(broker.trace).toHaveLength(2);
    expect(broker.trace[1]!.tool).toBe('object_read');
  });

  it('object_read_without_artifacts_root_fails_structured', async () => {
    const broker = brokerForTest(10);
    const error = errorOf(await runPtcScript(
      'object_read({"root_id": "artifacts", "relative_path": "x.json"})', broker,
    ));
    expect(error).toContain('no artifacts root');
    expect(broker.trace).toHaveLength(1);
    expect(broker.trace[0]!.ok).toBe(false);
  });

  it('object_write_creates_handle_and_records_read_lineage', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'source.txt'), 'source-v1');
    const broker = brokerWithRoot(10, dir);
    const value = valueOf(await runPtcScript(`
source = object_read({"root_id": "artifacts", "relative_path": "source.txt"})
written = object_write(
    {"root_id": "artifacts", "relative_path": "generated/result.txt"},
    source["content"] + "-derived",
)
written
`, broker)) as Record<string, any>;
    expect(readFileSync(path.join(dir, 'generated/result.txt'), 'utf8')).toBe('source-v1-derived');
    expect(value.created).toBe(true);
    expect(value.object_handle.capabilities.writable).toBe(true);
    expect(value.object_handle.locator.rootId).toBe('artifacts');
    const edges = value.object_handle.provenance.derivedFrom as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.transformId).toBe('ptc.script');
    expect(String(edges[0]!.sourceHandleId)).toMatch(/^artifacts:source\.txt#/);
    expect(broker.trace).toHaveLength(2);
    expect(broker.trace[0]!.side_effect).toBeUndefined();
    expect(broker.trace[1]!.side_effect).toBe(true);
    expect(broker.trace[1]!.tool).toBe('object_write');
    expect(broker.trace[1]!.written_sha256).toBe(value.sha256);
  });

  it('object_write_enforces_capability_lock_and_managed_path', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'locked.txt'), 'v1');
    const stale = '0'.repeat(64);
    const cases = [
      'object_write({"locator": {"rootId": "artifacts", "relativePath": "locked.txt"}, '
        + '"capabilities": {"writable": False}}, "v2")',
      `object_write({"root_id": "artifacts", "relative_path": "locked.txt"}, "v2", expected_sha256="${stale}")`,
      'object_write({"root_id": "temp", "relative_path": "x.txt"}, "x")',
      'object_write({"root_id": "artifacts", "relative_path": "../x.txt"}, "x")',
    ];
    for (const script of cases) {
      const broker = brokerWithRoot(10, dir);
      const error = errorOf(await runPtcScript(script, broker));
      expect(error).toContain('object_write failed');
      expect(broker.trace).toHaveLength(1);
      expect(broker.trace[0]!.side_effect).toBe(true);
      expect(broker.trace[0]!.ok).toBe(false);
    }
    expect(readFileSync(path.join(dir, 'locked.txt'), 'utf8')).toBe('v1');
  });

  it('object_write_shares_budget_and_audit_hash_distinguishes_content', async () => {
    const dir = tempDir();
    const broker = brokerWithRoot(2, dir);
    const error = errorOf(await runPtcScript(`
object_write({"root_id": "artifacts", "relative_path": "a.txt"}, "aa")
object_write({"root_id": "artifacts", "relative_path": "b.txt"}, "bb")
object_write({"root_id": "artifacts", "relative_path": "c.txt"}, "cc")
`, broker));
    expect(error).toContain('budget');
    expect(broker.trace).toHaveLength(2);
    expect(broker.trace[0]!.args_hash).not.toBe(broker.trace[1]!.args_hash);
    expect(broker.trace.every(entry => entry.side_effect === true)).toBe(true);
  });
});
