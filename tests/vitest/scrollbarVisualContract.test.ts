import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { getHtmlTheme, getHtmlThemeServerSnapshot } from '@/lib/scroll-theme';

const srcRoot = resolve(process.cwd(), 'src');
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
const nativeScrollbarSource = readFileSync(
  resolve(process.cwd(), 'src/styles/native-feel/scrollbars.css'),
  'utf-8',
);
const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
const scrollThemeSource = readFileSync(resolve(process.cwd(), 'src/lib/scroll-theme.ts'), 'utf-8');
const scrollAreaSource = readFileSync(resolve(srcRoot, 'components/ui/scroll-area.tsx'), 'utf-8');
const customScrollAreaSource = readFileSync(
  resolve(srcRoot, 'components/custom-scroll-area.tsx'),
  'utf-8',
);
const shadScrollAreaSource = readFileSync(
  resolve(srcRoot, 'components/ui/shad/ScrollArea.tsx'),
  'utf-8',
);
const scrollPlatformSource = readFileSync(resolve(srcRoot, 'lib/scroll-platform.ts'), 'utf-8');
const sharedAppCssSource = readFileSync(resolve(srcRoot, 'shared/styles/app.css'), 'utf-8');
const responsiveUtilitiesSource = readFileSync(
  resolve(srcRoot, 'styles/responsive-utilities.css'),
  'utf-8',
);
const slashMenuScrollbarSource = readFileSync(
  resolve(srcRoot, 'components/crepe/hooks/useSlashMenuCustomScrollbar.ts'),
  'utf-8',
);
const codeMirrorScrollbarSource = readFileSync(
  resolve(srcRoot, 'components/skills-management/CodeMirrorScrollOverlay.tsx'),
  'utf-8',
);
const skillsListSource = readFileSync(
  resolve(srcRoot, 'components/skills-management/SkillsManagementPage.tsx'),
  'utf-8',
);
const messageListSource = readFileSync(
  resolve(srcRoot, 'features/chat/components/MessageList.tsx'),
  'utf-8',
);
const notesTreeSource = readFileSync(
  resolve(srcRoot, 'features/notes/DndFileTree/DndFileTree.tsx'),
  'utf-8',
);
const notesSidebarSource = readFileSync(
  resolve(srcRoot, 'features/notes/NotesSidebarV2.tsx'),
  'utf-8',
);
const finderListSource = readFileSync(
  resolve(srcRoot, 'features/learning-hub/components/finder/FinderFileList.tsx'),
  'utf-8',
);
const pdfViewerSource = readFileSync(
  resolve(srcRoot, 'features/pdf/components/EnhancedPdfViewer.tsx'),
  'utf-8',
);
const todoMainSource = readFileSync(
  resolve(srcRoot, 'features/todo/components/TodoMainPanel.tsx'),
  'utf-8',
);
const todoRowsSource = readFileSync(
  resolve(srcRoot, 'features/todo/components/main/TodoRowsList.tsx'),
  'utf-8',
);
const batchToolbarSource = readFileSync(
  resolve(srcRoot, 'components/BatchOperationToolbar/index.tsx'),
  'utf-8',
);
const virtualQuestionListSource = readFileSync(
  resolve(srcRoot, 'components/VirtualQuestionList.tsx'),
  'utf-8',
);

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    return entry.isDirectory() ? collectSourceFiles(absolutePath) : absolutePath;
  });
}

const scrollbarSourceEntries = collectSourceFiles(srcRoot)
  .filter((file) => /\.(?:css|scss|ts|tsx)$/.test(file))
  .map((file) => ({
    file: relative(srcRoot, file).replaceAll('\\', '/'),
    source: readFileSync(file, 'utf-8'),
  }));

const editorScrollbarExemption =
  /(?:textarea|iframe|\.cm-|\.milkdown|\.prosemirror|settings-textarea-scrollbar)/i;
const editorOwnedScrollbarFiles = new Set([
  'components/NoTagTreeShadPanel.tsx',
  'components/essay-grading/InputPanel.tsx',
]);
const embeddedDocumentScrollbarExemptions = new Set([
  // CSS is serialized into an isolated HTML sandbox document.
  'components/previews/htmlSandboxPolicy.ts',
  // CSS is serialized into the isolated EPUB reader document, not the app shell.
  'features/learning-hub/apps/views/epubReaderModel.ts',
]);

