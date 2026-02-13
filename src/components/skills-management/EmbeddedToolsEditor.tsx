/**
 * EmbeddedToolsEditor - 内嵌工具编辑器
 *
 * 用于在 Skill 编辑器中管理 embeddedTools 字段
 * 支持添加、编辑、删除工具定义
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Label } from '../ui/shad/Label';
import { Textarea } from '../ui/shad/Textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/shad/Collapsible';
import { Plus, Trash2, ChevronDown, ChevronRight, Wrench, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolSchema, ToolInputSchema, JsonSchemaProperty } from '@/chat-v2/skills/types';

interface EmbeddedToolsEditorProps {
  tools: ToolSchema[];
  onChange: (tools: ToolSchema[]) => void;
  disabled?: boolean;
}

const createEmptyTool = (): ToolSchema => ({
  name: '',
  description: '',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
});

const createEmptyProperty = (): JsonSchemaProperty => ({
  type: 'string',
  description: '',
});

interface AutoResizeTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minHeight?: number;
}

const AutoResizeTextarea: React.FC<AutoResizeTextareaProps> = ({ 
  value, 
  onChange, 
  minHeight = 60,
  className,
  ...props 
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
    }
  }, [value, minHeight]);

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      className={cn('overflow-hidden', className)}
      {...props}
    />
  );
};

export const EmbeddedToolsEditor: React.FC<EmbeddedToolsEditorProps> = ({
  tools,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());

  const toggleToolExpanded = useCallback((index: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const addTool = useCallback(() => {
    const newTools = [...tools, createEmptyTool()];
    onChange(newTools);
    setExpandedTools((prev) => new Set(prev).add(newTools.length - 1));
  }, [tools, onChange]);

  const removeTool = useCallback((index: number) => {
    const newTools = tools.filter((_, i) => i !== index);
    onChange(newTools);
    setExpandedTools((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  }, [tools, onChange]);

  const updateTool = useCallback((index: number, updates: Partial<ToolSchema>) => {
    const newTools = tools.map((tool, i) =>
      i === index ? { ...tool, ...updates } : tool
    );
    onChange(newTools);
  }, [tools, onChange]);

  const updateInputSchema = useCallback((
    toolIndex: number,
    schemaUpdates: Partial<ToolInputSchema>
  ) => {
    const tool = tools[toolIndex];
    updateTool(toolIndex, {
      inputSchema: { ...tool.inputSchema, ...schemaUpdates },
    });
  }, [tools, updateTool]);

  const addProperty = useCallback((toolIndex: number) => {
    const tool = tools[toolIndex];
    const propName = `param_${Object.keys(tool.inputSchema.properties).length + 1}`;
    updateInputSchema(toolIndex, {
      properties: {
        ...tool.inputSchema.properties,
        [propName]: createEmptyProperty(),
      },
    });
  }, [tools, updateInputSchema]);

  const removeProperty = useCallback((toolIndex: number, propName: string) => {
    const tool = tools[toolIndex];
    const { [propName]: _, ...restProps } = tool.inputSchema.properties;
    const newRequired = (tool.inputSchema.required || []).filter((r) => r !== propName);
    updateInputSchema(toolIndex, {
      properties: restProps,
      required: newRequired,
    });
  }, [tools, updateInputSchema]);

  const updateProperty = useCallback((
    toolIndex: number,
    oldName: string,
    newName: string,
    propUpdates: Partial<JsonSchemaProperty>
  ) => {
    const tool = tools[toolIndex];
    const properties = { ...tool.inputSchema.properties };
    
    if (oldName !== newName && newName) {
      delete properties[oldName];
      properties[newName] = { ...tool.inputSchema.properties[oldName], ...propUpdates };
      const newRequired = (tool.inputSchema.required || []).map((r) =>
        r === oldName ? newName : r
      );
      updateInputSchema(toolIndex, { properties, required: newRequired });
    } else {
      properties[oldName] = { ...properties[oldName], ...propUpdates };
      updateInputSchema(toolIndex, { properties });
    }
  }, [tools, updateInputSchema]);

  const toggleRequired = useCallback((toolIndex: number, propName: string) => {
    const tool = tools[toolIndex];
    const required = tool.inputSchema.required || [];
    const newRequired = required.includes(propName)
      ? required.filter((r) => r !== propName)
      : [...required, propName];
    updateInputSchema(toolIndex, { required: newRequired });
  }, [tools, updateInputSchema]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench size={14} className="text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
            {t('skills:editor.embedded_tools', '内嵌工具')}
          </span>
          {tools.length > 0 && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              {tools.length}
            </span>
          )}
        </div>
        <NotionButton
          type="button"
          variant="outline"
          size="sm"
          onClick={addTool}
          disabled={disabled}
          className="h-7 text-xs"
        >
          <Plus size={14} className="mr-1" />
          {t('skills:editor.add_tool', '添加工具')}
        </NotionButton>
      </div>

      {tools.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground/60 text-sm border border-dashed border-border/40 rounded-lg">
          <Wrench size={24} className="mx-auto mb-2 opacity-40" />
          <p>{t('skills:editor.no_tools', '暂无内嵌工具')}</p>
          <p className="text-xs mt-1">
            {t('skills:editor.no_tools_hint', '点击上方按钮添加工具定义')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tools.map((tool, toolIndex) => {
            const isExpanded = expandedTools.has(toolIndex);
            const hasError = !tool.name || !tool.description;
            
            return (
              <Collapsible
                key={toolIndex}
                open={isExpanded}
                onOpenChange={() => toggleToolExpanded(toolIndex)}
                className={cn(
                  'border rounded-lg transition-all',
                  hasError ? 'border-amber-500/50' : 'border-border/40',
                  isExpanded && 'border-border/60'
                )}
              >
                <div
                  className={cn(
                    'flex items-center justify-between p-3 hover:bg-muted/30 transition-colors rounded-t-lg',
                    !isExpanded && 'rounded-b-lg'
                  )}
                >
                  <CollapsibleTrigger
                    className="flex items-center gap-2 min-w-0 flex-1"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-muted-foreground flex-shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                    )}
                    <span className="font-mono text-sm truncate">
                      {tool.name || t('skills:editor.unnamed_tool', '未命名工具')}
                    </span>
                    {hasError && (
                      <AlertCircle size={12} className="text-amber-500 flex-shrink-0" />
                    )}
                  </CollapsibleTrigger>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {Object.keys(tool.inputSchema.properties).length} {t('skills:editor.params', '参数')}
                    </span>
                    <NotionButton
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTool(toolIndex);
                      }}
                      disabled={disabled}
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={12} />
                    </NotionButton>
                  </div>
                </div>

                <CollapsibleContent className="px-3 pb-3 space-y-4">
                  <div className="grid gap-3 pt-2 border-t border-border/20">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t('skills:editor.tool_name', '工具名称')} *
                      </Label>
                      <Input
                        value={tool.name}
                        onChange={(e) => updateTool(toolIndex, { name: (e.target as HTMLInputElement).value })}
                        placeholder="builtin-example_tool"
                        disabled={disabled}
                        className={cn(
                          'h-8 text-sm font-mono bg-muted/30 border-transparent',
                          !tool.name && 'border-amber-500/50'
                        )}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t('skills:editor.tool_description', '工具描述')} *
                      </Label>
                      <AutoResizeTextarea
                        value={tool.description}
                        onChange={(e) => updateTool(toolIndex, { description: (e.target as HTMLTextAreaElement).value })}
                        placeholder={t('skills:editor.tool_description_placeholder', '描述工具的功能和使用场景...')}
                        disabled={disabled}
                        minHeight={60}
                        className={cn(
                          'text-sm bg-muted/30 border-transparent resize-none',
                          !tool.description && 'border-amber-500/50'
                        )}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground">
                          {t('skills:editor.input_params', '输入参数')}
                        </Label>
                        <NotionButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addProperty(toolIndex)}
                          disabled={disabled}
                          className="h-6 text-xs"
                        >
                          <Plus size={12} className="mr-1" />
                          {t('skills:editor.add_param', '添加')}
                        </NotionButton>
                      </div>

                      {Object.keys(tool.inputSchema.properties).length === 0 ? (
                        <p className="text-xs text-muted-foreground/60 text-center py-2">
                          {t('skills:editor.no_params', '暂无参数')}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {Object.entries(tool.inputSchema.properties).map(([propName, prop]) => {
                            const isRequired = (tool.inputSchema.required || []).includes(propName);
                            return (
                              <div
                                key={propName}
                                className="grid grid-cols-[1fr_100px_auto_auto] gap-2 items-start p-2 bg-muted/20 rounded-md"
                              >
                                <div className="space-y-1">
                                  <Input
                                    value={propName}
                                    onChange={(e) => updateProperty(toolIndex, propName, (e.target as HTMLInputElement).value, {})}
                                    placeholder={t('skills:editor.param_name', '参数名')}
                                    disabled={disabled}
                                    className="h-7 text-xs font-mono bg-background/50"
                                  />
                                  <Input
                                    value={prop.description || ''}
                                    onChange={(e) => updateProperty(toolIndex, propName, propName, { description: (e.target as HTMLInputElement).value })}
                                    placeholder={t('skills:editor.param_description', '参数描述')}
                                    disabled={disabled}
                                    className="h-7 text-xs bg-background/50"
                                  />
                                </div>
                                <select
                                  value={prop.type || 'string'}
                                  onChange={(e) => updateProperty(toolIndex, propName, propName, { type: e.target.value as JsonSchemaProperty['type'] })}
                                  disabled={disabled}
                                  className="h-7 text-xs bg-background/50 border border-border/40 rounded-md px-2"
                                >
                                  <option value="string">string</option>
                                  <option value="number">number</option>
                                  <option value="integer">integer</option>
                                  <option value="boolean">boolean</option>
                                  <option value="array">array</option>
                                  <option value="object">object</option>
                                </select>
                                <NotionButton
                                  type="button"
                                  variant={isRequired ? 'default' : 'outline'}
                                  size="sm"
                                  onClick={() => toggleRequired(toolIndex, propName)}
                                  disabled={disabled}
                                  className="h-7 text-[10px] px-2"
                                  title={isRequired ? t('skills:editor.required', '必填') : t('skills:editor.optional', '可选')}
                                >
                                  {isRequired ? '*' : '?'}
                                </NotionButton>
                                <NotionButton
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeProperty(toolIndex, propName)}
                                  disabled={disabled}
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 size={12} />
                                </NotionButton>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/60">
        {t('skills:editor.embedded_tools_hint', '内嵌工具会在技能激活时注入到 LLM 请求中')}
      </p>
    </div>
  );
};

export default EmbeddedToolsEditor;
