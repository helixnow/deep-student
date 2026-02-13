import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Filter as FilterIcon } from 'lucide-react';
import { generateId } from '../../utils/common';
import './FilterBuilder.css';

interface Filter {
  id: string;
  type: string;
  field?: string;
  operator?: string;
  value?: any;
}

interface FilterBuilderProps {
  filters: Filter[];
  onApply: (filters: Filter[]) => void;
  onClose: () => void;
}

const FilterBuilder: React.FC<FilterBuilderProps> = ({ filters, onApply, onClose }) => {
  const { t } = useTranslation('anki');
  const [localFilters, setLocalFilters] = useState<Filter[]>(filters);
  
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
    const newFilter: Filter = {
      id: generateId(),
      type: 'content',
      operator: 'contains',
      value: ''
    };
    setLocalFilters([...localFilters, newFilter]);
  };
  
  const updateFilter = (id: string, updates: Partial<Filter>) => {
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
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
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
                    
                    <select
                      value={filter.type}
                      onChange={(e) => {
                        const newType = e.target.value;
                        updateFilter(filter.id, {
                          type: newType,
                          operator: operators[newType]?.[0]?.value || undefined,
                          value: ''
                        });
                      }}
                      className="filter-type-select"
                    >
                      {filterTypes.map(type => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                    
                    {operators[filter.type] && (
                      <select
                        value={filter.operator}
                        onChange={(e) => updateFilter(filter.id, { operator: e.target.value })}
                        className="filter-operator-select"
                      >
                        {operators[filter.type].map(op => (
                          <option key={op.value} value={op.value}>
                            {op.label}
                          </option>
                        ))}
                      </select>
                    )}
                    
                    {filter.type !== 'has_image' && filter.type !== 'no_tags' && (
                      <>
                        {filter.type === 'date' ? (
                          <input
                            type="date"
                            value={filter.value || ''}
                            onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                            className="filter-value-input"
                          />
                        ) : (
                          <input
                            type="text"
                            value={filter.value || ''}
                            onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                            placeholder={t('filter_value_placeholder')}
                            className="filter-value-input"
                          />
                        )}
                      </>
                    )}
                    
                    <button
                      onClick={() => removeFilter(filter.id)}
                      className="filter-remove-btn"
                      title={t('remove_filter')}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <button onClick={addFilter} className="add-filter-btn">
            <Plus size={16} />
            {t('add_filter')}
          </button>
        </div>
        
        <div className="filter-builder-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleApply}>
            {t('apply_filters')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FilterBuilder;