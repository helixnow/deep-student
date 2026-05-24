import React, { useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { X, Plus, Funnel as FilterIcon } from '@phosphor-icons/react';
import { generateId } from '../../utils/common';
import './FilterBuilder.css';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';

interface Funnel {
  id: string;
  type: string;
  field?: string;
  operator?: string;
  value?: any;
}

interface FilterBuilderProps {
  filters: Funnel[];
  onApply: (filters: Funnel[]) => void;
  onClose: () => void;
}

const FilterBuilder: React.FC<FilterBuilderProps> = ({ filters, onApply, onClose }) => {
  const { t } = useTranslation('anki');
  const [localFilters, setLocalFilters] = useState<Funnel[]>(filters);
  
  const filterTypes = [
    { value: 'content', label: t('filter_content') },
    { value: 'tag', label: t('filter_tag') },
    { value: 'date', label: t('filter_date') },
    { value: 'has_image', label: t('filter_has_image') },
    { value: 'no_tags', label: t('filter_no_tags') },
  ];
  
  const operators = {
    content: [
      { value: 'contains', label: t('operator_contains') },
      { value: 'not_contains', label: t('operator_not_contains') },
    ],
    tag: [
      { value: 'contains', label: t('operator_contains') },
      { value: 'not_contains', label: t('operator_not_contains') },
      { value: 'equals', label: t('operator_equals') },
    ],
    date: [
      { value: 'after', label: t('operator_after') },
      { value: 'before', label: t('operator_before') },
      { value: 'on', label: t('operator_on') },
    ],
  };
  
  const addFilter = () => {
    const newFilter: Funnel = {
      id: generateId(),
      type: 'content',
      operator: 'contains',
      value: ''
    };
    setLocalFilters([...localFilters, newFilter]);
  };
  
  const updateFilter = (id: string, updates: Partial<Funnel>) => {
    setLocalFilters(localFilters.map(filter => 
      filter.id === id ? { ...filter, ...updates } : filter
    ));
  };
  
  const removeFilter = (id: string) => {
    setLocalFilters(localFilters.filter(filter => filter.id !== id));
  };
  
  const handleApply = () => {
    // 清理空值过滤器
    const validFilters = localFilters.filter(filter => {
      if (filter.type === 'has_image' || filter.type === 'no_tags') {
        return true;
      }
      return filter.value !== '' && filter.value !== undefined;
    });
    onApply(validFilters);
  };
  
  return (
    <div className="filter-builder-overlay" onClick={onClose}>
      <div className="filter-builder" onClick={(e) => e.stopPropagation()}>
        <div className="filter-builder-header">
          <h3>
            <FilterIcon size={20} />
            {t('filter_builder_title')}
          </h3>
          <NotionButton variant="ghost" size="icon" iconOnly className="close-btn" onClick={onClose} aria-label="close">
            <X size={20} />
          </NotionButton>
        </div>
        
        <div className="filter-builder-body">
          {localFilters.length === 0 ? (
            <div className="no-filters">
              <p>{t('no_filters_message')}</p>
            </div>
          ) : (
            <div className="filter-list">
              {localFilters.map((filter, index) => (
                <div key={filter.id} className="filter-item">
                  <div className="filter-row">
                    {index > 0 && (
                      <div className="filter-connector">{t('and')}</div>
                    )}
                    
                    <Select
                      value={filter.type}
                      onValueChange={(value) => {
                        updateFilter(filter.id, {
                          type: value,
                          operator: operators[value]?.[0]?.value || undefined,
                          value: ''
                        });
                      }}
                    >
                      <SelectTrigger className="filter-type-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {filterTypes.map(type => (
                          <SelectItem key={type.value} value={type.value}>
                            {type.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    {operators[filter.type] && (
                      <Select
                        value={filter.operator}
                        onValueChange={(value) => updateFilter(filter.id, { operator: value })}
                      >
                        <SelectTrigger className="filter-operator-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {operators[filter.type].map(op => (
                            <SelectItem key={op.value} value={op.value}>
                              {op.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    
                    {filter.type !== 'has_image' && filter.type !== 'no_tags' && (
                      <>
                        {filter.type === 'date' ? (
                          <Input
                            type="date"
                            value={filter.value || ''}
                            onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                            className="filter-value-input"
/>
                        ) : (
                          <Input
                            type="text"
                            value={filter.value || ''}
                            onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                            placeholder={t('filter_value_placeholder')}
                            className="filter-value-input"
/>
                        )}
                      </>
                    )}
                    
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => removeFilter(filter.id)} className="filter-remove-btn" title={t('remove_filter')} aria-label="remove">
                      <X size={16} />
                    </NotionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <NotionButton variant="ghost" size="sm" onClick={addFilter} className="add-filter-btn">
            <Plus size={16} />
            {t('add_filter')}
          </NotionButton>
        </div>
        
        <div className="filter-builder-footer">
          <NotionButton variant="default" size="sm" className="btn-secondary" onClick={onClose}>
            {t('cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" className="btn-primary" onClick={handleApply}>
            {t('apply_filters')}
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

export default FilterBuilder;