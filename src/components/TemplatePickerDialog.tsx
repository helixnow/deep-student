import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog, NotionDialogBody } from './ui/NotionDialog';
import { Card, CardContent, CardHeader, CardTitle } from './ui/shad/Card';
import { Input } from './ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { FileText, Eye, X } from 'lucide-react';
import { templateManager } from '../data/ankiTemplates';
import { CustomAnkiTemplate } from '../types';
import { CustomScrollArea } from './custom-scroll-area';
import { IframePreview, renderCardPreview as renderTemplatePreview } from './SharedPreview';

interface TemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (template: CustomAnkiTemplate) => void;
  onOpenManager?: () => void;
}

const TemplatePickerDialog: React.FC<TemplatePickerDialogProps> = ({ open, onClose, onSelect, onOpenManager }) => {
  const { t } = useTranslation(['anki']);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);
  const [previewingTemplate, setPreviewingTemplate] = useState<CustomAnkiTemplate | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      await templateManager.refresh();
      setTemplates(templateManager.getAllTemplates());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return templates;
    return templates.filter(t =>
      t.name.toLowerCase().includes(kw) ||
      (t.description || '').toLowerCase().includes(kw) ||
      (t.note_type || '').toLowerCase().includes(kw)
    );
  }, [templates, search]);


  return (
    <NotionDialog open={open} onOpenChange={(v)=> { if (!v) onClose(); }} maxWidth="max-w-4xl">
      <NotionDialogBody nativeScroll>
        <CustomScrollArea className="flex-1 min-h-0 overflow-hidden" viewportClassName="px-6 py-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">{t('select_template_title')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('select_template_description')}</p>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Input value={search} onChange={(e)=> setSearch(e.target.value)} placeholder={t('search_template_placeholder')} className="flex-1" />
            <NotionButton variant="ghost" size="sm" onClick={load} disabled={loading}>{loading ? t('loading') : t('refresh')}</NotionButton>
          </div>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
            {filtered.map(template => (
              <Card key={template.id} className="hover:ring-1 hover:ring-slate-200 transition">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm truncate" title={template.name}>{template.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xs text-muted-foreground line-clamp-2" title={template.description}>{template.description}</div>
                  <div className="mt-2 text-xs text-muted-foreground flex items-center gap-3">
                    <span>{t('template_fields_label')}{' '}{template.fields.length}</span>
                    <span>{t('labels.type')}: {template.note_type}</span>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <NotionButton variant="ghost" size="sm" onClick={() => setPreviewingTemplate(template)}>
                      <Eye className="h-4 w-4 mr-1" /> {t('preview')}
                    </NotionButton>
                    <NotionButton size="sm" onClick={() => onSelect(template)}>
                      <FileText className="h-4 w-4 mr-1" /> {t('select')}
                    </NotionButton>
                  </div>
                </CardContent>
              </Card>
            ))}
            {filtered.length === 0 && !loading && (
              <div className="col-span-full text-center text-sm text-muted-foreground py-6">{t('no_template_found')}</div>
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <NotionButton variant="ghost" onClick={onClose}>{t('close')}</NotionButton>
          </div>
        </CustomScrollArea>
        {/* 模板预览 */}
        {previewingTemplate && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h3 className="text-lg font-semibold">{previewingTemplate.name}</h3>
                <p className="text-sm text-muted-foreground mt-1">{previewingTemplate.description}</p>
              </div>
              <NotionButton variant="ghost" size="sm" onClick={() => setPreviewingTemplate(null)}>
                <X className="h-4 w-4 mr-1" /> {t('close_preview')}
              </NotionButton>
            </div>
            <CustomScrollArea className="flex-1 min-h-0" viewportClassName="p-6">
              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-sm font-semibold">{t('preview_front')}</div>
                  <div className="rounded-lg border overflow-hidden">
                    <IframePreview
                      htmlContent={renderTemplatePreview(
                        previewingTemplate.front_template,
                        previewingTemplate,
                        undefined,
                        false,
                      )}
                      cssContent={previewingTemplate.css_style}
                      height={400}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-semibold">{t('preview_back')}</div>
                  <div className="rounded-lg border overflow-hidden">
                    <IframePreview
                      htmlContent={renderTemplatePreview(
                        previewingTemplate.back_template,
                        previewingTemplate,
                        undefined,
                        true,
                      )}
                      cssContent={previewingTemplate.css_style}
                      height={400}
                    />
                  </div>
                </div>
              </div>
            </CustomScrollArea>
          </div>
        )}
      </NotionDialogBody>
    </NotionDialog>
  );
};

export default TemplatePickerDialog;
