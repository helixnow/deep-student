import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 markdown typography contract', () => {
  const chatCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat.css'),
    'utf-8',
  );
  const markdownCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/markdown.css'),
    'utf-8',
  );
  const beautifyCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat-beautify.css'),
    'utf-8',
  );
  const blockedMarkdownRendererSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/BlockedMarkdownRenderer.tsx'),
    'utf-8',
  );

  it('defines shared reading-rhythm tokens for assistant markdown output', () => {
    expect(chatCssSource).toContain('--chat-md-font-size:');
    expect(chatCssSource).toContain('--chat-md-line-height:');
    expect(chatCssSource).toContain('--chat-md-letter-spacing:');
    expect(chatCssSource).toContain('--chat-md-paragraph-gap:');
    expect(chatCssSource).toContain('--chat-md-heading-top-gap:');
    expect(chatCssSource).toContain('--chat-md-heading-bottom-gap:');
    expect(chatCssSource).toContain('--chat-md-list-item-gap:');
    expect(chatCssSource).toContain('--chat-md-compact-gap:');
    expect(chatCssSource).toContain('--chat-md-table-gap:');
    expect(chatCssSource).toContain('--chat-content-max-width:');
    expect(chatCssSource).toContain('--chat-md-compact-font-size:');
    expect(chatCssSource).toContain('--chat-md-compact-line-height:');
  });

  it('uses the shared rhythm tokens in markdown base styles and assistant overrides', () => {
    expect(markdownCssSource).toContain('font-size: var(--chat-md-font-size);');
    expect(markdownCssSource).toContain('line-height: var(--chat-md-line-height);');
    expect(markdownCssSource).toContain('letter-spacing: var(--chat-md-letter-spacing);');
    expect(markdownCssSource).toContain('margin: var(--chat-md-heading-top-gap) 0 var(--chat-md-heading-bottom-gap);');
    expect(markdownCssSource).toContain('margin: var(--chat-md-paragraph-gap) 0;');
    expect(markdownCssSource).toContain('margin: var(--chat-md-block-gap) 0;');
    expect(markdownCssSource).toContain('margin: var(--chat-md-table-gap) 0;');
    expect(markdownCssSource).toContain('margin: var(--chat-md-list-item-gap) 0;');

    expect(beautifyCssSource).toContain('font-size: var(--chat-md-font-size);');
    expect(beautifyCssSource).toContain('line-height: var(--chat-md-line-height);');
    expect(beautifyCssSource).toContain('letter-spacing: var(--chat-md-letter-spacing);');
  });

  it('keeps secondary reading surfaces comfortably readable instead of cramped', () => {
    const ragSourceContentRuleStart = markdownCssSource.indexOf('.chat-v2 .rag-source-content {');
    const ragSourceContentRuleEnd = markdownCssSource.indexOf('}', ragSourceContentRuleStart);
    const ragSourceContentRule = markdownCssSource.slice(ragSourceContentRuleStart, ragSourceContentRuleEnd);

    expect(markdownCssSource).toContain('font-size: var(--chat-md-compact-font-size);');
    expect(markdownCssSource).toContain('line-height: var(--chat-md-compact-line-height);');
    expect(markdownCssSource).toContain('padding: var(--chat-md-compact-gap);');
    expect(ragSourceContentRuleStart).toBeGreaterThan(-1);
    expect(ragSourceContentRule).toContain('font-style: normal;');
  });

  it('keeps empty-line handling lightweight instead of relying on many forceful overrides', () => {
    const emptyParagraphMatches = markdownCssSource.match(/p:empty/g) ?? [];
    const emptyLineImportantMatches = markdownCssSource.match(/p:empty[\s\S]{0,120}!important/g) ?? [];

    expect(emptyParagraphMatches.length).toBeLessThanOrEqual(2);
    expect(emptyLineImportantMatches.length).toBe(0);
  });

  it('owns assistant reading measure in chat.css instead of duplicating width control in beautify overrides', () => {
    expect(chatCssSource).toContain('.chat-v2 .chat-container .message.assistant .message-content {');
    expect(chatCssSource).toContain('max-width: var(--chat-content-max-width);');
    expect(chatCssSource).toContain('width: 100%;');

    expect(beautifyCssSource).not.toContain('max-width: var(--chat-content-max-width);');
  });

  it('limits fit-content selection behavior to prose blocks instead of structural containers', () => {
    const fitContentRuleStart = chatCssSource.indexOf('.chat-v2 .message-selectable-area .markdown-content > p,');
    const fitContentRuleEnd = chatCssSource.indexOf('}', fitContentRuleStart);
    const fitContentRule = chatCssSource.slice(fitContentRuleStart, fitContentRuleEnd);

    expect(fitContentRuleStart).toBeGreaterThan(-1);
    expect(fitContentRule).toContain('.chat-v2 .message-selectable-area .markdown-content > p,');
    expect(fitContentRule).toContain('.chat-v2 .message-selectable-area .markdown-content > h6');
    expect(fitContentRule).not.toContain('.streaming-blocks > .stream-block');
    expect(fitContentRule).not.toContain('.markdown-content li');
    expect(fitContentRule).not.toContain('.markdown-content blockquote');
    expect(fitContentRule).not.toContain('.markdown-content dt');
    expect(fitContentRule).not.toContain('.markdown-content dd');
  });

  it('restores tight selection to nested prose inside structural containers', () => {
    expect(chatCssSource).toContain('.chat-v2 .message-selectable-area .markdown-content li > p,');
    expect(chatCssSource).toContain('.chat-v2 .message-selectable-area .markdown-content blockquote > p,');
    expect(chatCssSource).toContain('.chat-v2 .message-selectable-area .markdown-content dd > p');
    expect(chatCssSource).toContain('width: fit-content;');
  });

  it('uses pure external spacing rules around tables instead of table-internal padding', () => {
    expect(markdownCssSource).toContain('.chat-v2 .markdown-content > :is(h1, h2, h3, h4, h5, h6):has(+ .table-wrapper) {');
    expect(markdownCssSource).toContain('.chat-v2 .markdown-content > .table-wrapper + :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6) {');
    expect(markdownCssSource).not.toContain('padding-block:');
  });

  it('applies table breathing room on the blocked streaming shell, not only inside the table subtree', () => {
    expect(blockedMarkdownRendererSource).toContain('block-type-${block.type}');
    expect(markdownCssSource).toContain('.chat-v2 .blocked-markdown > .markdown-content.block-type-table {');
    expect(markdownCssSource).toContain('.chat-v2 .blocked-markdown > .markdown-content.block-type-table + .markdown-content {');
  });
});