function findPrivateVisibleScrollbarRecipes(): string[] {
  const violations = new Set<string>();

  for (const { file, source } of scrollbarSourceEntries) {
    if (
      file === 'styles/native-feel/scrollbars.css' ||
      embeddedDocumentScrollbarExemptions.has(file)
    ) {
      continue;
    }

    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].replace(/\s+/g, ' ').trim();
      const body = match[2];
      const isCanonicalNativeFallback = selector.includes('.scroll-area--native');
      const isEditorOwned =
        editorOwnedScrollbarFiles.has(file) ||
        editorScrollbarExemption.test(`${file} ${selector}`);
      if (isCanonicalNativeFallback || isEditorOwned) continue;

      const hasVisibleWebkitRecipe =
        selector.includes('::-webkit-scrollbar') &&
        !/\bdisplay\s*:\s*none\b/.test(body) &&
        (/(?:^|;)\s*(?:width|height)\s*:\s*(?!0(?:px|rem|em|%)?\b)[^;]+/m.test(body) ||
          /background(?:-color)?\s*:\s*(?!transparent\b|none\b)[^;]+/.test(body));
      const hasPrivateFirefoxRecipe =
        /\bscrollbar-width\s*:\s*thin\b/.test(body) ||
        /\bscrollbar-color\s*:\s*(?!transparent\s+transparent\b|auto\b)[^;]+/.test(body);

      if (hasVisibleWebkitRecipe || hasPrivateFirefoxRecipe) {
        violations.add(`${file}: ${selector.slice(0, 140)}`);
      }
    }
  }

  return [...violations].sort();
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('scrollbar visual contract', () => {
  it('uses one project theme class whose semantic tokens follow light and dark surfaces', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(getHtmlTheme()).toBe('os-theme-deep-student');

    document.documentElement.dataset.theme = 'light';
    expect(getHtmlTheme()).toBe('os-theme-deep-student');
    expect(getHtmlThemeServerSnapshot()).toBe('os-theme-deep-student');
    expect(scrollThemeSource).toContain(
      'SCROLLBAR_THEME_CLASS = "os-theme-deep-student"',
    );
  });

  it('loads the library baseline before project scrollbar overrides', () => {
    const libraryImport = appSource.indexOf("import 'overlayscrollbars/overlayscrollbars.css';");
    const projectStylesImport = appSource.indexOf("import './styles/tailwind.css';");

    expect(libraryImport).toBeGreaterThanOrEqual(0);
    expect(projectStylesImport).toBeGreaterThan(libraryImport);
  });

  it('defines distinct default, hover, and active colors for both themes', () => {
    expect(themeSource).toContain('--scrollbar-thumb-active:');
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb:/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb-hover:/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb-active:/);
  });

  it('keeps a generous hit area with a restrained four-pixel visual thumb', () => {
    expect(themeSource).toContain('--scrollbar-interaction-size: 10px;');
    expect(themeSource).toContain('--scrollbar-thumb-inset: 3px;');
    expect(nativeScrollbarSource).toContain('width: var(--scrollbar-interaction-size);');
    expect(nativeScrollbarSource).toContain('height: var(--scrollbar-interaction-size);');
    expect(nativeScrollbarSource).toContain(
      'border: var(--scrollbar-thumb-inset) solid transparent;',
    );
    expect(nativeScrollbarSource).toContain('--os-size: var(--scrollbar-interaction-size);');
    expect(nativeScrollbarSource).toContain(
      '--os-padding-perpendicular: var(--scrollbar-thumb-inset);',
    );
    expect(nativeScrollbarSource).toContain('background-color: var(--scrollbar-thumb-active);');
  });

  it('bridges OverlayScrollbars states to project tokens and supports touch-only devices', () => {
    expect(nativeScrollbarSource).toMatch(
      /\.os-theme-deep-student\s*\{[\s\S]*--os-handle-bg:\s*var\(--scrollbar-thumb\);/,
    );
    expect(nativeScrollbarSource).toContain('--os-handle-bg-active: var(--scrollbar-thumb-active);');
    expect(nativeScrollbarSource).toContain('--os-track-bg-hover: var(--scrollbar-track);');
    expect(nativeScrollbarSource).toContain('--os-track-bg-active: var(--scrollbar-track);');
    expect(themeSource).toContain('--scrollbar-track: transparent;');
    expect(themeSource).not.toContain('--os-handle-bg:');
    expect(nativeScrollbarSource).toContain('@media (hover: none) and (pointer: coarse)');
    expect(nativeScrollbarSource).toMatch(
      /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*background-color:\s*var\(--scrollbar-thumb\)/,
    );
  });
});

