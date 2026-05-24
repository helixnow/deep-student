import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ListChecks } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  NotionDialog,
  NotionDialogBody,
  NotionDialogDescription,
  NotionDialogFooter,
  NotionDialogHeader,
  NotionDialogTitle,
} from '@/components/ui/NotionDialog';

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

export const OpenSourceAcknowledgementsSection: React.FC = () => {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);

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

  return (
    <>
      <div className="flex flex-col mb-4">
        <div className="flex items-start justify-between gap-3">
          <GroupTitle title={t('acknowledgements.openSource.title')} />
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
            aria-label={t('acknowledgements.openSource.openDialog')}
            className="mr-1 h-7 gap-1.5 px-2 text-xs text-muted-foreground/85"
          >
            <span>{t('acknowledgements.openSource.openDialog')}</span>
            <ListChecks size={14} />
          </NotionButton>
        </div>
        <p className="mt-2 mb-1 px-1 text-[12.5px] leading-relaxed text-muted-foreground/70">
          {t('acknowledgements.openSource.description')}
        </p>
      </div>

      <NotionDialog open={open} onOpenChange={setOpen} maxWidth="max-w-[760px]">
        <NotionDialogHeader>
          <div className="min-w-0 pr-8">
            <NotionDialogTitle>{t('acknowledgements.openSource.title')}</NotionDialogTitle>
            <NotionDialogDescription>
              {t('acknowledgements.openSource.description')}
            </NotionDialogDescription>
          </div>
        </NotionDialogHeader>

        <NotionDialogBody className="py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
        </NotionDialogBody>

        <NotionDialogFooter>
          <NotionButton
            variant="default"
            size="sm"
            className="w-full justify-center"
            onClick={() => setOpen(false)}
          >
            {t('acknowledgements.openSource.closeDialog')}
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>
    </>
  );
};
