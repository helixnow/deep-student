import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ArrowLeft, CaretDown, CaretUp, FileText, ListChecks } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { GroupTitle } from './settingsTabPrimitives';


const ACKNOWLEDGEMENT_GROUPS = [
  {
    key: 'runtimesAndFrameworks',
    items: ['Electron', 'Chromium', 'Node.js', 'Capacitor', 'Cordis', 'React 18', 'TypeScript 5', 'Vite 6'],
  },
  {
    key: 'backendAndStorage',
    items: [
      'better-sqlite3', 'SQLite WASM', 'LanceDB', 'Apache Arrow',
      'Koffi', 'esbuild', 'undici', 'AWS SDK S3',
      'Argon2', 'Keyring', 'Noble Crypto', 'tiktoken', 'Sentry', 'Ajv',
    ],
  },
  {
    key: 'f7WasiEngines',
    items: [
      'Starlark', 'Symphonia', 'fsrs-rs', 'image-rs',
      'regex', 'roxmltree', 'docx-rs', 'Calamine',
      'pptx-to-md', 'rtf-parser', 'html2text', 'priority-queue',
    ],
  },
  {
    key: 'documentsAndArchives',
    items: [
      'PDF.js', 'PDFium', 'OpenJPEG & qcms', 'pdf-lib', 'pdfmake',
      'docx', 'docx-preview', 'ExcelJS', 'pptxgenjs', 'pptx-preview',
      'JSZip', 'pako', 'tar', 'DOMPurify',
    ],
  },
  {
    key: 'editorsAndScience',
    items: [
      'Milkdown', 'ProseMirror', 'CodeMirror', 'KaTeX', 'FlowToken',
      'Mermaid', 'Apache ECharts', 'Vega / Vega-Lite', 'Recharts',
      'React Flow', 'Cytoscape.js', 'Graphviz', 'D3',
      '3Dmol.js', 'abcjs', 'OpenChemLib', 'SmilesDrawer', 'WaveDrom',
    ],
  },
  {
    key: 'uiAndInteraction',
    items: [
      'Tailwind CSS', 'Radix UI', 'Framer Motion', 'Phosphor Icons',
      'LobeHub Icons', 'DnD Kit', 'OverlayScrollbars',
      'TanStack Virtual', 'React Resizable Panels',
    ],
  },
  {
    key: 'stateAndLearning',
    items: [
      'Zustand', 'Immer', 'Zod', 'ts-fsrs', 'i18next',
      'react-i18next', 'date-fns', 'MCP SDK', 'YAML', 'diff',
    ],
  },
  {
    key: 'fontsAndAssets',
    items: [
      'Noto Sans SC (OFL-1.1)', 'Liberation Sans (OFL-1.1)',
      'Foxit Standard Fonts', 'Study OS Wallpapers (CC0)',
      'AI Provider Brand Icons',
    ],
  },
] as const;

type LegalDocument = 'project' | 'thirdParty';

const LEGAL_DOCUMENT_PATHS: Record<LegalDocument, string> = {
  project: './legal/DEEPSTUDENT_LICENSE.txt',
  thirdParty: './legal/THIRD_PARTY_NOTICES.txt',
};

/** Electron packaged extraResources paths (`BaseDirectory.Resource = 11`). */
const DESKTOP_RESOURCE_PATHS: Record<LegalDocument, string> = {
  project: 'licenses/DeepStudent-AGPL-3.0.txt',
  thirdParty: 'licenses/THIRD_PARTY_NOTICES.txt',
};
const RESOURCE_BASE_DIR = 11;

interface DesktopShellInternals {
  invoke?: (cmd: string, payload?: unknown) => Promise<unknown>;
}

const getDesktopInvoke = (): DesktopShellInternals['invoke'] | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as { __TAURI_INTERNALS__?: DesktopShellInternals }).__TAURI_INTERNALS__?.invoke;
};

const decodeDesktopTextPayload = (payload: unknown): string => {
  if (typeof payload === 'string') return payload;
  if (payload instanceof ArrayBuffer || Object.prototype.toString.call(payload) === '[object ArrayBuffer]') {
    return new TextDecoder().decode(new Uint8Array(payload as ArrayBuffer));
  }
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  }
  if (Array.isArray(payload)) return new TextDecoder().decode(Uint8Array.from(payload));
  throw new Error('Unexpected desktop legal document payload');
};

