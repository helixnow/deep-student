/** Index profile ids are stored in vfs.db (`vfs_index_profiles`, segments, units): the portable hasher must
 * produce the same digests as `node:crypto` over the same UTF-8 byte stream (embedding_dim_repo.rs, sha2). */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  generateIndexProfileId, INDEX_PROFILE_SCHEMA_VERSION, modelFingerprint, modelFingerprintWithTransport, normalizedPublicBaseUrl,
  type TransportFingerprintInput,
} from '../repository/embedding-dim.ts';

function nodeDigest(prefix: string, values: string[]): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(prefix, 'utf8'));
  for (const value of values) {
    hash.update(Buffer.from(value, 'utf8'));
    hash.update(Buffer.from('\0', 'utf8'));
  }
  return hash.digest('hex');
}

const TRANSPORTS: Array<[string, string, string, TransportFingerprintInput]> = [
  ['cfg-1', 'text-embedding-3-small', 'openai', {}],
  ['配置-嵌入', 'bge-m3（本地）', 'openai', { providerType: 'siliconflow', providerScope: 'user', baseUrl: 'https://User:pw@API.example.com/v1/',
    apiProtocol: 'openai', modelAdapter: 'general' }],
  ['', '', '', { baseUrl: null, providerType: null }],
];

it.each(TRANSPORTS)('modelFingerprintWithTransport(%j, %j, %j) matches the node:crypto digest of the same fields', (id, model, protocol, transport) => {
  const fields: Array<[string, string]> = [
    ['protocol', protocol], ['config_id', id], ['model', model],
    ['provider_type', transport.providerType ?? ''], ['provider_scope', transport.providerScope ?? ''],
    ['base_url', transport.baseUrl == null ? '' : normalizedPublicBaseUrl(transport.baseUrl)],
    ['api_protocol', transport.apiProtocol ?? ''], ['model_adapter', transport.modelAdapter ?? ''],
  ];
  expect(modelFingerprintWithTransport(id, model, protocol, transport))
    .toBe(`sha256:${nodeDigest('vfs-index-profile-v2\0', fields.flat())}`);
});

it('generateIndexProfileId matches the node:crypto digest of fingerprint, modality, dimension, protocol and schema version', () => {
  const fingerprint = modelFingerprint('配置-嵌入', 'bge-m3', 'openai');
  expect(generateIndexProfileId(fingerprint, 1024, 'text', 'openai'))
    .toBe(`profile_${nodeDigest('vfs-index-profile-id-v1\0', [fingerprint, 'text', '1024', 'openai', String(INDEX_PROFILE_SCHEMA_VERSION)])}`);
});
