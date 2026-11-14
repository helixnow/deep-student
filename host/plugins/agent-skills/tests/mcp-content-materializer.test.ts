import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ENCODED_ITEM_BYTES, MCP_SUBDIR, materializeMcpToolOutputAtRoot,
  mcpProvenanceFromUsage, type McpOutputProvenance,
} from '../src/tools/mcp-content-materializer.ts';

function provenance(): McpOutputProvenance {
  return {
    provider: 'mcp',
    server: 'server/../../unsafe',
    tool: 'render:image',
  };
}

function png(seed: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8, seed)]);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('mcp_content_materializer.rs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-materializer-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves_text_and_materializes_image_with_object_handle', () => {
    const output = [
      { type: 'text', text: 'unchanged' },
      { type: 'image', data: base64(png(1)), mimeType: 'image/png' },
    ];
    const result = materializeMcpToolOutputAtRoot(output, root, provenance()) as Array<
      Record<string, any>
    >;
    expect(result[0]).toEqual({ type: 'text', text: 'unchanged' });
    expect(result[1]!.data).toBeUndefined();
    const artifact = result[1]!.artifact;
    expect(artifact.root_id).toBe('artifacts');
    expect(artifact.mime_type).toBe('image/png');
    expect(artifact.object_handle.locator.rootId).toBe('artifacts');
    const filePath = path.join(root, artifact.relative_path as string);
    expect(fs.readFileSync(filePath)).toEqual(png(1));
  });

  it('resource_blob_preserves_uri_and_sanitizes_filename', () => {
    const uri = 'https://example.test/../../report.pdf?token=secret';
    const output = [{
      type: 'resource',
      resource: { uri, mimeType: 'application/pdf', blob: base64(Buffer.from('%PDF-1.7\nbody')) },
    }];
    const result = materializeMcpToolOutputAtRoot(output, root, provenance()) as Array<
      Record<string, any>
    >;
    const resource = result[0]!.resource;
    expect(resource.blob).toBeUndefined();
    expect(resource.artifact.source_uri).toBe(uri);
    const relative = resource.artifact.relative_path as string;
    expect(relative.startsWith('mcp/')).toBe(true);
    expect(relative).not.toContain('../');
  });

  it('secx_04_rejects_invalid_base64_mime_mismatch_and_disguised_executable', () => {
    const invalid = [{ type: 'image', mimeType: 'image/png', data: '%%%' }];
    expect(() => materializeMcpToolOutputAtRoot(invalid, root, provenance()))
      .toThrow('invalid base64');

    const mismatch = [{ type: 'image', mimeType: 'image/jpeg', data: base64(png(2)) }];
    expect(() => materializeMcpToolOutputAtRoot(mismatch, root, provenance()))
      .toThrow('MIME mismatch');

    const executable = [{
      type: 'resource',
      resource: {
        uri: 'mcp://server/photo.png',
        mimeType: 'image/png',
        blob: base64(Buffer.from('MZfake executable')),
      },
    }];
    expect(() => materializeMcpToolOutputAtRoot(executable, root, provenance()))
      .toThrow('executable signature');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects_oversize_before_decode', () => {
    const encoded = 'A'.repeat(MAX_ENCODED_ITEM_BYTES + 1);
    const output = [{ type: 'image', mimeType: 'image/png', data: encoded }];
    expect(() => materializeMcpToolOutputAtRoot(output, root, provenance()))
      .toThrow('decoded-size limit');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('collision_does_not_overwrite_existing_file', () => {
    const first = materializeMcpToolOutputAtRoot(
      [{ type: 'image', mimeType: 'image/png', data: base64(png(3)) }], root, provenance(),
    ) as Array<Record<string, any>>;
    const second = materializeMcpToolOutputAtRoot(
      [{ type: 'image', mimeType: 'image/png', data: base64(png(3)) }], root, provenance(),
    ) as Array<Record<string, any>>;
    const firstPath = first[0]!.artifact.relative_path as string;
    const secondPath = second[0]!.artifact.relative_path as string;
    expect(firstPath).not.toBe(secondPath);
    expect(fs.readFileSync(path.join(root, firstPath))).toEqual(png(3));
    expect(fs.readFileSync(path.join(root, secondPath))).toEqual(png(3));
  });

  it('rejects_symlinked_materialization_parent', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-materializer-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, MCP_SUBDIR));
      const output = [{ type: 'image', mimeType: 'image/png', data: base64(png(4)) }];
      expect(() => materializeMcpToolOutputAtRoot(output, root, provenance()))
        .toThrow('symlinks');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('wraps object-shaped content and leaves text-only payloads untouched', () => {
    const payload: Record<string, unknown> = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', mimeType: 'image/png', data: base64(png(5)) },
      ],
    };
    materializeMcpToolOutputAtRoot(payload, root, provenance());
    const content = payload.content as Array<Record<string, any>>;
    expect(content[0]).toEqual({ type: 'text', text: 'a' });
    expect(content[1]!.artifact.sha256).toBeTruthy();
  });

  it('provenance defaults mirror Rust fallbacks', () => {
    expect(mcpProvenanceFromUsage('t', null)).toEqual({
      provider: 'mcp', server: 'unknown-server', tool: 't',
    });
    expect(mcpProvenanceFromUsage('t', { provider: '  ', serverId: 's1' })).toEqual({
      provider: 'mcp', server: 's1', tool: 't',
    });
  });
});
