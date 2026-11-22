import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchTypedEvent } from '@/events/registry';
import {
  NOTES_ACTIVE_HEADING_EVENT,
  type NotesActiveHeadingDetail,
} from '../outlineActiveHeadingBridge';
import {
  NoteFloatingToc,
  extractFloatingTocHeadings,
} from '../NoteFloatingToc';

const tocCss = readFileSync(
  resolve(process.cwd(), 'src/features/notes/components/NoteFloatingToc.css'),
  'utf8',
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('extractFloatingTocHeadings', () => {
  it('extracts h1-h6 headings, strips inline formatting, and skips fenced code blocks', () => {
    const md = [
      '# **Title** with `code`',
      'Some paragraph text',
      '```markdown',
      '# Heading inside backtick fence',
      '~~~',
      '## Still inside backtick fence',
      '```',
      '## [Link Heading](https://example.com) ##',
      '~~~ts',
      '### Heading inside tilde fence',
      '~~~',
      '### *Italic* and ~~Strike~~',
      '#### Level 4',
      '##### Level 5',
      '###### Level 6',
    ].join('\n');

    const headings = extractFloatingTocHeadings(md);
    expect(headings.map(({ level, text, occurrence }) => ({ level, text, occurrence }))).toEqual([
      { level: 1, text: 'Title with code', occurrence: 0 },
      { level: 2, text: 'Link Heading', occurrence: 0 },
      { level: 3, text: 'Italic and Strike', occurrence: 0 },
      { level: 4, text: 'Level 4', occurrence: 0 },
      { level: 5, text: 'Level 5', occurrence: 0 },
      { level: 6, text: 'Level 6', occurrence: 0 },
    ]);
  });

  it('tracks 0-based occurrence for duplicate headings at the same level', () => {
    const md = [
      '# Overview',
      '## Details',
      '## Details',
      '### Details',
      '##  DETAILS ',
    ].join('\n');

    const headings = extractFloatingTocHeadings(md);
    expect(headings.map(({ level, text, occurrence }) => ({ level, text, occurrence }))).toEqual([
      { level: 1, text: 'Overview', occurrence: 0 },
      { level: 2, text: 'Details', occurrence: 0 },
      { level: 2, text: 'Details', occurrence: 1 },
      { level: 3, text: 'Details', occurrence: 0 },
      { level: 2, text: 'DETAILS', occurrence: 2 },
    ]);
  });
});

describe('NoteFloatingToc', () => {
  const sampleMarkdown = [
    '# Introduction',
    'Intro text',
    '## Key Concepts',
    'Concept details',
    '### Deep Dive',
    'More details',
    '## Key Concepts',
    'Second occurrence',
  ].join('\n');

  it('does not render when fewer than 2 headings exist or when hidden is true', () => {
    const onNavigate = vi.fn();

    const { rerender, container } = render(
      <NoteFloatingToc
        noteId="note-1"
        markdown="# Only One Heading"
        onNavigateHeading={onNavigate}
      />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <NoteFloatingToc
        noteId="note-1"
        markdown={sampleMarkdown}
        hidden
        onNavigateHeading={onNavigate}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders collapsed rail ticks and popover heading items when >= 2 headings exist', () => {
    const { container } = render(
      <NoteFloatingToc
        noteId="note-1"
        markdown={sampleMarkdown}
        onNavigateHeading={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: '目录' })).toBeInTheDocument();

    const ticks = container.querySelectorAll('.notes-floating-toc-tick');
    expect(ticks).toHaveLength(4);
    expect(Array.from(ticks).map((el) => el.getAttribute('data-level'))).toEqual(['1', '2', '3', '2']);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Introduction',
      'Key Concepts',
      'Deep Dive',
      'Key Concepts',
    ]);
  });

  it('highlights the active heading from NOTES_ACTIVE_HEADING_EVENT filtered by noteId and occurrence', () => {
    const { container, rerender } = render(
      <NoteFloatingToc
        noteId="note-a"
        markdown={sampleMarkdown}
        onNavigateHeading={vi.fn()}
      />,
    );

    // Event for another note is ignored
    act(() => {
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
        noteId: 'note-b',
        text: 'deep dive',
        level: 3,
        occurrence: 0,
      } satisfies NotesActiveHeadingDetail);
    });
    expect(container.querySelector('[data-active="true"]')).toBeNull();

    // Event for second occurrence of "Key Concepts"
    act(() => {
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
        noteId: 'note-a',
        text: 'key concepts',
        level: 2,
        occurrence: 1,
      } satisfies NotesActiveHeadingDetail);
    });

    const buttons = screen.getAllByRole('button');
    expect(buttons[1]).not.toHaveAttribute('aria-current');
    expect(buttons[3]).toHaveAttribute('aria-current', 'location');
    expect(buttons[3]).toHaveAttribute('data-active', 'true');

    const ticks = container.querySelectorAll('.notes-floating-toc-tick');
    expect(ticks[3]).toHaveAttribute('data-active', 'true');

    // Switching noteId resets active highlight
    rerender(
      <NoteFloatingToc
        noteId="note-c"
        markdown={sampleMarkdown}
        onNavigateHeading={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-active="true"]')).toBeNull();
  });

  it('invokes onNavigateHeading on click and Enter while respecting IME composition', () => {
    const onNavigate = vi.fn();
    render(
      <NoteFloatingToc
        noteId="note-1"
        markdown={sampleMarkdown}
        onNavigateHeading={onNavigate}
      />,
    );

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[3]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith({
      text: 'Key Concepts',
      level: 2,
      occurrence: 1,
    });
    expect(buttons[3]).toHaveAttribute('aria-current', 'location');

    // IME composing Enter should be ignored
    fireEvent.keyDown(buttons[2], { key: 'Enter', isComposing: true });
    fireEvent.keyDown(buttons[2], { key: 'Enter', keyCode: 229 });
    expect(onNavigate).toHaveBeenCalledTimes(1);

    // Non-composing Enter navigates cleanly
    fireEvent.keyDown(buttons[2], { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith({
      text: 'Deep Dive',
      level: 3,
      occurrence: 0,
    });
  });

  it('blurs active item on Escape key', () => {
    render(
      <NoteFloatingToc
        noteId="note-1"
        markdown={sampleMarkdown}
        onNavigateHeading={vi.fn()}
      />,
    );

    const firstButton = screen.getAllByRole('button')[0];
    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    fireEvent.keyDown(firstButton, { key: 'Escape' });
    expect(document.activeElement).not.toBe(firstButton);
  });

  it('enforces responsive hiding, tick widths, token shadows, and reduced-motion in CSS', () => {
    expect(tocCss).toContain('@container notes-shell (max-width: 860px)');
    expect(tocCss).toContain('max-height: 55vh;');
    expect(tocCss).toMatch(/@media \((?:max-width:\s*1023px|width <= 1023px)\), \(pointer: coarse\)/);
    expect(tocCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tocCss).toContain('width: 18px;');
    expect(tocCss).toContain('width: 13px;');
    expect(tocCss).toContain('width: 9px;');
    expect(tocCss).toContain('var(--notes-radius-popup');
    expect(tocCss).toContain('var(--notes-popover-shadow');
    expect(tocCss).not.toMatch(/box-shadow[^;]*--foreground/);
    expect(tocCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('keeps heading IDs stable and preserves active highlight when lines are inserted above', () => {
    const { rerender } = render(
      <NoteFloatingToc
        noteId="note-stable"
        markdown={'# Intro\n\n## Target Section\nBody'}
        onNavigateHeading={vi.fn()}
      />,
    );

    act(() => {
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
        noteId: 'note-stable',
        text: 'target section',
        level: 2,
        occurrence: 0,
      } satisfies NotesActiveHeadingDetail);
    });

    expect(screen.getAllByRole('button')[1]).toHaveAttribute('aria-current', 'location');

    // Insert several blank lines and paragraphs above the heading
    rerender(
      <NoteFloatingToc
        noteId="note-stable"
        markdown={'# Intro\n\nAdded line 1\nAdded line 2\nAdded line 3\n\n## Target Section\nBody'}
        onNavigateHeading={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button')[1]).toHaveAttribute('aria-current', 'location');
  });

  it('caps rail ticks at 36 while preserving the active tick and keeping all items in the popover', () => {
    const manyHeadings = Array.from({ length: 60 }, (_, idx) => `## Section ${idx + 1}`).join('\n');
    const { container } = render(
      <NoteFloatingToc
        noteId="note-long"
        markdown={manyHeadings}
        onNavigateHeading={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.notes-floating-toc-tick')).toHaveLength(36);
    expect(screen.getAllByRole('button')).toHaveLength(60);

    // Highlight a heading that might not fall on an initial sample boundary
    act(() => {
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
        noteId: 'note-long',
        text: 'section 23',
        level: 2,
        occurrence: 0,
      } satisfies NotesActiveHeadingDetail);
    });

    expect(container.querySelectorAll('.notes-floating-toc-tick')).toHaveLength(36);
    expect(container.querySelectorAll('.notes-floating-toc-tick[data-active="true"]')).toHaveLength(1);
  });

  it('supports ArrowUp, ArrowDown, Home, and End keyboard navigation and only scrolls active button when visible', () => {
    const scrollSpy = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { container } = render(
        <NoteFloatingToc
          noteId="note-kb"
          markdown={sampleMarkdown}
          onNavigateHeading={vi.fn()}
        />,
      );

      // Not hovered or focused: active heading update must not call scrollIntoView
      act(() => {
        dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
          noteId: 'note-kb',
          text: 'deep dive',
          level: 3,
          occurrence: 0,
        } satisfies NotesActiveHeadingDetail);
      });
      expect(scrollSpy).not.toHaveBeenCalled();

      // Focusing inside nav makes popover visible and scrolls active button into view
      const buttons = screen.getAllByRole('button');
      act(() => {
        buttons[0].focus();
      });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(buttons[1]);

      fireEvent.keyDown(buttons[1], { key: 'End' });
      expect(document.activeElement).toBe(buttons[3]);

      fireEvent.keyDown(buttons[3], { key: 'ArrowUp' });
      expect(document.activeElement).toBe(buttons[2]);

      fireEvent.keyDown(buttons[2], { key: 'Home' });
      expect(document.activeElement).toBe(buttons[0]);

      // Hovering also keeps popover visible
      const nav = container.querySelector('nav')!;
      fireEvent.mouseEnter(nav);
      fireEvent.mouseLeave(nav);
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
