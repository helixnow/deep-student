import { describe, expect, it } from 'vitest';

import { browserToolsSkill } from '../builtin-tools/browser-tools';
import { mediaToolsSkill } from '../builtin-tools/media-tools';
import { webFetchSkill } from '../builtin-tools/web-fetch';

describe('WEB-04/05 and GAP11/12 contracts', () => {
  it('WEB-04/05 advertises binary materialization and redirect validation', () => {
    const fetch = webFetchSkill.embeddedTools?.find(tool => tool.name === 'builtin-web_fetch');
    expect(fetch?.description).toMatch(/PDF.*DOCX.*magic.*artifacts/i);
    expect(fetch?.description).toMatch(/最终跳转域名/);
  });

  it('GAP11 exposes screenshot capability without promising a fake image', () => {
    const screenshot = browserToolsSkill.embeddedTools?.find(
      tool => tool.name === 'builtin-browser_screenshot',
    );
    expect(screenshot?.description).toContain('available=false');
    expect(screenshot?.description).toContain('PLATFORM_API_UNAVAILABLE');
    expect(screenshot?.description).toContain('绝不伪造');
  });

  it('GAP12 exposes managed ASR and explicit video unsupported state', () => {
    const names = mediaToolsSkill.embeddedTools?.map(tool => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['builtin-media_capabilities', 'builtin-media_transcribe']),
    );
    expect(mediaToolsSkill.content).toMatch(/不安装依赖、不修改系统环境/);
    expect(mediaToolsSkill.content).toMatch(/视频音轨提取.*available=true/);
    expect(mediaToolsSkill.content).toMatch(/外部 ASR 提供商.*artifact/);
    expect(mediaToolsSkill.content).toMatch(/MP3、WAV、OGG、FLAC/);
  });

  it('media transcription consumes a typed source handle', () => {
    const transcribe = mediaToolsSkill.embeddedTools?.find(
      tool => tool.name === 'builtin-media_transcribe',
    );
    expect(transcribe?.inputSchema.required).toContain('source');
    expect(transcribe?.inputSchema.properties?.source).toMatchObject({ type: 'object' });
    expect(transcribe?.description).toMatch(/外部 ASR 提供商/);
    expect(transcribe?.description).toMatch(/MP3\/WAV\/OGG\/FLAC/);
  });
});
