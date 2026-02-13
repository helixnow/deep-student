import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Check, X, Type, Smile, AlignLeft, Terminal, Zap, Trash2,
  Folder, FolderOpen, Star, Heart, BookOpen, GraduationCap,
  Code, Calculator, FlaskConical, Atom, Globe, Languages,
  Music, Palette, Camera, Lightbulb, Target, Trophy,
  Rocket, Brain, Sparkles, MessageSquare, FileText, Bookmark
} from 'lucide-react';

// 预设图标列表
export const PRESET_ICONS = [
  { name: 'folder', Icon: Folder },
  { name: 'folder-open', Icon: FolderOpen },
  { name: 'star', Icon: Star },
  { name: 'heart', Icon: Heart },
  { name: 'book-open', Icon: BookOpen },
  { name: 'graduation-cap', Icon: GraduationCap },
  { name: 'code', Icon: Code },
  { name: 'calculator', Icon: Calculator },
  { name: 'flask', Icon: FlaskConical },
  { name: 'atom', Icon: Atom },
  { name: 'globe', Icon: Globe },
  { name: 'languages', Icon: Languages },
  { name: 'music', Icon: Music },
  { name: 'palette', Icon: Palette },
  { name: 'camera', Icon: Camera },
  { name: 'lightbulb', Icon: Lightbulb },
  { name: 'target', Icon: Target },
  { name: 'trophy', Icon: Trophy },
  { name: 'rocket', Icon: Rocket },
  { name: 'brain', Icon: Brain },
  { name: 'sparkles', Icon: Sparkles },
  { name: 'message-square', Icon: MessageSquare },
  { name: 'file-text', Icon: FileText },
  { name: 'bookmark', Icon: Bookmark },
];
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { skillRegistry, subscribeToSkillRegistry } from '../../skills/registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../../types/group';

interface GroupEditorPanelProps {
  mode: 'create' | 'edit';
  initial?: SessionGroup | null;
  onSubmit: (payload: CreateGroupRequest | UpdateGroupRequest) => Promise<void>;
  onClose: () => void;
  onDelete?: () => void;
}

const PropertyRow: React.FC<{
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
  mobileStacked?: boolean;
}> = ({ icon: Icon, label, children, className, mobileStacked }) => (
  <div className={cn(
    "group grid items-start py-2", 
    mobileStacked 
      ? "grid-cols-1 md:grid-cols-[140px_1fr]" 
      : "grid-cols-[100px_1fr] md:grid-cols-[140px_1fr]",
    className
  )}>
    <div className={cn(
      "flex items-center gap-2 text-sm text-muted-foreground/80",
      mobileStacked ? "mb-2 md:mb-0 min-h-[auto] md:min-h-[36px]" : "min-h-[36px]"
    )}>
      <Icon className="w-4 h-4" />
      <span>{label}</span>
    </div>
    <div className="flex-1 min-w-0">
      {children}
    </div>
  </div>
);

