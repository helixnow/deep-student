import { describe, expect, it } from 'vitest';

import { toSafeCloudStorageConfig, type CloudStorageConfig } from '../cloudStorageApi';

describe('cloud storage backend SSOT DTO', () => {
  it('strips WebDAV and encryption credentials', () => {
    const config: CloudStorageConfig = {
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: 'secret' },
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'ignored',
        accessKeyId: 'ignored',
        secretAccessKey: 'ignored',
      },
      root: 'deep-student-sync',
      encryptionPassword: 'encryption-secret',
    };

    expect(toSafeCloudStorageConfig(config)).toEqual({
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      root: 'deep-student-sync',
    });
    expect(JSON.stringify(toSafeCloudStorageConfig(config))).not.toMatch(/password|secret|s3/i);
  });

  it('keeps only non-secret S3 connection fields', () => {
    const safe = toSafeCloudStorageConfig({
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'coursework',
        accessKeyId: 'public-id',
        secretAccessKey: 'secret',
        region: 'cn-test-1',
        pathStyle: true,
      },
      encryptionPassword: 'secret',
    });

    expect(safe).toEqual({
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'coursework',
        accessKeyId: 'public-id',
        region: 'cn-test-1',
        pathStyle: true,
      },
    });
    expect(JSON.stringify(safe)).not.toMatch(/secretAccessKey|encryptionPassword/);
  });

  it('rejects a selected provider without its config block', () => {
    expect(() => toSafeCloudStorageConfig({ provider: 'ftp' })).toThrow('Missing FTP');
  });
});
