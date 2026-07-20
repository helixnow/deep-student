import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ArrowLeft, CaretDown, CaretUp, FileText, ListChecks } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  NotionDialog,
  NotionDialogBody,
  NotionDialogDescription,
  NotionDialogFooter,
  NotionDialogHeader,
  NotionDialogTitle,
} from '@/components/ui/NotionDialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

const ACKNOWLEDGEMENT_GROUPS = [
  {
    key: 'coreStack',
    items: ['React 18', 'TypeScript 5', 'Vite 6', 'Tailwind CSS', 'PostCSS', 'Vite React Plugin'],
  },
  {
    key: 'uiAndInteraction',
    items: [
      'Radix UI', 'Framer Motion', 'Lucide React', 'Phosphor Icons',
      'cmdk', 'React Complex Tree', 'React Resizable Panels',
    ],
  },
  {
    key: 'contentEditing',
    items: [
      'Milkdown', 'CodeMirror', 'ProseMirror', 'Mermaid', 'KaTeX',
      'React Markdown', 'React PDF', 'PDF.js', 'docx-preview',
      'pptx-preview', 'ExcelJS',
    ],
  },
  {
    key: 'stateAndData',
    items: [
      'Zustand', 'Immer', 'i18next', 'react-i18next',
      'i18next Browser LanguageDetector', 'date-fns', 'nanoid',
      'uuid', 'YAML', 'diff', 'DOMPurify',
    ],
  },
  {
    key: 'visualization',
    items: ['DnD Kit', 'Hello Pangea DnD', 'React Flow', 'Recharts', 'React Heat Map'],
  },
  {
    key: 'utilities',
    items: [
      'Class Variance Authority', 'Tailwind Merge', 'Mustache',
      'heic2any', 'React Textarea Autosize', 'SnapDOM',
    ],
  },
  {
    key: 'aiAndAgents',
    items: [
      'MCP SDK', 'LanceDB', 'Apache Arrow', 'tiktoken-rs',
      'EventSource Stream', 'Reqwest EventSource',
    ],
  },
  {
    key: 'rustEcosystem',
    items: [
      'Tauri 2', 'Tauri Plugin Suite', 'Tokio', 'Serde', 'Rusqlite',
      'Reqwest', 'Rayon', 'Moka', 'Chrono', 'docx-rs',
      'pdfium-render', 'Calamine', 'ppt-rs', 'pptx-to-md',
      'Umya Spreadsheet', 'encoding_rs', 'anyhow', 'tracing', 'Sentry',
    ],
  },
  {
    key: 'testingAndTooling',
    items: ['Vitest', 'Playwright', 'Testing Library', 'ESLint', 'JSDOM', 'Vite Static Copy'],
  },
] as const;

type LegalDocument = 'project' | 'thirdParty';

const LEGAL_DOCUMENT_PATHS: Record<LegalDocument, string> = {
  project: './legal/DEEPSTUDENT_LICENSE.txt',
  thirdParty: './legal/THIRD_PARTY_NOTICES.txt',
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
      const response = await fetch(LEGAL_DOCUMENT_PATHS[document]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setLegalText(await response.text());
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
            <h4 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground/90">
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
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/45 bg-muted/15 p-4 text-[11px] leading-5 text-foreground/80 select-text">
          {legalText}
        </pre>
      )}
    </div>
  );

  const legalEntryButtons = (
    <>
      <NotionButton
        variant="ghost"
        size="sm"
        className="flex-1 justify-center"
        onClick={() => void openLegalDocument('project')}
      >
        <FileText size={14} />
        {t('acknowledgements.openSource.projectLicense')}
      </NotionButton>
      <NotionButton
        variant="ghost"
        size="sm"
        className="flex-1 justify-center"
        onClick={() => void openLegalDocument('thirdParty')}
      >
        <ListChecks size={14} />
        {t('acknowledgements.openSource.thirdPartyLicense')}
      </NotionButton>
    </>
  );

  return (
    <>
      <div className="flex flex-col mb-4">
        <div className="flex items-start justify-between gap-3">
          <GroupTitle title={t('acknowledgements.openSource.title')} />
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(!open)}
            aria-label={t('acknowledgements.openSource.openDialog')}
            aria-expanded={isSmallScreen ? open : undefined}
            className="mr-1 h-7 gap-1.5 px-2 text-xs text-muted-foreground/85"
          >
            <span>{t('acknowledgements.openSource.openDialog')}</span>
            {isSmallScreen ? (
              open ? <CaretUp size={14} /> : <CaretDown size={14} />
            ) : (
              <ListChecks size={14} />
            )}
          </NotionButton>
        </div>
        <p className="mt-2 mb-1 px-1 text-[12.5px] leading-relaxed text-muted-foreground/70">
          {t('acknowledgements.openSource.description')}
        </p>
      </div>

      {/* 移动端：About 页内联展开（P1-9）；桌面端保留 Dialog */}
      {isSmallScreen ? (
        open && (
          <div className="desktop-shell-content-enter mb-4 space-y-3 rounded-2xl border border-border/40 bg-background p-3">
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
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="w-full min-h-11 justify-center"
                  onClick={() => setLegalDocument(null)}
                >
                  <ArrowLeft size={14} />
                  {t('acknowledgements.openSource.backToAcknowledgements')}
                </NotionButton>
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
        <NotionDialog open={open} onOpenChange={handleOpenChange} maxWidth="max-w-[760px]">
          <NotionDialogHeader>
            <div className="min-w-0 pr-8">
              <NotionDialogTitle>
                {legalDocument
                  ? t(`acknowledgements.openSource.${legalDocument}License`)
                  : t('acknowledgements.openSource.title')}
              </NotionDialogTitle>
              <NotionDialogDescription>
                {legalDocument
                  ? t(`acknowledgements.openSource.${legalDocument}LicenseDescription`)
                  : t('acknowledgements.openSource.description')}
              </NotionDialogDescription>
            </div>
          </NotionDialogHeader>

          <NotionDialogBody className="py-4">
            {legalDocument ? legalBody : acknowledgementsBody}
          </NotionDialogBody>

          <NotionDialogFooter>
            {legalDocument ? (
              <div className="flex w-full gap-2">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="flex-1 justify-center"
                  onClick={() => setLegalDocument(null)}
                >
                  <ArrowLeft size={14} />
                  {t('acknowledgements.openSource.backToAcknowledgements')}
                </NotionButton>
                <NotionButton
                  variant="default"
                  size="sm"
                  className="flex-1 justify-center"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('acknowledgements.openSource.closeDialog')}
                </NotionButton>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                {legalEntryButtons}
                <NotionButton
                  variant="default"
                  size="sm"
                  className="flex-1 justify-center"
                  onClick={() => handleOpenChange(false)}
                >
                  {t('acknowledgements.openSource.closeDialog')}
                </NotionButton>
              </div>
            )}
          </NotionDialogFooter>
        </NotionDialog>
      )}
    </>
  );
};