export const GroupEditorPanel: React.FC<GroupEditorPanelProps> = ({
  mode,
  initial,
  onSubmit,
  onClose,
  onDelete,
}) => {
  const { t } = useTranslation(['chatV2', 'common', 'skills']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSkillIds, setDefaultSkillIds] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [systemPrompt]);
  useEffect(() => {
    if (mode === 'edit' && initial) {
      setName(initial.name);
      setDescription(initial.description ?? '');
      setIcon(initial.icon ?? '');
      setSystemPrompt(initial.systemPrompt ?? '');
      setDefaultSkillIds(initial.defaultSkillIds ?? []);
    } else {
      setName('');
      setDescription('');
      setIcon('');
      setSystemPrompt('');
      setDefaultSkillIds([]);
    }
  }, [mode, initial]);

  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const skillList = useMemo(() => {
    void registryVersion;
    return skillRegistry.getAll().sort((a, b) => a.name.localeCompare(b.name));
  }, [registryVersion]);

  const toggleSkill = useCallback((skillId: string) => {
    setDefaultSkillIds((prev) => {
      if (prev.includes(skillId)) {
        return prev.filter((id) => id !== skillId);
      }
      return [...prev, skillId];
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        defaultSkillIds,
      };
      
      if (mode === 'create') {
        await onSubmit(payload as CreateGroupRequest);
      } else {
        await onSubmit(payload as UpdateGroupRequest);
      }
    } catch (error: unknown) {
      console.error('[GroupEditorPanel] Failed to save group:', error);
      showGlobalNotification('error', t('page.groupSaveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [defaultSkillIds, description, icon, mode, name, onSubmit, systemPrompt, t]);

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* Action Buttons - Absolute Positioned */}
      <div className="absolute top-4 right-4 md:top-6 md:right-8 z-10 flex items-center gap-2">
          <NotionButton variant="ghost" onClick={onClose} disabled={isSaving} className="h-8 px-3">
            {t('common:cancel')}
          </NotionButton>
          <NotionButton 
            variant="primary" 
            onClick={handleSubmit} 
            disabled={isSaving || !name.trim()}
            className="h-8 px-3"
          >
            {mode === 'create' ? t('common:create') : t('common:save')}
          </NotionButton>
      </div>

      <CustomScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-5 py-8 md:px-8 md:py-10 space-y-6 md:space-y-8 mt-10 md:mt-12">
          
          {/* Title Section */}
          <div className="space-y-4">
             {/* Icon Preview if available */}
             {icon && (
                <div className="text-4xl mb-4">
                  {(() => {
                    const presetIcon = PRESET_ICONS.find(p => p.name === icon);
                    if (presetIcon) {
                      const IconComp = presetIcon.Icon;
                      return <IconComp className="w-10 h-10 text-primary" />;
                    }
                    return icon;
                  })()}
                </div>
             )}
             <input
               type="text"
               value={name}
               onChange={(e) => setName(e.target.value)}
               placeholder={t('page.groupNamePlaceholder')}
               className="w-full text-2xl md:text-3xl font-semibold border-0 border-b-2 border-border/50 bg-transparent placeholder:text-muted-foreground/40 py-3 pr-24 md:pr-0 outline-none focus:border-primary transition-colors"
             />
          </div>

          {/* Properties Section */}
          <div className="space-y-1">
            
            <PropertyRow icon={Smile} label={t('page.groupIcon')} mobileStacked>
              <div className="space-y-3">
                {/* 图标选择网格 */}
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_ICONS.map(({ name: iconName, Icon: IconComponent }) => (
                    <div
                      key={iconName}
                      onClick={() => setIcon(iconName)}
                      className={cn(
                        "w-9 h-9 flex items-center justify-center rounded-md cursor-pointer transition-all",
                        icon === iconName
                          ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                          : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                      )}
                      title={iconName}
                    >
                      <IconComponent className="w-5 h-5" />
                    </div>
                  ))}
                  {/* 清除按钮 */}
                  {icon && (
                    <div
                      onClick={() => setIcon('')}
                      className="w-9 h-9 flex items-center justify-center rounded-md cursor-pointer hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                      title={t('common:clear')}
                    >
                      <X className="w-4 h-4" />
                    </div>
                  )}
                </div>
                {/* 自定义输入（支持 emoji） */}
                <Input
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder={t('page.groupIconPlaceholder')}
                  className="h-8 text-sm border-transparent shadow-none bg-transparent hover:bg-muted/30 focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 transition-all"
                />
              </div>
            </PropertyRow>

            <PropertyRow icon={AlignLeft} label={t('page.groupDescription')}>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('page.groupDescriptionPlaceholder')}
                className="h-9 border-transparent shadow-none bg-transparent hover:bg-muted/30 focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 transition-all"
              />
            </PropertyRow>

            <PropertyRow icon={Terminal} label={t('page.groupSystemPrompt')} mobileStacked>
              <Textarea
                ref={textareaRef}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                className="min-h-[120px] border-transparent shadow-none bg-transparent hover:bg-muted/30 focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 py-2 transition-all resize-none overflow-hidden"
                placeholder={t('page.groupSystemPromptPlaceholder')}
              />
            </PropertyRow>

            <PropertyRow icon={Zap} label={t('page.groupDefaultSkills')} mobileStacked>
                <div className="flex flex-wrap gap-2 pt-1.5 px-0 md:px-2">
                    {skillList.length === 0 ? (
                        <div className="text-sm text-muted-foreground/50">
                            {t('page.noSkills')}
                        </div>
                    ) : (
                        skillList.map(skill => {
                            const checked = defaultSkillIds.includes(skill.id);
                            // 优先使用国际化友好名称
                            const displayName = t(`skills:builtinNames.${skill.id}`, { defaultValue: '' }) || skill.name;
                            return (
                                <div
                                    key={skill.id}
                                    onClick={() => toggleSkill(skill.id)}
                                    className={cn(
                                        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm border cursor-pointer transition-colors select-none",
                                        checked 
                                          ? "bg-primary/10 text-primary border-primary/20" 
                                          : "bg-background border-border hover:bg-muted text-muted-foreground"
                                    )}
                                >
                                    {checked && <Check className="w-3 h-3" />}
                                    <span>{displayName}</span>
                                </div>
                            )
                        })
                    )}
                </div>
            </PropertyRow>

          </div>

          {mode === 'edit' && onDelete && (
            <div className="pt-6 border-t border-border/40">
              <NotionButton
                variant="danger"
                onClick={onDelete}
                className="h-8 px-3"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                {t('page.deleteGroup')}
              </NotionButton>
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};
