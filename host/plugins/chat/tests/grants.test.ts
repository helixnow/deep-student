/** Ported from `chat_v2/grants.rs::tests` (L679-1222). */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import {
  BUILTIN_DESCRIPTORS, checkGrantLiveness, currentEpochFor, currentGlobalEpoch, DELEGATED_GRANT_SCHEMA_VERSION,
  ensureGrantLive, grantDenialMessage, grantEffectiveTools, grantsScopeHint, lookupGrantForSession,
  revokeAllGrants, revokeGrantsFor, scopesFromAllowedTools, toolScopeAllows, toolScopeFromAllowEntry,
  type ChatV2Database, type DelegatedGrant, type ToolScope,
} from '../api.ts';
import {
  issueWorkerGrant, loadedEpochFor, loadRevocationEpochs, persistRevocationEpoch, restoreRevocationEpochsFromDb,
} from '../src/grants.ts';
import { ulid } from '../src/ulid.ts';
import type { ChatLogger } from '../src/logger.ts';
import {
  AgentProfileResolver, DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
} from '../../agent-workspace/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';

const logs: { level: string; message: string }[] = [];
const log: ChatLogger = {
  error: message => { logs.push({ level: 'error', message }); },
  warn: message => { logs.push({ level: 'warn', message }); },
  info: message => { logs.push({ level: 'info', message }); },
  debug: message => { logs.push({ level: 'debug', message }); },
};

/** `LEGACY_SHELL_FAMILY_TOOLS` oracle (grants.rs:672-676). */
const LEGACY_SHELL_FAMILY_TOOLS = ['builtin-local_shell_execute', 'builtin-local_shell_preflight'];

const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); logs.length = 0; });

/** Real chat plugin + migrated chat_v2 DB (V20260910 applied by the real migration chain). */
async function grantsHost(prepare?: (db: import('../../../platform/storage/api.ts').DatabaseHandle) => void) {
  const f = databaseFixture();
  prepare?.(f.db);
  const host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  disposers.push(() => f.dispose(), () => host.dispose());
  return { host, f, db: host.ctx.chatSession.database as ChatV2Database };
}

function bareGrant(toolScopes: ToolScope[]): DelegatedGrant {
  return {
    grantId: 'grant_test', schemaVersion: DELEGATED_GRANT_SCHEMA_VERSION, parentTaskId: 'parent',
    childTaskId: 'child', toolScopes, objectScopes: [], networkDestinations: [], budget: null,
    expiry: null, revocationEpoch: 0n, profileHash: '',
  };
}

function legacyFromAllowEntry(raw: string): ToolScope {
  const entry = raw.trim();
  const separator = entry.indexOf('::');
  if (separator >= 0) return { kind: 'mcp', server: entry.slice(0, separator), tool: entry.slice(separator + 2) };
  if (entry.startsWith('mcp.tools.') || entry.startsWith('mcp_')) return { kind: 'mcp', server: '', tool: entry };
  return { kind: 'builtin', name: entry };
}

const shiftSeconds = (seconds: number) => toRfc3339(BigInt(Date.now() + seconds * 1000) * 1_000_000n);

