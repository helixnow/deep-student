import type { SettingsStore } from '../../../../platform/settings/api.ts';
import { stringifyJsonLossless } from '../../../../platform/util/lossless-json.ts';
import { array, duplicateField, typedI64, typedU64, object, parseJsonExact, string } from '../json.ts';

/** types.rs:11-27 `StoredCodexSession` serde field names (camelCase, no aliases). */
const SESSION_FIELDS = ['schemaVersion', 'accessToken', 'refreshToken', 'idToken', 'expiresAtUnixMs', 'accountId',
  'email', 'planType', 'isFedramp', 'lastRefreshAt'].map(name => [name]);
import { CodexAuthError } from './error.ts';
import { CODEX_CREDENTIAL_KEY } from './protocol.ts';
import { StoredCodexSession } from './types.ts';

export interface CodexCredentialStore {
  load(): Promise<StoredCodexSession | null>;
  save(session: StoredCodexSession): Promise<void>;
  delete(): Promise<void>;
}
export class DatabaseCodexCredentialStore implements CodexCredentialStore {
  _settings: SettingsStore;
  constructor(settings: SettingsStore) { this._settings = settings; }
  async load(): Promise<StoredCodexSession | null> {
    try {
      const raw = await this._settings.getSecret(CODEX_CREDENTIAL_KEY);
      if (raw === null) return null;
      // types.rs:11-27 serde: schema_version u8, expires_at_unix_ms i64, last_refresh_at Option<i64>.
      const parsed = parseJsonExact(raw), value = object(parsed), sequence = array(parsed);
      const get = (name: string, index: number) => sequence === undefined ? value?.[name] : sequence[index];
      const key = (name: string, index: number) => sequence === undefined ? name : String(index);
      const schemaVersion = typedU64(parsed, key('schemaVersion', 0)), expiresAt = typedI64(parsed, key('expiresAtUnixMs', 4));
      const rawLastRefreshAt = get('lastRefreshAt', 9);
      const lastRefreshAt = rawLastRefreshAt === undefined || rawLastRefreshAt === null ? null : typedI64(parsed, key('lastRefreshAt', 9));
      const accessToken = get('accessToken', 1), refreshToken = get('refreshToken', 2), accountId = get('accountId', 5);
      const idToken = get('idToken', 3), email = get('email', 6), planType = get('planType', 7), isFedramp = get('isFedramp', 8);
      if ((!value && sequence === undefined) || (sequence !== undefined && sequence.length > SESSION_FIELDS.length)
        || duplicateField(parsed, SESSION_FIELDS) !== undefined || schemaVersion === undefined || schemaVersion > 255n || expiresAt === undefined
        || typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof accountId !== 'string'
        || ![idToken, email, planType].every(item => item === undefined || item === null || typeof item === 'string')
        || (isFedramp !== undefined && typeof isFedramp !== 'boolean')
        || lastRefreshAt === undefined) throw new CodexAuthError('CredentialStore');
      const session = new StoredCodexSession({ schemaVersion: Number(schemaVersion), accessToken,
        refreshToken, idToken: string(idToken) ?? null, expiresAtUnixMs: expiresAt,
        accountId, email: string(email) ?? null, planType: string(planType) ?? null,
        isFedramp: isFedramp === true, lastRefreshAt });
      if (!session.isValid()) throw new CodexAuthError('CredentialStore');
      return session;
    } catch (error) { throw new CodexAuthError('CredentialStore', { reason: error instanceof Error ? error.name : '' }); }
  }
  async save(session: StoredCodexSession): Promise<void> {
    if (!session.isValid()) throw new CodexAuthError('CredentialStore');
    try {
      const raw = stringifyJsonLossless({ schemaVersion: session.schemaVersion, accessToken: session.accessToken, refreshToken: session.refreshToken,
        idToken: session.idToken, expiresAtUnixMs: session.expiresAtUnixMs, accountId: session.accountId, email: session.email,
        planType: session.planType, isFedramp: session.isFedramp, lastRefreshAt: session.lastRefreshAt });
      await this._settings.saveSecret(CODEX_CREDENTIAL_KEY, raw);
    } catch (error) { throw new CodexAuthError('CredentialStore', { reason: error instanceof Error ? error.name : '' }); }
  }
  async delete(): Promise<void> {
    try { await this._settings.deleteSecret(CODEX_CREDENTIAL_KEY); }
    catch (error) { throw new CodexAuthError('CredentialStore', { reason: error instanceof Error ? error.name : '' }); }
  }
}
