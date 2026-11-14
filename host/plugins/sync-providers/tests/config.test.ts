import { describe, expect, it } from 'vitest';
import { insecureTransportAuthorized, type RuntimeCloudStorageConfig } from '../api.ts';
import {
  validateConfig, configRoot, isLocalEndpoint, debugWebDavConfig, debugS3Config,
  debugFtpConfig, providerDisplay,
} from '../src/config.ts';

const webdav = (endpoint = 'https://dav.example.com'): RuntimeCloudStorageConfig => ({
  provider: 'webdav', webdav: { endpoint, username: 'user', password: 'pass' },
});
const s3 = (endpoint = 'https://s3.amazonaws.com'): RuntimeCloudStorageConfig => ({
  provider: 's3', s3: { endpoint, bucket: 'my-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
});

describe('config.rs', () => {
  it('test_config_validation', () => {
    const config = webdav();
    expect(() => validateConfig(config)).not.toThrow();
    config.webdav!.endpoint = '';
    expect(() => validateConfig(config)).toThrow();
    config.webdav!.endpoint = 'https://dav.example.com';
    config.webdav!.password = ' ';
    expect(() => validateConfig(config)).toThrow();
    expect(() => validateConfig(s3())).not.toThrow();
  });

  it('test_https_enforcement_webdav', () => {
    expect(() => validateConfig(webdav('http://dav.example.com'))).toThrow();
    const forged = JSON.parse('{"provider":"webdav","webdav":{"endpoint":"http://dav.example.com","username":"user","password":"pass"},"allowInsecure":true,"insecureTransportAuthorized":true}') as RuntimeCloudStorageConfig;
    // config.rs:497 `assert!(!forged.insecure_transport_authorized)`: the capability is a
    // symbol key that no JSON payload can set.
    expect(forged[insecureTransportAuthorized]).not.toBe(true);
    expect(() => validateConfig(forged)).toThrow();
    expect(() => validateConfig(webdav('http://localhost:8080/dav'))).not.toThrow();
    expect(() => validateConfig(webdav('http://127.42.0.1:8080/dav'))).not.toThrow();
  });

  it('test_https_enforcement_s3', () => {
    expect(() => validateConfig(s3('http://s3.example.com'))).toThrow();
    expect(() => validateConfig(s3('http://localhost:9000'))).not.toThrow();
  });

  it('test_debug_redaction', () => {
    const dav = debugWebDavConfig({ endpoint: 'https://dav.example.com', username: 'user', password: 'super-secret' });
    expect(dav).not.toContain('super-secret');
    expect(dav).toContain('[REDACTED]');
    const aws = debugS3Config({ endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
    expect(aws).not.toContain('wJalrXUtnFEMI');
    expect(aws).toContain('[REDACTED]');
    expect(aws).toContain('AKIA');
  });

  it('test_default_root', () => {
    expect(configRoot({})).toBe('deep-student-sync');
    expect(configRoot({ root: '' })).toBe('deep-student-sync');
    expect(configRoot({ root: '/' })).toBe('deep-student-sync');
    expect(configRoot({ root: '  /custom/path/  ' })).toBe('custom/path');
  });

  it('test_is_local_endpoint', () => {
    for (const endpoint of ['http://localhost:8080/dav', 'http://127.0.0.1:9000', 'http://[::1]:8080', 'https://localhost/path']) {
      expect(isLocalEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of ['http://localhost.evil.com', 'http://fakehost-localhost.com', 'https://dav.example.com', 'not-a-url']) {
      expect(isLocalEndpoint(endpoint)).toBe(false);
    }
  });

  it('test_localhost_evil_rejected', () => {
    expect(() => validateConfig(webdav('http://localhost.evil.com/dav'))).toThrow();
    expect(() => validateConfig(s3('http://localhost.evil.com'))).toThrow();
  });

  it('test_ftp_config_validation', () => {
    const ftp = { host: 'ftp.example.com', port: 21, username: 'user', password: 'pass', useTls: true };
    const config: RuntimeCloudStorageConfig = { provider: 'ftp', ftp };
    expect(() => validateConfig(config)).not.toThrow();
    ftp.host = '';
    expect(() => validateConfig(config)).toThrow();
    ftp.host = 'ftp.example.com'; ftp.username = '';
    expect(() => validateConfig(config)).toThrow();
    ftp.username = 'user'; ftp.password = '';
    expect(() => validateConfig(config)).toThrow();
    ftp.password = 'pass'; ftp.useTls = false;
    expect(() => validateConfig(config)).toThrow();
    ftp.host = 'localhost';
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('test_ftp_rejected_on_android', () => {
    const config: RuntimeCloudStorageConfig = { provider: 'ftp', ftp: { host: 'ftp.example.com', port: 21, username: 'user', password: 'pass', useTls: true } };
    // config.rs:749-754 compares the entire error, not a substring.
    expect(() => validateConfig(config, { ftpSupported: false, s3Supported: false })).toThrow(/^FTP\/FTPS storage is not available on Android\.$/);
  });

  it('test_ftp_debug_redaction', () => {
    const debug = debugFtpConfig({ host: 'ftp.example.com', port: 21, username: 'user', password: 'super-secret', useTls: true });
    expect(debug).not.toContain('super-secret');
    expect(debug).toContain('[REDACTED]');
  });
});

describe('mod.rs', () => {
  it('test_config_validation', () => expect(() => validateConfig(webdav())).not.toThrow());
  it('test_provider_display', () => {
    expect(providerDisplay('webdav')).toBe('WebDAV');
    expect(providerDisplay('s3')).toBe('S3');
  });
});
