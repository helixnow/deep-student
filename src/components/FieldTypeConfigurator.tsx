import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EnhancedFieldType,
  EnhancedFieldExtractionRule,
  ObjectSchema
} from '../types/enhanced-field-types';
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Settings,
  HelpCircle,
  AlertCircle
} from 'lucide-react';
import './FieldTypeConfigurator.css';
import { AppSelect } from './ui/app-menu';

interface FieldTypeConfiguratorProps {
  fields: string[];
  rules: Record<string, EnhancedFieldExtractionRule>;
  onChange: (rules: Record<string, EnhancedFieldExtractionRule>) => void;
}

const FieldTypeConfigurator: React.FC<FieldTypeConfiguratorProps> = ({
  fields,
  rules,
  onChange
}) => {
  const { t } = useTranslation('template');
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const [localRules, setLocalRules] = useState<Record<string, EnhancedFieldExtractionRule>>(rules);

  // 同步外部规则变化
  useEffect(() => {
    setLocalRules(rules);
  }, [rules]);

  // 字段类型选项 - 只包含 Anki 支持的类型
  const fieldTypeOptions = [
    { value: EnhancedFieldType.Text, label: t('field_type.text'), icon: '📝' },
    { value: EnhancedFieldType.Array, label: t('field_type.array'), icon: '📋' },
    { value: EnhancedFieldType.Number, label: t('field_type.number'), icon: '🔢' },
    { value: EnhancedFieldType.Boolean, label: t('field_type.boolean'), icon: '✅' },
    { value: EnhancedFieldType.Date, label: t('field_type.date'), icon: '📅' },
    { value: EnhancedFieldType.RichText, label: t('field_type.rich_text'), icon: '🎨' },
    { value: EnhancedFieldType.Formula, label: t('field_type.formula'), icon: '🧮' }
  ];

  // 切换字段展开状态
  const toggleFieldExpansion = (field: string) => {
    const newExpanded = new Set(expandedFields);
    if (newExpanded.has(field)) {
      newExpanded.delete(field);
    } else {
      newExpanded.add(field);
    }
    setExpandedFields(newExpanded);
  };

  // 更新字段规则
  const updateFieldRule = (field: string, rule: Partial<EnhancedFieldExtractionRule>) => {
    const newRules = {
      ...localRules,
      [field]: {
        ...localRules[field],
        ...rule
      }
    };
    setLocalRules(newRules);
    onChange(newRules);
  };

  // 初始化字段规则
  const initializeFieldRule = (field: string) => {
    if (!localRules[field]) {
      const defaultRule: EnhancedFieldExtractionRule = {
        field_type: EnhancedFieldType.Text,
        is_required: true,
        default_value: '',
        description: `${field} field content`
      };
      updateFieldRule(field, defaultRule);
    }
  };


  // 获取字段类型的帮助信息
  const getFieldTypeHelp = (type: EnhancedFieldType): string => {
    const helpMap: Record<EnhancedFieldType, string> = {
      [EnhancedFieldType.Text]: t('field_type_help.text'),
      [EnhancedFieldType.Array]: t('field_type_help.array'),
      [EnhancedFieldType.Number]: t('field_type_help.number'),
      [EnhancedFieldType.Boolean]: t('field_type_help.boolean'),
      [EnhancedFieldType.Date]: t('field_type_help.date'),
      [EnhancedFieldType.RichText]: t('field_type_help.rich_text'),
      [EnhancedFieldType.Formula]: t('field_type_help.formula')
    };
    return helpMap[type] || '';
  };

  return (
    <div className="field-type-configurator">
      <div className="configurator-header">
        <h3>
          <Settings size={20} />
          {t('field_type_configuration')}
        </h3>
        <p className="help-text">
          <HelpCircle size={14} />
          {t('field_type_configuration_help')}
        </p>
      </div>

      <div className="fields-list">
        {fields.map(field => {
          // 初始化规则
          if (!localRules[field]) {
            initializeFieldRule(field);
          }
          
          const rule = localRules[field];
          const isExpanded = expandedFields.has(field);
          const fieldType = rule?.field_type || EnhancedFieldType.Text;

          return (
            <div key={field} className="field-item">
              <div className="field-header" onClick={() => toggleFieldExpansion(field)}>
                <div className="field-info">
                  <span className="field-name">{field}</span>
                  <span className="field-type-badge">
                    {fieldTypeOptions.find(opt => opt.value === fieldType)?.icon}
                    {fieldTypeOptions.find(opt => opt.value === fieldType)?.label}
                  </span>
                  {rule?.is_required && (
                    <span className="required-badge">{t('required')}</span>
                  )}
                </div>
                <button className="expand-button">
                  {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>

              {isExpanded && (
                <div className="field-config">
                  {/* 字段类型选择 */}
                  <div className="config-group">
                    <label>{t('field_type_label')}</label>
                    <AppSelect value={fieldType} onValueChange={(v)=> updateFieldRule(field, { field_type: v as EnhancedFieldType })}
                      placeholder={t('field_type_label')}
                      options={fieldTypeOptions.map(option => ({ value: option.value, label: `${option.icon} ${option.label}` }))}
                      variant="outline"
                      width={240}
                    />
                    <small className="field-help">{getFieldTypeHelp(fieldType)}</small>
                  </div>

                  {/* 必填设置 */}
                  <div className="config-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={rule?.is_required || false}
                        onChange={(e) => updateFieldRule(field, {
                          is_required: e.target.checked
                        })}
                      />
                      {t('field_required')}
                    </label>
                  </div>

                  {/* 描述 */}
                  <div className="config-group">
                    <label>{t('field_description_label')}</label>
                    <input
                      type="text"
                      value={rule?.description || ''}
                      onChange={(e) => updateFieldRule(field, {
                        description: e.target.value
                      })}
                      placeholder={t('field_description_placeholder')}
                    />
                  </div>

                  {/* 默认值 */}
                  <div className="config-group">
                    <label>{t('field_default_value')}</label>
                    {fieldType === EnhancedFieldType.Boolean ? (
                      <AppSelect value={String(rule?.default_value || false)} onValueChange={(v)=> updateFieldRule(field, { default_value: v === 'true' })}
                        options={[
                          { value: 'false', label: 'False' },
                          { value: 'true', label: 'True' },
                        ]}
                        variant="outline"
                        width={120}
                      />
                    ) : fieldType === EnhancedFieldType.Number ? (
                      <input
                        type="number"
                        value={rule?.default_value || 0}
                        onChange={(e) => updateFieldRule(field, {
                          default_value: Number(e.target.value)
                        })}
                      />
                    ) : (
                      <input
                        type="text"
                        value={rule?.default_value || ''}
                        onChange={(e) => updateFieldRule(field, {
                          default_value: e.target.value
                        })}
                        placeholder={t('field_default_placeholder')}
                      />
                    )}
                  </div>

                  {/* AI提示 */}
                  <div className="config-group">
                    <label>{t('field_ai_hint')}</label>
                    <textarea
                      value={rule?.ai_hint || ''}
                      onChange={(e) => updateFieldRule(field, {
                        ai_hint: e.target.value
                      })}
                      placeholder={t('field_ai_hint_placeholder')}
                      rows={2}
                    />
                  </div>


                  {/* 验证规则 */}
                  {(fieldType === EnhancedFieldType.Text || 
                    fieldType === EnhancedFieldType.Number) && (
                    <div className="validation-rules">
                      <h4>{t('validation_rules')}</h4>
                      {fieldType === EnhancedFieldType.Text && (
                        <>
                          <div className="config-group">
                            <label>{t('max_length')}</label>
                            <input
                              type="number"
                              value={rule?.max_length || ''}
                              onChange={(e) => updateFieldRule(field, {
                                max_length: e.target.value ? Number(e.target.value) : undefined
                              })}
                              placeholder={t('no_limit', 'No limit')}
                            />
                          </div>
                          <div className="config-group">
                            <label>{t('pattern')}</label>
                            <input
                              type="text"
                              value={rule?.validation?.pattern || ''}
                              onChange={(e) => updateFieldRule(field, {
                                validation: {
                                  ...rule?.validation,
                                  pattern: e.target.value
                                }
                              })}
                              placeholder="e.g., ^[A-Za-z]+$"
                            />
                          </div>
                        </>
                      )}
                      {fieldType === EnhancedFieldType.Number && (
                        <>
                          <div className="config-group">
                            <label>{t('min_value')}</label>
                            <input
                              type="number"
                              value={rule?.validation?.min || ''}
                              onChange={(e) => updateFieldRule(field, {
                                validation: {
                                  ...rule?.validation,
                                  min: e.target.value ? Number(e.target.value) : undefined
                                }
                              })}
                            />
                          </div>
                          <div className="config-group">
                            <label>{t('max_value')}</label>
                            <input
                              type="number"
                              value={rule?.validation?.max || ''}
                              onChange={(e) => updateFieldRule(field, {
                                validation: {
                                  ...rule?.validation,
                                  max: e.target.value ? Number(e.target.value) : undefined
                                }
                              })}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="configurator-footer">
        <p className="warning-text">
          <AlertCircle size={14} />
          {t('complex_template_warning')}
        </p>
      </div>
    </div>
  );
};

export default FieldTypeConfigurator;
