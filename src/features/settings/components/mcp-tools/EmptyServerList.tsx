import { useTranslation } from 'react-i18next';
import { Plus, Plug } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';

// 空状态组件
export function EmptyServerList({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation(['settings']);

  return (
    <div className="py-16">
      <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4">
        <Plug className="w-6 h-6 text-muted-foreground/60" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {t('settings:mcp_descriptions.no_mcp_configured')}
      </p>
      <p className="text-xs text-muted-foreground mb-6 max-w-xs leading-relaxed">
        {t('settings:mcp_descriptions.click_add_to_start')}
      </p>
      <DsButton
        onClick={onAdd}
        variant="primary"
        size="sm"
        className="[@media(pointer:coarse)]:!min-h-11"
      >
        <Plus className="w-4 h-4 mr-1" />
        {t('settings:mcp_server_list.add_server')}
      </DsButton>
    </div>
  );
}
