import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

const seededRandom = (seed: number) => {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};

export const OpenSourceAcknowledgementsSection: React.FC = () => {
  const { t } = useTranslation('settings');

  const tags = useMemo(() => {
    const groups = [
      {
        key: 'coreStack',
        color: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 border-blue-100 dark:border-blue-900/30',
        items: [
          'React 18', 'TypeScript 5', 'Vite 6', 'Tailwind CSS 3', 'PostCSS'
        ]
      },
      {
        key: 'uiAndInteraction',
        color: 'bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400 border-purple-100 dark:border-purple-900/30',
        items: [
          'Ant Design 5', 'Radix UI', 'Framer Motion', 'Lucide React', 'DnD Kit',
          'React Flow', 'Hello Pangea DnD', 'cmdk', 'Recharts', 'React Toastify',
          'React Tooltip', 'React Dropzone', 'Smooth Scrollbar',
          'React Hotkeys Hook', 'React Zoom Pan Pinch', 'Reactour'
        ]
      },
      {
        key: 'contentEditing',
        color: 'bg-pink-50 text-pink-600 dark:bg-pink-900/20 dark:text-pink-400 border-pink-100 dark:border-pink-900/30',
        items: [
          'Milkdown', 'CodeMirror', 'ProseMirror', 'Mermaid', 'KaTeX',
          'React PDF', 'PDF.js', 'React Markdown', 'Prism.js', 'remark-gfm', 'rehype-katex', 'rehype-sanitize'
        ]
      },
      {
        key: 'stateAndData',
        color: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400 border-orange-100 dark:border-orange-900/30',
        items: [
          'Zustand', 'Immer', 'i18next', 'react-i18next',
          'date-fns', 'nanoid', 'uuid', 'yaml', 'diff', 'clsx', 'DOMPurify', 'xss'
        ]
      },
      {
        key: 'aiAndAgents',
        color: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400 border-green-100 dark:border-green-900/30',
        items: [
          'MCP SDK', 'LanceDB', 'Apache Arrow', 'TanStack Virtual', 'SnapDOM'
        ]
      },
      {
        key: 'rustEcosystem',
        color: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 border-amber-100 dark:border-amber-900/30',
        items: [
          'Tauri 2', 'Tokio', 'Serde', 'Rusqlite', 'Reqwest', 'Rayon', 'Moka',
          'pdf-extract', 'docx-rs', 'Comrak', 'pdfium-render', 'Calamine', 'ExcelJS', 'docx-preview', 'pptx-preview',
          'instant-distance', 'Anyhow', 'Tracing', 'Sentry'
        ]
      }
    ];

    const allTags = groups.flatMap(group => 
      group.items.map(item => ({
        name: item,
        categoryKey: group.key,
        className: group.color
      }))
    );

    return allTags.sort((a, b) => {
      const hashA = a.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const hashB = b.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return seededRandom(hashA) - seededRandom(hashB);
    });
  }, []);

  return (
    <div>
      <GroupTitle title={t('acknowledgements.openSource.title')} />
      <div className="flex flex-wrap gap-2 px-1">
        {tags.map((tag, i) => (
          <CommonTooltip 
            key={tag.name}
            content={t(`acknowledgements.openSource.categories.${tag.categoryKey}`)}
            position="top"
          >
            <motion.span
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ 
                delay: i * 0.01,
                type: "spring",
                stiffness: 200,
                damping: 20
              }}
              whileHover={{ 
                scale: 1.05,
                zIndex: 10,
              }}
              className={`
                inline-block cursor-default select-none
                px-3 py-1.5 rounded-md
                text-xs font-medium
                border
                transition-colors duration-200
                ${tag.className}
              `}
            >
              {tag.name}
            </motion.span>
          </CommonTooltip>
        ))}
      </div>
      <p className="mt-4 px-1 text-[11px] text-muted-foreground/60 leading-relaxed">
        {t('acknowledgements.openSource.description')}
      </p>
    </div>
  );
};