describe('unified scroll primitive contract', () => {
  it('uses the skills-list OverlayScrollbars primitive on desktop', () => {
    expect(skillsListSource).toMatch(
      /<CustomScrollArea[\s\S]{0,160}className="flex-1 min-h-0"[\s\S]{0,160}viewportRef=\{listViewportRef\}/,
    );
    expect(customScrollAreaSource).toContain('import { ScrollArea } from "./ui/scroll-area";');
    expect(scrollAreaSource).toContain('useOverlayScrollbars');
    expect(scrollAreaSource).toContain('elements: { viewport }');
    expect(scrollAreaSource).toContain('ref={setOverlayViewportRef}');
    expect(scrollAreaSource).toContain('theme,');
    expect(scrollAreaSource).toContain('dragScroll: true');
    expect(scrollAreaSource).toContain('clickScroll: true');
    expect(scrollAreaSource).toContain('flowDirectionStyles: (viewport) =>');
    expect(scrollAreaSource).toContain('direction === "rtl" ? { direction } : {}');
    expect(scrollAreaSource).toContain('refreshScrollTimelineHandleGeometry');
    expect(scrollAreaSource).toContain('effect.setKeyframes(effect.getKeyframes())');
    expect(nativeScrollbarSource).toContain('var(--scroll-area-track-top)');
    expect(nativeScrollbarSource).toContain('var(--scroll-area-track-bottom)');
    expect(responsiveUtilitiesSource).toContain("[data-overlayscrollbars~='host']");
    expect(responsiveUtilitiesSource).toContain('[data-overlayscrollbars-viewport]');
    expect(responsiveUtilitiesSource).not.toContain('.os-viewport');
    expect(slashMenuScrollbarSource).toContain('contentObserver.observe(menuGroups');
    expect(slashMenuScrollbarSource).toContain('Math.min(rawOffset, maxOffset)');
    expect(slashMenuScrollbarSource).toContain('wheelTarget = Math.max(0, Math.min(wheelTarget, maxScrollTop))');
    expect(codeMirrorScrollbarSource).toContain('let scrollFrame = 0');
    expect(codeMirrorScrollbarSource).toContain('let metricsFrame = 0');
    expect(codeMirrorScrollbarSource).toContain('if (isDraggingRef.current) return');
  });

  it('keeps iOS on the native momentum-scrolling fallback', () => {
    expect(scrollPlatformSource).toContain('preferNativeScrollbars: isIOS');
    expect(scrollAreaSource).toContain(
      'const useNative = nativeScrollbars ?? platform.preferNativeScrollbars;',
    );
    expect(scrollAreaSource).toContain('data-native-scrollbars="true"');
    expect(scrollAreaSource).toContain('SCROLL_AREA_NATIVE_CLASS');
    expect(nativeScrollbarSource).toContain('.scroll-area--native {');
    expect(nativeScrollbarSource).toContain('-webkit-overflow-scrolling: touch;');
  });

  it('uses scrolling, not hover, to reveal OverlayScrollbars on touch', () => {
    expect(scrollAreaSource).toContain(
      'scrollAutoHide ?? (platform.isTouchPrimary ? "scroll" : "leave")',
    );
  });

  it('keeps wrapper props and flex height constraints aligned', () => {
    expect(scrollAreaSource).toContain('"relative min-h-0 min-w-0"');
    expect(customScrollAreaSource).toContain(
      '"h-full min-h-0 w-full min-w-0"',
    );
    expect(customScrollAreaSource).toContain('nativeScrollbars={nativeScrollbars}');
    expect(shadScrollAreaSource).toContain('viewportRef={viewportRef}');
    expect(shadScrollAreaSource).toContain('scrollAutoHide={scrollAutoHide}');
    expect(shadScrollAreaSource).toContain('nativeScrollbars={nativeScrollbars}');
  });
});