describe('grants.rs tests', () => {
  it('builtin_profiles_map_losslessly_to_grant_scopes', () => {
    for (const profileId of [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID]) {
      const profile = AgentProfileResolver.builtIn(profileId)!;
      const grant = bareGrant(scopesFromAllowedTools(profile.allowedTools));
      for (const tool of profile.allowedTools) {
        expect(grant.toolScopes.some(scope => toolScopeAllows(scope, tool, {})), `${profileId}: ${tool}`).toBe(true);
      }
      expect(grantEffectiveTools(grant, profile.allowedTools)).toEqual(profile.allowedTools);
      for (const foreign of ['builtin-dstu_delete', 'builtin-note_append', 'builtin-chatanki_run', 'builtin-local_shell_execute']) {
        if (!profile.allowedTools.includes(foreign)) {
          expect(grant.toolScopes.some(scope => toolScopeAllows(scope, foreign, {})), `${profileId}: ${foreign}`).toBe(false);
        }
      }
    }
  });

  it('effective_tools_computes_intersection', () => {
    const profileTools = ['builtin-web_fetch', 'builtin-web_search', 'builtin-resource_read'];
    const grant = bareGrant([{ kind: 'builtin', name: 'builtin-web_search' }, { kind: 'builtin', name: 'builtin-unified_search' }]);
    expect(grantEffectiveTools(grant, profileTools)).toEqual(['builtin-web_search']);
    expect(grantEffectiveTools(bareGrant([]), profileTools)).toEqual([]);
    expect(grantEffectiveTools(grant, [])).toEqual([]);
  });

  it('scopes_respect_source_isolation', () => {
    const builtin: ToolScope = { kind: 'builtin', name: 'builtin-web_search' };
    expect(toolScopeAllows(builtin, 'builtin-web_search', {})).toBe(true);
    expect(toolScopeAllows(builtin, 'web_search', {})).toBe(true);
    expect(toolScopeAllows(builtin, 'mcp_web_search', {})).toBe(false);
    expect(toolScopeAllows(builtin, 'web_search', { _serverId: 'evil' })).toBe(false);
    const mcp = toolScopeFromAllowEntry('server-a::fetch');
    expect(toolScopeAllows(mcp, 'fetch', { _serverId: 'server-a' })).toBe(true);
    expect(toolScopeAllows(mcp, 'fetch', { _serverId: 'server-b' })).toBe(false);
    expect(toolScopeAllows(mcp, 'fetch', {})).toBe(false);
    expect(toolScopeAllows({ kind: 'shell', prefixes: ['ls'] }, 'builtin-local_shell_execute', {})).toBe(false);
  });

  it('registry_driven_scope_derivation_matches_legacy_rules', () => {
    const flagged = new Set(BUILTIN_DESCRIPTORS.filter(d => d.grantsScopeHint === 'shell').map(d => d.name));
    const legacy = new Set(LEGACY_SHELL_FAMILY_TOOLS.map(name => name.startsWith('builtin-') ? name.slice(8) : name));
    expect(flagged).toEqual(legacy);
    for (const name of LEGACY_SHELL_FAMILY_TOOLS) {
      const bare = name.startsWith('builtin-') ? name.slice(8) : name;
      for (const entry of [name, bare]) {
        const scope = toolScopeFromAllowEntry(entry);
        expect(scope.kind, entry).toBe('shell');
        expect(toolScopeAllows(scope, entry, {}), entry).toBe(false);
      }
    }
    for (const descriptor of BUILTIN_DESCRIPTORS) {
      if (descriptor.grantsScopeHint === 'shell') continue;
      for (const entry of [descriptor.name, `builtin-${descriptor.name}`]) {
        expect(toolScopeFromAllowEntry(entry), entry).toEqual(legacyFromAllowEntry(entry));
      }
    }
    for (const outsider of ['mcp_anything', 'builtin-mcp_foo', 'anki_generate_cards', 'nonexistent_tool', 'server-a::fetch']) {
      expect(grantsScopeHint(outsider), outsider).toBeNull();
      expect(toolScopeFromAllowEntry(outsider), outsider).toEqual(legacyFromAllowEntry(outsider));
    }
  });

  it('expiry_gates_liveness', () => {
    const now = toRfc3339();
    const grant = bareGrant([]);
    grant.expiry = shiftSeconds(-1);
    expect(checkGrantLiveness(grant, 0n, now)).toBe('expired');
    grant.expiry = shiftSeconds(300);
    expect(checkGrantLiveness(grant, 0n, now)).toBeNull();
    grant.expiry = null;
    expect(checkGrantLiveness(grant, grant.revocationEpoch, now)).toBeNull();
  });

  it('epoch_liveness_is_monotonic', () => {
    const grant = bareGrant([]);
    grant.revocationEpoch = 5n;
    expect(checkGrantLiveness(grant, 5n, toRfc3339())).toBeNull();
    expect(checkGrantLiveness(grant, 6n, toRfc3339())).toBe('revoked');
  });

  it('global_revocation_epoch_gates_registered_grants', async () => {
    const { db } = await grantsHost();
    const suffix = ulid();
    const [sessionA, childA] = [`sess_a_${suffix}`, `child_a_${suffix}`];
    const [sessionB, childB] = [`sess_b_${suffix}`, `child_b_${suffix}`];
    const tools = ['builtin-web_search'];
    const guardA = issueWorkerGrant(sessionA, 'parent', childA, tools, '', null, log);
    const guardB = issueWorkerGrant(sessionB, 'parent', childB, tools, '', null, log);
    expect(ensureGrantLive(lookupGrantForSession(sessionA)!)).toBeNull();
    expect(ensureGrantLive(lookupGrantForSession(sessionB)!)).toBeNull();

    const revokedEpochA = revokeGrantsFor(db, childA, log);
    expect(ensureGrantLive(lookupGrantForSession(sessionA)!)).toBe('revoked');
    expect(ensureGrantLive(lookupGrantForSession(sessionB)!)).toBeNull();
    const sessionA2 = `sess_a2_${suffix}`;
    const guardA2 = issueWorkerGrant(sessionA2, 'parent', `child_a2_${suffix}`, tools, '', null, log);
    expect(ensureGrantLive(lookupGrantForSession(sessionA2)!)).toBeNull();

    let persisted = loadRevocationEpochs(db, log);
    expect(loadedEpochFor(persisted, childA)).toBe(revokedEpochA);

    const globalEpoch = revokeAllGrants(db, log);
    expect(ensureGrantLive(lookupGrantForSession(sessionB)!)).toBe('revoked');
    expect(ensureGrantLive(lookupGrantForSession(sessionA2)!)).toBe('revoked');
    const sessionD = `sess_d_${suffix}`;
    const guardD = issueWorkerGrant(sessionD, 'parent', `child_d_${suffix}`, tools, '', null, log);
    expect(ensureGrantLive(lookupGrantForSession(sessionD)!)).toBeNull();

    persisted = loadRevocationEpochs(db, log);
    expect(persisted.global).toBe(globalEpoch);

    const grantIdA = guardA.grantId;
    const guardA3 = issueWorkerGrant(sessionA, 'parent', childA, tools, '', null, log);
    expect(guardA3.grantId).not.toBe(grantIdA);
    guardA.dispose();
    expect(lookupGrantForSession(sessionA)).not.toBeNull();
    guardA3.dispose();
    expect(lookupGrantForSession(sessionA)).toBeNull();
    guardB.dispose();
    expect(lookupGrantForSession(sessionB)).toBeNull();
    guardA2.dispose();
    guardD.dispose();
  });

  it('denial_messages_are_explicit', () => {
    expect(grantDenialMessage('revoked', 'grant_x', 'builtin-web_search')).toContain('授权已撤销');
    expect(grantDenialMessage('expired', 'grant_x', 'builtin-web_search')).toContain('授权已过期');
  });

  it('epoch_persistence_roundtrip', async () => {
    const { db } = await grantsHost();
    persistRevocationEpoch(db, 'global', '', 7n);
    persistRevocationEpoch(db, 'task', 'child-x', 9n);
    persistRevocationEpoch(db, 'task', 'child-y', 3n);
    persistRevocationEpoch(db, 'task', 'child-y', 4n);
    const loaded = loadRevocationEpochs(db, log);
    expect(loaded.global).toBe(7n);
    expect(loaded.tasks.filter(([id]) => id === 'child-y').map(([, epoch]) => epoch)).toEqual([4n]);
    expect(loadedEpochFor(loaded, 'child-x')).toBe(9n);
    expect(loadedEpochFor(loaded, 'child-y')).toBe(7n);
    expect(loadedEpochFor(loaded, 'child-unknown')).toBe(7n);
  });

  it('epoch_reload_keeps_revocation_effective', async () => {
    const { db } = await grantsHost();
    const childRevoked = `child_revoked_${ulid()}`;
    const childOther = `child_other_${ulid()}`;
    persistRevocationEpoch(db, 'global', '', 5n);
    persistRevocationEpoch(db, 'task', childRevoked, 8n);
    const loaded = loadRevocationEpochs(db, log);
    const now = toRfc3339();
    const grant = bareGrant([]);
    grant.childTaskId = childRevoked;
    grant.revocationEpoch = 6n;
    expect(checkGrantLiveness(grant, loadedEpochFor(loaded, childRevoked), now)).toBe('revoked');
    grant.revocationEpoch = 8n;
    expect(checkGrantLiveness(grant, loadedEpochFor(loaded, childRevoked), now)).toBeNull();
    grant.childTaskId = childOther;
    grant.revocationEpoch = 4n;
    expect(checkGrantLiveness(grant, loadedEpochFor(loaded, childOther), now)).toBe('revoked');
    grant.revocationEpoch = 5n;
    expect(checkGrantLiveness(grant, loadedEpochFor(loaded, childOther), now)).toBeNull();
  });

  it('revoke_fails_closed_when_db_write_fails', async () => {
    const { db } = await grantsHost(conn => conn.exec('DROP TABLE revocation_epochs'));
    const globalBefore = currentGlobalEpoch();
    const child = `child_fc_${ulid()}`;
    const taskBefore = currentEpochFor(child);
    expect(() => revokeAllGrants(db, log)).toThrow();
    expect(() => revokeGrantsFor(db, child, log)).toThrow();
    expect(currentGlobalEpoch()).toBe(globalBefore);
    expect(currentEpochFor(child)).toBe(taskBefore);
  });

  it('restore_installs_loaded_epochs_with_max_semantics', async () => {
    const child = `child_restore_${ulid()}`;
    const globalBase = currentGlobalEpoch();
    // Production entry: rows present before the chat plugin starts are restored by index.ts.
    const { db } = await grantsHost(conn => {
      conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('global', '', ?1, 't0')", [globalBase + 10n]);
      conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('task', ?1, ?2, 't0')", [child, globalBase + 12n]);
    });
    expect(currentGlobalEpoch()).toBe(globalBase + 10n);
    expect(currentEpochFor(child)).toBe(globalBase + 12n);
    persistRevocationEpoch(db, 'task', child, 1n);
    restoreRevocationEpochsFromDb(db, log);
    expect(currentGlobalEpoch()).toBe(globalBase + 10n);
    expect(currentEpochFor(child)).toBe(globalBase + 12n);
  });

  it('restore_tolerates_missing_table', async () => {
    const globalBefore = currentGlobalEpoch();
    const { db } = await grantsHost(conn => conn.exec('DROP TABLE revocation_epochs'));
    restoreRevocationEpochsFromDb(db, log);
    expect(currentGlobalEpoch()).toBe(globalBefore);
    expect(loadRevocationEpochs(db, log).global).toBe(0n);
  });
});
