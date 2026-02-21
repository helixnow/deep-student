/**
 * UserAgreementDialog - 首次启动用户协议弹窗
 *
 * 依据《生成式人工智能服务管理暂行办法》第9条，
 * 要求与用户签订服务协议，明确双方权利义务。
 *
 * 功能：
 * - 首次启动时展示用户协议 + 隐私政策摘要 + 内容使用规范
 * - 用户必须明确同意后方可使用
 * - 同意状态存入本地数据库
 *
 * 样式：纯 Notion 风格，不使用 shadcn Dialog
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChevronRight } from 'lucide-react';
import { Z_INDEX } from '@/config/zIndex';

// ============================================================================
// 常量
// ============================================================================
export const USER_AGREEMENT_ACCEPTED_KEY = 'user_agreement_accepted';
export const USER_AGREEMENT_VERSION = '1.0.0';

// ============================================================================
// Hook: useUserAgreement
// ============================================================================
export function useUserAgreement() {
  const [needsAgreement, setNeedsAgreement] = useState<boolean | null>(null);

  const checkAgreement = useCallback(async () => {
    // 🔧 时序修复：版本更新时数据库可能正在执行迁移，get_setting 可能暂时失败。
    // 如果首次检查失败，进行重试而非直接判定为"需要同意"，避免已有用户被误弹协议弹窗。
    const tryCheck = async (): Promise<'agreed' | 'not_agreed' | 'error'> => {
      try {
        const accepted = await invoke('get_setting', { key: USER_AGREEMENT_ACCEPTED_KEY }) as string | null;
        return accepted === USER_AGREEMENT_VERSION ? 'agreed' : 'not_agreed';
      } catch {
        return 'error';
      }
    };

    const firstResult = await tryCheck();
    if (firstResult === 'agreed') {
      setNeedsAgreement(false);
      return;
    }
    if (firstResult === 'not_agreed') {
      setNeedsAgreement(true);
      return;
    }

    // 首次检查出错（数据库可能正在迁移），后台重试
    console.warn('[Legal] 用户协议检查失败，数据库可能正在迁移，将重试...');
    const retryDelays = [500, 1000, 2000, 3000, 5000];
    for (const delay of retryDelays) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const result = await tryCheck();
      if (result === 'agreed') {
        console.log('[Legal] 重试成功：用户已同意协议');
        setNeedsAgreement(false);
        return;
      }
      if (result === 'not_agreed') {
        setNeedsAgreement(true);
        return;
      }
    }

    // 所有重试均失败：真正的数据库问题，视为需要同意（兜底保守策略）
    console.error('[Legal] 所有重试均失败，按需要同意处理');
    setNeedsAgreement(true);
  }, []);

  const acceptAgreement = useCallback(async () => {
    try {
      await invoke('save_setting', {
        key: USER_AGREEMENT_ACCEPTED_KEY,
        value: USER_AGREEMENT_VERSION,
      });
      setNeedsAgreement(false);
    } catch (err) {
      // 保存失败：首先尝试重试一次
      try {
        await new Promise(r => setTimeout(r, 500));
        await invoke('save_setting', {
          key: USER_AGREEMENT_ACCEPTED_KEY,
          value: USER_AGREEMENT_VERSION,
        });
        setNeedsAgreement(false);
      } catch {
        // 重试仍失败：允许继续使用，但提示用户下次启动可能再次显示
        console.warn('[Legal] 用户协议同意状态保存失败，下次启动可能再次显示', err);
        setNeedsAgreement(false);
      }
    }
  }, []);

  return { needsAgreement, checkAgreement, acceptAgreement };
}

// ============================================================================
// Notion 风格 Toggle 块组件
// ============================================================================
interface ToggleBlockProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const ToggleBlock: React.FC<ToggleBlockProps> = ({
  title,
  defaultOpen = false,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="select-none">
      {/* Toggle 触发行 —— Notion 风格：无边框，hover 浅色背景 */}
      <NotionButton variant="ghost" size="sm" onClick={() => setIsOpen(!isOpen)} className={cn('!w-full !justify-start !px-2 !py-1.5 !h-auto -mx-2 !rounded-[4px] !text-left', 'text-[14px] font-medium text-foreground/90', 'hover:bg-foreground/[0.04] active:bg-foreground/[0.06]')}>
        {/* 展开箭头 —— Notion 三角形风格 */}
        <ChevronRight
          className={cn(
            'h-[18px] w-[18px] text-foreground/40 flex-shrink-0',
            'transition-transform duration-150 ease-out',
            isOpen && 'rotate-90'
          )}
        />
        <span className="flex-1 min-w-0 truncate">{title}</span>
      </NotionButton>

      {/* 展开内容 —— 带左侧缩进，模拟 Notion toggle 嵌套 */}
      {isOpen && (
        <div className="pl-[30px] pr-1 pb-1 pt-0.5">
          <div className="text-[13px] text-foreground/70 leading-[1.65] space-y-2">
            {children}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================
interface UserAgreementDialogProps {
  onAccept: () => void;
  /** 预览模式：允许关闭弹窗，不要求同意 */
  preview?: boolean;
  /** 预览模式下控制弹窗显隐 */
  open?: boolean;
  /** 预览模式下关闭回调 */
  onClose?: () => void;
}

export const UserAgreementDialog: React.FC<UserAgreementDialogProps> = ({
  onAccept,
  preview,
  open,
  onClose,
}) => {
  const { t } = useTranslation('common');
  const panelRef = useRef<HTMLDivElement>(null);

  const isVisible = preview ? (open ?? false) : true;

  // 动画状态
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (isVisible) {
      // 下一帧触发入场动画
      requestAnimationFrame(() => setMounted(true));
    } else {
      setMounted(false);
    }
  }, [isVisible]);

  // ESC 关闭（仅预览模式）
  useEffect(() => {
    if (!preview || !isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [preview, isVisible, onClose]);

  if (!isVisible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (preview && e.target === e.currentTarget) {
      onClose?.();
    }
  };

  const dialog = (
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center',
        'transition-opacity duration-200 ease-out',
        mounted ? 'opacity-100' : 'opacity-0',
      )}
      style={{ zIndex: Z_INDEX.modal }}
      onClick={handleOverlayClick}
    >
      {/* 遮罩层 —— 极简，无 blur */}
      <div
        className={cn(
          'absolute inset-0 bg-black/25',
          'transition-opacity duration-200',
          mounted ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* 面板 */}
      <div
        ref={panelRef}
        className={cn(
          'relative flex flex-col',
          'w-[94vw] max-w-[520px] max-h-[80vh]',
          'bg-background',
          // Notion 风格：极其干净的阴影，几乎无边框
          'rounded-lg',
          'shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]',
          'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]',
          // 入场动画
          'transition-all duration-200 ease-out',
          mounted
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-[0.97] translate-y-2',
        )}
      >
        {/* 标题区 */}
        <div className="px-6 pt-6 pb-3 flex-shrink-0">
          <h1 className="text-[20px] font-semibold text-foreground leading-tight tracking-[-0.01em]">
            {t('legal.userAgreement.welcomeTitle')}
          </h1>
          <p className="mt-1.5 text-[13px] text-foreground/50 leading-relaxed">
            {t('legal.userAgreement.welcomeDesc')}
          </p>
        </div>

        {/* 分隔线 —— Notion 风格极细线 */}
        <div className="mx-6 h-px bg-foreground/[0.06]" />

        {/* 内容区 */}
        <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-6 py-4">
          <div className="space-y-0.5">
            {/* 用户协议 */}
            <ToggleBlock
              title={t('legal.userAgreement.agreementTitle')}
              defaultOpen={true}
            >
              <p>{t('legal.userAgreement.agreementContent.intro')}</p>

              <div className="space-y-3 mt-2">
                <AgreementItem
                  title={t('legal.userAgreement.agreementContent.aiFeatures')}
                  content={t('legal.userAgreement.agreementContent.aiFeaturesDesc')}
                />
                <AgreementItem
                  title={t('legal.userAgreement.agreementContent.dataProcessing')}
                  content={t('legal.userAgreement.agreementContent.dataProcessingDesc')}
                />
                <AgreementItem
                  title={t('legal.userAgreement.agreementContent.userRights')}
                  content={t('legal.userAgreement.agreementContent.userRightsDesc')}
                />
                <AgreementItem
                  title={t('legal.userAgreement.agreementContent.intellectualProperty')}
                  content={t('legal.userAgreement.agreementContent.intellectualPropertyDesc')}
                />
                <AgreementItem
                  title={t('legal.userAgreement.agreementContent.crossBorderData')}
                  content={t('legal.userAgreement.agreementContent.crossBorderDataDesc')}
                />
              </div>
            </ToggleBlock>

            {/* 隐私政策 */}
            <ToggleBlock
              title={t('legal.userAgreement.privacyTitle')}
            >
              <p>{t('legal.privacyPolicy.sections.overview.content')}</p>

              <div className="space-y-1.5 mt-2">
                <PolicyItem
                  color="emerald"
                  title={t('legal.privacyPolicy.sections.localStorage.title')}
                  content={t('legal.privacyPolicy.sections.localStorage.content')}
                />
                <PolicyItem
                  color="blue"
                  title={t('legal.privacyPolicy.sections.llmApi.title')}
                  content={t('legal.privacyPolicy.sections.llmApi.content')}
                />
                <PolicyItem
                  color="orange"
                  title={t('legal.privacyPolicy.sections.errorReporting.title')}
                  content={t('legal.privacyPolicy.sections.errorReporting.content')}
                />
                <PolicyItem
                  color="gray"
                  title={t('legal.privacyPolicy.sections.noTracking.title')}
                  content={t('legal.privacyPolicy.sections.noTracking.content')}
                />
              </div>
            </ToggleBlock>

            {/* 内容使用规范 */}
            <ToggleBlock
              title={t('legal.userAgreement.contentSafetyTitle')}
            >
              <p>{t('legal.userAgreement.contentSafety.intro')}</p>
              <ul className="mt-2 space-y-0.5">
                {[1, 2, 3, 4, 5, 6, 7].map(i => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="mt-[7px] h-1 w-1 rounded-full bg-foreground/30 flex-shrink-0" />
                    <span>{t(`legal.userAgreement.contentSafety.rule${i}`)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-orange-600/80 dark:text-orange-400/80 font-medium">
                {t('legal.userAgreement.contentSafety.note')}
              </p>
            </ToggleBlock>
          </div>
        </CustomScrollArea>

        {/* 分隔线 */}
        <div className="mx-6 h-px bg-foreground/[0.06]" />

        {/* 底部操作栏 */}
        <div className="px-6 py-4 flex-shrink-0">
          {preview ? (
            <NotionButton
              variant="default"
              size="lg"
              className="w-full justify-center text-[13px] font-medium"
              onClick={onClose}
            >
              {t('common:close', '关闭')}
            </NotionButton>
          ) : (
            <NotionButton
              variant="primary"
              size="lg"
              className="w-full justify-center text-[13px] font-medium"
              onClick={onAccept}
            >
              {t('legal.userAgreement.agreeAndContinue')}
            </NotionButton>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
};

// ============================================================================
// 子组件：协议条目
// ============================================================================
const AgreementItem: React.FC<{ title: string; content: string }> = ({ title, content }) => (
  <div>
    <h4 className="text-[13px] font-medium text-foreground/85">{title}</h4>
    <p className="mt-0.5 text-foreground/55">{content}</p>
  </div>
);

// ============================================================================
// 子组件：隐私政策条目
// ============================================================================
const colorMap: Record<string, string> = {
  emerald: 'bg-emerald-500/60',
  blue: 'bg-blue-500/60',
  orange: 'bg-orange-500/60',
  gray: 'bg-foreground/20',
};

const PolicyItem: React.FC<{
  color: string;
  title: string;
  content: string;
}> = ({ color, title, content }) => (
  <div className="flex items-start gap-2">
    <span className={cn('mt-[6px] h-1.5 w-1.5 rounded-full flex-shrink-0', colorMap[color] || colorMap.gray)} />
    <div className="min-w-0">
      <p className="text-[12px] font-medium text-foreground/80">{title}</p>
      <p className="text-[12px] text-foreground/45 leading-[1.5]">{content}</p>
    </div>
  </div>
);

export default UserAgreementDialog;