describe('repository-wide scrollbar integration contract', () => {
  it('has one canonical scrollbar-none utility and no legacy aliases', () => {
    const definitions = scrollbarSourceEntries
      .filter(({ source }) => /\.scrollbar-none\s*\{/.test(source))
      .map(({ file }) => file);
    const legacyAliases = scrollbarSourceEntries
      .filter(({ source }) => /\.scroll(?:-hidden|bar-hide)\b/.test(source))
      .map(({ file }) => file);

    expect(definitions).toEqual(['shared/styles/scrollbar-utils.css']);
    expect(legacyAliases).toEqual([]);
    expect(
      scrollbarSourceEntries.find(({ file }) => file === 'shared/styles/scrollbar-utils.css')?.source,
    ).toContain('.scrollbar-none .os-scrollbar {');
  });

  it('does not introduce feature-private visible scrollbar recipes', () => {
    expect(findPrivateVisibleScrollbarRecipes()).toEqual([]);
  });

  it('does not let chat depend on the mindmap custom-scrollbar selector', () => {
    const chatCustomScrollbarUses = scrollbarSourceEntries
      .filter(
        ({ file, source }) =>
          file.startsWith('features/chat/') && /\bcustom-scrollbar\b/.test(source),
      )
      .map(({ file }) => file);

    expect(chatCustomScrollbarUses).toEqual([]);
  });

  it('binds virtual lists to the real OverlayScrollbars viewport', () => {
    expect(messageListSource).toContain('viewportRef={viewportCallbackRef}');
    expect(messageListSource).toContain('getScrollElement: () => viewportElement');

    expect(notesSidebarSource).toContain('viewportRef={searchListRef}');
    expect(notesSidebarSource).toContain('viewportRef={treeViewportRef}');
    expect(notesTreeSource).toContain('getScrollElement: () => scrollViewportRef.current');
    expect(notesTreeSource).not.toContain('getScrollElement: () => treeRef.current');

    expect(finderListSource).toContain('viewportRef={viewportRef}');
    expect(finderListSource).toContain('getScrollElement: () => viewportRef.current');

    expect(pdfViewerSource).toContain('viewportRef={pageContainerRef}');
    expect(pdfViewerSource).toContain('viewportRef={thumbnailsContainerRef}');
    expect(pdfViewerSource).toContain('getScrollElement: () => pageContainerRef.current');
    expect(pdfViewerSource).toContain('getScrollElement: () => thumbnailsContainerRef.current');

    expect(todoMainSource).toContain('viewportRef={setScrollViewport}');
    expect(todoRowsSource).toContain('getScrollElement: () => scrollElement');

    expect(batchToolbarSource).toContain('viewportRef={listContainerRef}');
    expect(batchToolbarSource).toContain('getScrollElement: () => listContainerRef.current');

    expect(virtualQuestionListSource).toContain('ref={parentRef}');
    expect(virtualQuestionListSource).toContain('getScrollElement: () => parentRef.current');
    expect(virtualQuestionListSource).toContain("cn('overflow-auto', className)");
  });

  it('keeps flex scroll hosts shrinkable and print content unclipped', () => {
    expect(skillsListSource).toContain('className="flex-1 min-h-0"');
    expect(messageListSource).toContain('className="min-h-0 flex-1"');
    expect(sharedAppCssSource).toMatch(
      /@media print\s*\{[\s\S]*\[data-overlayscrollbars-viewport\][\s\S]*overflow:\s*visible !important;[\s\S]*max-height:\s*none !important;/,
    );
    expect(sharedAppCssSource).toMatch(
      /@media print\s*\{[\s\S]*\.os-scrollbar[\s\S]*display:\s*none !important;/,
    );
    expect(sharedAppCssSource).toMatch(
      /@media print\s*\{[\s\S]*\.scroll-area--native[\s\S]*overflow:\s*visible !important;/,
    );
  });
});