/**
 * Electron 桌面端打包后 `THIRD_PARTY_NOTICES.txt` 随 `extraResources` 放在 `resources/licenses/`，
 * 优先经桌面壳 IPC 读取；开发模式、Web 与 Mobile 端统一走 `fetch('./legal/...')`。
 */
export const loadLegalDocumentText = async (document: LegalDocument): Promise<string> => {
  const desktopInvoke = getDesktopInvoke();
  if (desktopInvoke) {
    try {
      const payload = await desktopInvoke('plugin:fs|read_text_file', {
        path: DESKTOP_RESOURCE_PATHS[document],
        options: { baseDir: RESOURCE_BASE_DIR },
      });
      return decodeDesktopTextPayload(payload);
    } catch {
      // 开发环境下 resources/licenses/ 尚未打包时回退到 Vite/Web/Mobile 静态资源 fetch
    }
  }
  const response = await fetch(LEGAL_DOCUMENT_PATHS[document]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

export const OpenSourceAcknowledgementsSection: React.FC = () => {
  const { t } = useTranslation('settings');
  // P1-9 移动端契约：致谢长列表 / 许可证长文本不走 Dialog，改为 About 页内联展开
  const { isSmallScreen } = useBreakpoint();
  const [open, setOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const [legalText, setLegalText] = useState('');
  const [legalLoading, setLegalLoading] = useState(false);
  const [legalError, setLegalError] = useState(false);

  const openLegalDocument = async (document: LegalDocument) => {
    setLegalDocument(document);
    setLegalText('');
    setLegalError(false);
    setLegalLoading(true);
    try {
      setLegalText(await loadLegalDocumentText(document));
    } catch {
      setLegalError(true);
    } finally {
      setLegalLoading(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setLegalDocument(null);
      setLegalText('');
      setLegalError(false);
    }
  };

  // 移动端内联许可证正文的系统返回键：先回到致谢列表，而不是退出整个 About 分区。
  // 必须注册 overlay 档——移动端设置本体是打开的 Radix Sheet（role="dialog"
  // data-state="open"），androidBackCoordinator 的 Radix Escape 兜底在任何低于
  // overlay 档的 handler 之前执行并会命中该 Sheet，view 档在这里拿不到事件。
  // overlay 档栈语义（后注册先执行）下，正文之上再打开的弹层仍先于本 handler 关闭。
  // 仅在正文可见时注册；关闭正文或组件随 AboutTab 卸载（切分区 / 回分区列表 /
  // Sheet 关闭）即注销，不会误吞其他页面的返回键。
  useEffect(() => {
    if (!isSmallScreen || !open || !legalDocument) return;
    return registerBackHandler(() => {
      setLegalDocument(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, open, legalDocument]);

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.02,
      },
    },
  };

  const itemAnim = {
    hidden: { opacity: 0, y: 4 },
    show: { opacity: 1, y: 0, transition: { duration: 0.16, ease: 'easeOut' as const } },
  };

  // 致谢分组正文（桌面 Dialog / 移动内联展开共用）；移动端单列避免挤压
  const acknowledgementsBody = (
    <div className={isSmallScreen ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 gap-3 md:grid-cols-2'}>
      {ACKNOWLEDGEMENT_GROUPS.map((group) => (
        <section
          key={group.key}
          className="rounded-lg border border-border/45 bg-muted/15 p-3.5"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="flex min-w-0 items-center gap-2 text-ui font-medium text-foreground/90">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
              <span className="truncate">{t(`acknowledgements.openSource.categories.${group.key}`)}</span>
            </h4>
          </div>
          <motion.div
            role="list"
            variants={container}
            initial="hidden"
            animate="show"
            className="flex flex-wrap gap-1.5"
          >
            {group.items.map((item) => (
              <motion.span
                role="listitem"
                variants={itemAnim}
                key={item}
                className="
                  inline-block cursor-default select-none rounded-md
                  border border-border/45 bg-background/70 px-2.5 py-1
                  text-[11.5px] font-medium text-foreground/70 shadow-sm
                  transition-colors duration-150
                "
              >
                {item}
              </motion.span>
            ))}
          </motion.div>
        </section>
      ))}
    </div>
  );

  // 许可证长文本正文（桌面 Dialog / 移动内联展开共用）
  const legalBody = (
    <div className="min-h-[200px]">
      {legalLoading && (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-muted-foreground">
          {t('acknowledgements.openSource.loadingLicenses')}
        </div>
      )}
      {legalError && (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-destructive">
          {t('acknowledgements.openSource.licenseLoadError')}
        </div>
      )}
      {!legalLoading && !legalError && (
        <pre className="select-text whitespace-pre-wrap break-words rounded-md border border-border/45 bg-muted/15 p-4 text-xs leading-5 text-foreground/80">
          {legalText}
        </pre>
      )}
    </div>
  );

  const legalEntryButtons = (
    <>
      <DsButton
        variant="outline"
        size="sm"
        className="flex-1 [@media(pointer:coarse)]:!min-h-11"
        onClick={() => void openLegalDocument('project')}
      >
        <FileText size={14} />
        {t('acknowledgements.openSource.projectLicense')}
      </DsButton>
      <DsButton
        variant="outline"
        size="sm"
        className="flex-1 [@media(pointer:coarse)]:!min-h-11"
        onClick={() => void openLegalDocument('thirdParty')}
      >
        <ListChecks size={14} />
        {t('acknowledgements.openSource.thirdPartyLicense')}
      </DsButton>
    </>
  );

  return (
    <>
      <GroupTitle
        title={t('acknowledgements.openSource.title')}
        description={t('acknowledgements.openSource.description')}
        actions={
          <DsButton
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(!open)}
            aria-label={t('acknowledgements.openSource.openDialog')}
            aria-expanded={isSmallScreen ? open : undefined}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            <span>{t('acknowledgements.openSource.openDialog')}</span>
            {isSmallScreen ? (
              open ? <CaretUp size={14} /> : <CaretDown size={14} />
            ) : (
              <ListChecks size={14} />
            )}
          </DsButton>
        }
      />

      {/* 移动端：About 页内联展开（P1-9）；桌面端保留 Dialog */}
      {isSmallScreen ? (
        open && (
          <div className="desktop-shell-content-enter mb-4 space-y-3 rounded-2xl bg-muted p-3">
            {legalDocument ? (
              <>
                <div className="space-y-1 px-1">
                  <h4 className="text-sm font-semibold text-foreground">
                    {t(`acknowledgements.openSource.${legalDocument}License`)}
                  </h4>
                  <p className="text-xs text-muted-foreground/70">
                    {t(`acknowledgements.openSource.${legalDocument}LicenseDescription`)}
                  </p>
                </div>
                {legalBody}
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => setLegalDocument(null)}
                >
                  <ArrowLeft size={14} />
                  {t('acknowledgements.openSource.backToAcknowledgements')}
                </DsButton>
              </>
            ) : (
              <>
                {acknowledgementsBody}
                <div className="flex flex-col gap-2">
                  {legalEntryButtons}
                </div>
              </>
            )}
          </div>
        )
      ) : (
        <DsDialog open={open} onOpenChange={handleOpenChange} maxWidth="max-w-[760px]">
          <DsDialogHeader>
            <div className="min-w-0 pr-8">
              <DsDialogTitle>
                {legalDocument
                  ? t(`acknowledgements.openSource.${legalDocument}License`)
                  : t('acknowledgements.openSource.title')}
              </DsDialogTitle>
              <DsDialogDescription>
                {legalDocument
                  ? t(`acknowledgements.openSource.${legalDocument}LicenseDescription`)
                  : t('acknowledgements.openSource.description')}
              </DsDialogDescription>
            </div>
          </DsDialogHeader>

          <DsDialogBody overlayScroll className="py-4">
            {legalDocument ? legalBody : acknowledgementsBody}
          </DsDialogBody>

          <DsDialogFooter>
            {legalDocument ? (
              <div className="flex w-full gap-2">
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="flex-1 justify-center [@media(pointer:coarse)]:!min-h-11"
                  onClick={() => setLegalDocument(null)}
                >
                  <ArrowLeft size={14} />
                  {t('acknowledgements.openSource.backToAcknowledgements')}
                </DsButton>
                <DsButton
                  variant="outline"
                  size="sm"
                  className="flex-1 justify-center [@media(pointer:coarse)]:!min-h-11"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('acknowledgements.openSource.closeDialog')}
                </DsButton>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                {legalEntryButtons}
                <DsButton
                  variant="outline"
                  size="sm"
                  className="flex-1 justify-center [@media(pointer:coarse)]:!min-h-11"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('acknowledgements.openSource.closeDialog')}
                </DsButton>
              </div>
            )}
          </DsDialogFooter>
        </DsDialog>
      )}
    </>
  );
};
