/**
 * PrivacyPolicyDialog - 应用内隐私政策弹窗
 *
 * 依据《个人信息保护法》第17条，
 * 信息处理者应当向个人告知处理目的、方式和范围等。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import {
  ArrowsClockwise,
  Baby,
  Bug,
  Cloud,
  Eye,
  Globe,
  HardDrive,
  PaperPlaneTilt,
  ShieldCheck,
  UserMinus,
} from '@phosphor-icons/react';

// ============================================================================
// 隐私政策章节
// ============================================================================
interface PolicySectionProps {
  icon: React.ReactNode;
  title: string;
  content: string;
}

const PolicySection: React.FC<PolicySectionProps> = ({ icon, title, content }) => (
  <div className="flex gap-3 py-3">
    <div className="flex-shrink-0 mt-0.5">{icon}</div>
    <div className="flex-1 min-w-0">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="mt-1 text-[13px] text-foreground/70 leading-relaxed">{content}</p>
    </div>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================
interface PrivacyPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const PrivacyPolicyDialog: React.FC<PrivacyPolicyDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation('common');

  const sections = [
    {
      icon: <Eye size={16} className="text-blue-500" weight="regular" />,
      key: 'overview',
    },
    {
      icon: <HardDrive size={16} className="text-emerald-500" weight="regular" />,
      key: 'localStorage',
    },
    {
      icon: <PaperPlaneTilt size={16} className="text-blue-500" weight="regular" />,
      key: 'llmApi',
    },
    {
      icon: <Bug size={16} className="text-orange-500" weight="regular" />,
      key: 'errorReporting',
    },
    {
      icon: <Cloud size={16} className="text-sky-500" weight="regular" />,
      key: 'cloudSync',
    },
    {
      icon: <UserMinus size={16} className="text-purple-500" weight="regular" />,
      key: 'noTracking',
    },
    {
      icon: <ShieldCheck size={16} className="text-emerald-500" weight="regular" />,
      key: 'dataRights',
    },
    {
      icon: <ShieldCheck size={16} className="text-blue-500" weight="regular" />,
      key: 'security',
    },
    {
      icon: <Globe size={16} className="text-amber-500" weight="regular" />,
      key: 'crossBorder',
    },
    {
      icon: <Baby size={16} className="text-pink-500" weight="regular" />,
      key: 'children',
    },
    {
      icon: <ArrowsClockwise size={16} className="text-muted-foreground" weight="regular" />,
      key: 'changes',
    },
  ];

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-[600px]">
        <NotionDialogHeader>
          <NotionDialogTitle>{t('legal.privacyPolicy.title')}</NotionDialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {t('legal.privacyPolicy.lastUpdated')}
          </p>
        </NotionDialogHeader>

        <NotionDialogBody>
          <div className="divide-y divide-border/40">
            {sections.map((section) => (
              <PolicySection
                key={section.key}
                icon={section.icon}
                title={t(`legal.privacyPolicy.sections.${section.key}.title`)}
                content={t(`legal.privacyPolicy.sections.${section.key}.content`)}
/>
            ))}
          </div>
        </NotionDialogBody>

        <NotionDialogFooter>
          <NotionButton
            variant="default"
            size="sm"
            className="w-full justify-center"
            onClick={() => onOpenChange(false)}
          >
            {t('actions.close')}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
};

export default PrivacyPolicyDialog;
