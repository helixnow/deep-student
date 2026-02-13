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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/shad/Dialog';
import {
  HardDrive,
  Cloud,
  Send,
  Bug,
  ShieldCheck,
  UserX,
  Baby,
  RefreshCw,
  Eye,
  Globe,
} from 'lucide-react';

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
      icon: <Eye className="h-4 w-4 text-blue-500" />,
      key: 'overview',
    },
    {
      icon: <HardDrive className="h-4 w-4 text-emerald-500" />,
      key: 'localStorage',
    },
    {
      icon: <Send className="h-4 w-4 text-blue-500" />,
      key: 'llmApi',
    },
    {
      icon: <Bug className="h-4 w-4 text-orange-500" />,
      key: 'errorReporting',
    },
    {
      icon: <Cloud className="h-4 w-4 text-sky-500" />,
      key: 'cloudSync',
    },
    {
      icon: <UserX className="h-4 w-4 text-purple-500" />,
      key: 'noTracking',
    },
    {
      icon: <ShieldCheck className="h-4 w-4 text-emerald-500" />,
      key: 'dataRights',
    },
    {
      icon: <ShieldCheck className="h-4 w-4 text-blue-500" />,
      key: 'security',
    },
    {
      icon: <Globe className="h-4 w-4 text-amber-500" />,
      key: 'crossBorder',
    },
    {
      icon: <Baby className="h-4 w-4 text-pink-500" />,
      key: 'children',
    },
    {
      icon: <RefreshCw className="h-4 w-4 text-muted-foreground" />,
      key: 'changes',
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] h-[80vh] max-h-[80vh] flex flex-col p-0">
        <div className="px-6 pt-6 pb-2">
          <DialogHeader>
            <DialogTitle>{t('legal.privacyPolicy.title')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground mt-1">
            {t('legal.privacyPolicy.lastUpdated')}
          </p>
        </div>

        <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-6 pb-6">
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
        </CustomScrollArea>

        <div className="px-6 py-3 border-t border-border/40">
          <NotionButton
            variant="default"
            size="md"
            className="w-full justify-center"
            onClick={() => onOpenChange(false)}
          >
            {t('actions.close')}
          </NotionButton>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PrivacyPolicyDialog;
