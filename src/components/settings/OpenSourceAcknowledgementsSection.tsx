import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-6 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

export const OpenSourceAcknowledgementsSection: React.FC = () => {
  const { t } = useTranslation('settings');

  const groups = useMemo(() => [
    {
      key: 'coreStack',
      color: 'bg-blue-50/80 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 border-blue-200/50 dark:border-blue-800/50',
      hoverColor: 'hover:bg-blue-100 hover:border-blue-300 dark:hover:bg-blue-900/40 dark:hover:border-blue-700/50',
      items: ['React 18', 'TypeScript 5', 'Vite 6', 'Tailwind CSS 4', 'PostCSS']
    },
    {
      key: 'uiAndInteraction',
      color: 'bg-purple-50/80 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400 border-purple-200/50 dark:border-purple-800/50',
      hoverColor: 'hover:bg-purple-100 hover:border-purple-300 dark:hover:bg-purple-900/40 dark:hover:border-purple-700/50',
      items: [
        'Radix UI', 'Framer Motion', 'Lucide React', 'DnD Kit',
        'React Flow', 'Hello Pangea DnD', 'cmdk', 'Recharts',
        'React Tooltip', 'React Dropzone', 'React Complex Tree',
        'React Resizable Panels', 'React Hotkeys Hook',
        'React Zoom Pan Pinch', 'html-to-image', 'Reactour'
      ]
    },
    {
      key: 'contentEditing',
      color: 'bg-pink-50/80 text-pink-600 dark:bg-pink-900/20 dark:text-pink-400 border-pink-200/50 dark:border-pink-800/50',
      hoverColor: 'hover:bg-pink-100 hover:border-pink-300 dark:hover:bg-pink-900/40 dark:hover:border-pink-700/50',
      items: [
        'Milkdown', 'CodeMirror', 'ProseMirror', 'Mermaid', 'KaTeX',
        'React PDF', 'PDF.js', 'React Markdown', 'Prism.js', 'Defuddle',
        'remark-gfm', 'remark-math', 'rehype-katex', 'rehype-raw', 'rehype-sanitize'
      ]
    },
    {
      key: 'stateAndData',
      color: 'bg-orange-50/80 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400 border-orange-200/50 dark:border-orange-800/50',
      hoverColor: 'hover:bg-orange-100 hover:border-orange-300 dark:hover:bg-orange-900/40 dark:hover:border-orange-700/50',
      items: [
        'Zustand', 'Immer', 'i18next', 'react-i18next',
        'date-fns', 'nanoid', 'uuid', 'yaml', 'diff', 'clsx', 'Mustache', 'DOMPurify'
      ]
    },
    {
      key: 'aiAndAgents',
      color: 'bg-green-50/80 text-green-600 dark:bg-green-900/20 dark:text-green-400 border-green-200/50 dark:border-green-800/50',
      hoverColor: 'hover:bg-green-100 hover:border-green-300 dark:hover:bg-green-900/40 dark:hover:border-green-700/50',
      items: [
        'MCP SDK', 'LanceDB', 'Apache Arrow', 'TanStack Virtual', 'SnapDOM'
      ]
    },
    {
      key: 'rustEcosystem',
      color: 'bg-amber-50/80 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200/50 dark:border-amber-800/50',
      hoverColor: 'hover:bg-amber-100 hover:border-amber-300 dark:hover:bg-amber-900/40 dark:hover:border-amber-700/50',
      items: [
        'Tauri 2', 'Tokio', 'Serde', 'Rusqlite', 'Reqwest', 'Rayon', 'Moka', 'Chrono',
        'docx-rs', 'pdfium-render', 'Calamine', 'ppt-rs', 'pptx-to-md', 'Umya Spreadsheet',
        'epub-rs', 'encoding_rs', 'ExcelJS', 'docx-preview', 'pptx-preview',
        'Anyhow', 'Tracing', 'Sentry'
      ]
    }
  ], []);

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.03
      }
    }
  };

  const itemAnim = {
    hidden: { opacity: 0, scale: 0.95, y: 10 },
    show: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 24 } }
  };

  return (
    <div className="flex flex-col mb-4">
      <GroupTitle title={t('acknowledgements.openSource.title')} />
      <p className="text-[12.5px] text-muted-foreground/70 leading-relaxed px-1 -mt-4 mb-5">
        DeepStudent 依托以下成熟的开源生态快速发展，感谢所有社区长期的维护与创新。
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8 px-1">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col space-y-3">
            <h4 className="text-[13px] font-medium text-muted-foreground flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${group.color.split(' ')[0]}`} />
              {t(`acknowledgements.openSource.categories.${group.key}`)}
            </h4>
            <motion.div 
              variants={container}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: "-20px" }}
              className="flex flex-wrap gap-2"
            >
              {group.items.map((item) => (
                <motion.span
                  variants={itemAnim}
                  whileHover={{ scale: 1.05 }}
                  key={item}
                  className={`
                    inline-block cursor-default select-none
                    px-2.5 py-1 rounded-md
                    text-[11.5px] font-medium
                    border shadow-sm
                    transition-all duration-200
                    ${group.color} ${group.hoverColor}
                  `}
                >
                  {item}
                </motion.span>
              ))}
            </motion.div>
          </div>
        ))}
      </div>
      <div className="mt-10 px-1 pt-6 border-t border-border/40">
        <p className="text-[12px] text-muted-foreground/70 leading-relaxed">
          {t('acknowledgements.openSource.description')}
        </p>
      </div>
    </div>
  );
};
