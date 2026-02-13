import React from 'react';
import { Database } from 'lucide-react';
import { HeaderTemplate } from './HeaderTemplate';
import { DataImportExport } from './DataImportExport';
import { CustomScrollArea } from './custom-scroll-area';
import { useTranslation } from 'react-i18next';

export const DataCenter: React.FC = () => {
  const { t } = useTranslation('data');
  
  return (
    <div className="h-full flex flex-col bg-background">
      <HeaderTemplate
        icon={Database}
        iconColor="#3b82f6"
        iconSize={32}
        title={t('data_center_title')}
        subtitle={t('data_center_subtitle')}
        showRefreshButton={false}
        showExportButton={false}
      />

      <main className="flex-1 min-h-0">
        <CustomScrollArea className="h-full" viewportClassName="px-6 pb-6">
          <div className="max-w-[1400px] mx-auto">
            {/* 直接显示合并后的数据统计与管理页面 */}
            <DataImportExport embedded={true} />
          </div>
        </CustomScrollArea>
      </main>
    </div>
  );
};

export default DataCenter;
