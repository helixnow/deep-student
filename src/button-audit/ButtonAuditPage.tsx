import React, { useMemo, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { AUDIT_FAMILIES, allAuditItems } from './catalog';
import { Sample } from './Samples';
import { CONTROL_TYPE_GROUPS, allControlItems } from './controlCatalog';
import { ControlSample } from './ControlSamples';

type AuditTab = 'buttons' | 'controls';

const BUTTON_STORAGE = 'ds-button-audit-v1';
const CONTROL_STORAGE = 'ds-control-audit-v1';

function loadDiscarded(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { discard?: string[] };
    return new Set(parsed.discard ?? []);
  } catch {
    return new Set();
  }
}

function readTab(): AuditTab {
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'controls' ? 'controls' : 'buttons';
}

function writeTab(tab: AuditTab) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState(null, '', url);
}

function useDiscarded(storageKey: string, itemIds: string[]) {
  const [discarded, setDiscarded] = useState<Set<string>>(() => loadDiscarded(storageKey));

  const persist = (next: Set<string>) => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      discard: [...next],
      keep: itemIds.filter((id) => !next.has(id)),
    }));
  };

  const applyDiscarded = (updater: (prev: Set<string>) => Set<string>) => {
    setDiscarded((prev) => {
      const next = updater(prev);
      persist(next);
      return next;
    });
  };

  const toggle = (id: string, keep: boolean) => {
    applyDiscarded((prev) => {
      const next = new Set(prev);
      if (keep) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setFamily = (ids: string[], keep: boolean) => {
    applyDiscarded((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (keep) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const setAll = (keep: boolean) => {
    const next = keep ? new Set<string>() : new Set(itemIds);
    setDiscarded(next);
    persist(next);
  };

  return { discarded, toggle, setFamily, setAll };
}

export function ButtonAuditPage() {
  const [tab, setTab] = useState<AuditTab>(() => readTab());
  const [filter, setFilter] = useState<'all' | 'keep' | 'discard'>('all');
  const [copied, setCopied] = useState(false);
  const [copiedFamily, setCopiedFamily] = useState<string | null>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const buttonItems = useMemo(() => allAuditItems(), []);
  const controlItems = useMemo(() => allControlItems(), []);
  const buttons = useDiscarded(BUTTON_STORAGE, buttonItems.map((item) => item.id));
  const controls = useDiscarded(CONTROL_STORAGE, controlItems.map((item) => item.id));
  const active = tab === 'buttons' ? buttons : controls;
  const items = tab === 'buttons' ? buttonItems : controlItems;
  const keepCount = items.length - active.discarded.size;

  const switchTab = (next: AuditTab) => {
    setTab(next);
    writeTab(next);
    document.title = next === 'controls' ? '控件样式裁定' : '按钮样式裁定';
  };

  const buildButtonJson = () => {
    const keep = [];
    const discard = [];
    for (const family of AUDIT_FAMILIES) {
      for (const item of family.items) {
        const row = {
          id: item.id,
          familyId: family.id,
          family: family.title,
          label: item.label,
          freq: family.freq,
          keep: !buttons.discarded.has(item.id),
        };
        if (row.keep) keep.push(row);
        else discard.push(row);
      }
    }
    return {
      kind: 'buttons',
      version: 1,
      copiedAt: new Date().toISOString(),
      summary: { total: buttonItems.length, keep: keep.length, discard: discard.length },
      keep,
      discard,
    };
  };

  const buildControlJson = () => {
    const keep = [];
    const discard = [];
    for (const group of CONTROL_TYPE_GROUPS) {
      for (const family of group.families) {
        for (const item of family.items) {
          const row = {
            id: item.id,
            typeId: group.id,
            type: group.title,
            familyId: family.id,
            family: family.title,
            label: item.label,
            freq: family.freq,
            keep: !controls.discarded.has(item.id),
          };
          if (row.keep) keep.push(row);
          else discard.push(row);
        }
      }
    }
    return {
      kind: 'controls',
      version: 1,
      copiedAt: new Date().toISOString(),
      summary: { total: controlItems.length, keep: keep.length, discard: discard.length },
      keep,
      discard,
    };
  };

  const copyJson = async () => {
    const payload = tab === 'buttons' ? buildButtonJson() : buildControlJson();
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
  };

  const copyFamilyName = async (familyId: string, name: string) => {
    await navigator.clipboard.writeText(name);
    setCopiedFamily(familyId);
    window.setTimeout(() => {
      setCopiedFamily((current) => (current === familyId ? null : current));
    }, 1200);
  };

  return (
    <div className="ba-page">
      <div className="ba-sticky">
        <div className="ba-tabs" role="tablist" aria-label="裁定分类">
          <DsButton
            size="sm"
            variant="ghost"
            role="tab"
            aria-selected={tab === 'buttons'}
            aria-pressed={tab === 'buttons'}
            onClick={() => switchTab('buttons')}
          >
            按钮
          </DsButton>
          <DsButton
            size="sm"
            variant="ghost"
            role="tab"
            aria-selected={tab === 'controls'}
            aria-pressed={tab === 'controls'}
            onClick={() => switchTab('controls')}
          >
            其他控件
          </DsButton>
        </div>
        <DsButton size="sm" variant="ghost" onClick={() => void copyJson()}>
          {copied ? '已复制' : '复制裁定 JSON'}
        </DsButton>
        <DsButton size="sm" variant="outline" onClick={() => active.setAll(true)}>全部保留</DsButton>
        <DsButton size="sm" variant="danger" onClick={() => active.setAll(false)}>全部打叉</DsButton>
        <DsButton size="sm" variant="ghost" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</DsButton>
        <DsButton size="sm" variant="ghost" aria-pressed={filter === 'keep'} onClick={() => setFilter('keep')}>只看保留</DsButton>
        <DsButton size="sm" variant="ghost" aria-pressed={filter === 'discard'} onClick={() => setFilter('discard')}>只看打叉</DsButton>
        <DsButton size="sm" variant="ghost" onClick={toggleTheme}>{dark ? '浅色' : '深色'}</DsButton>
        <span className="ba-count">保留 {keepCount} / {items.length}　打叉 {active.discarded.size}</span>
      </div>

      {tab === 'buttons' ? (
        <>
          <h1 style={{ fontSize: 22, fontWeight: 650, margin: '0 0 6px' }}>按钮样式裁定</h1>
          <p className="ba-note" style={{ marginBottom: 20 }}>
            按出现频率从高到低。上面是样例（含全部子变体），下面勾「保留」；取消勾选即打叉淘汰。
            结果可一键复制 JSON 发回。选择会记在本机 localStorage。
          </p>
          {AUDIT_FAMILIES.map((family) => {
            const visible = family.items.filter((item) => {
              const kept = !buttons.discarded.has(item.id);
              if (filter === 'keep') return kept;
              if (filter === 'discard') return !kept;
              return true;
            });
            if (visible.length === 0) return null;
            const familyIds = family.items.map((item) => item.id);
            const discardedInFamily = familyIds.filter((id) => buttons.discarded.has(id)).length;
            const familyAllKept = discardedInFamily === 0;
            const familyAllDiscarded = discardedInFamily === familyIds.length;
            const wide = family.items.some((item) => item.spec.kind === 'widget' && (item.spec.widget === 'rating-bar' || item.spec.widget === 'tabs-default' || item.spec.widget === 'tabs-bare' || item.spec.widget === 'segmented' || item.spec.widget === 'nav-row'));
            return (
              <section key={family.id} className={familyAllDiscarded ? 'ba-family is-discard' : 'ba-family'}>
                <div className="ba-family-head">
                  <button
                    type="button"
                    className="ba-family-title"
                    title="点击复制族名称"
                    onClick={() => void copyFamilyName(family.id, family.title)}
                  >
                    {copiedFamily === family.id ? '已复制' : family.title}
                  </button>
                  <span className="ba-freq">{family.freqLabel}</span>
                  <div className="ba-family-actions">
                    <label className="ba-keep">
                      <input
                        type="checkbox"
                        checked={familyAllKept}
                        ref={(node) => {
                          if (node) node.indeterminate = !familyAllKept && !familyAllDiscarded;
                        }}
                        onChange={(event) => buttons.setFamily(familyIds, event.target.checked)}
                      />
                      整族保留
                    </label>
                    <DsButton size="sm" variant="ghost" onClick={() => buttons.setFamily(familyIds, false)}>整族打叉</DsButton>
                  </div>
                </div>
                <p className="ba-note">{family.note}</p>
                <p className="ba-source">{family.source}</p>
                <div className={wide ? 'ba-grid ba-wide' : 'ba-grid'}>
                  {visible.map((item) => {
                    const kept = !buttons.discarded.has(item.id);
                    return (
                      <div key={item.id} className={kept ? 'ba-card' : 'ba-card is-discard'}>
                        <div className="ba-sample">
                          <Sample spec={item.spec} />
                          <span className="ba-x" aria-hidden>×</span>
                        </div>
                        <div className="ba-label">{item.label}</div>
                        <label className="ba-keep">
                          <input
                            type="checkbox"
                            checked={kept}
                            onChange={(event) => buttons.toggle(item.id, event.target.checked)}
                          />
                          保留
                        </label>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, fontWeight: 650, margin: '0 0 6px' }}>其他控件样式裁定</h1>
          <p className="ba-note" style={{ marginBottom: 12 }}>
            按控件类型分组，按钮族不在这里。弹窗/菜单/提示是缩略静态壳，避免盖住页面。
            勾「保留」或整族打叉，JSON 会带上 type。选择记在单独的 localStorage 键。
          </p>
          <nav className="ba-jumps" aria-label="类型跳转">
            {CONTROL_TYPE_GROUPS.map((group) => (
              <a key={group.id} href={`#type-${group.id}`}>{group.title}</a>
            ))}
          </nav>
          {CONTROL_TYPE_GROUPS.map((group) => {
            const visibleFamilies = group.families
              .map((family) => ({
                family,
                visible: family.items.filter((item) => {
                  const kept = !controls.discarded.has(item.id);
                  if (filter === 'keep') return kept;
                  if (filter === 'discard') return !kept;
                  return true;
                }),
              }))
              .filter((entry) => entry.visible.length > 0);
            if (visibleFamilies.length === 0) return null;
            return (
              <section key={group.id} id={`type-${group.id}`} className="ba-type">
                <h2 className="ba-type-title">{group.title}</h2>
                <p className="ba-note">{group.note}</p>
                {visibleFamilies.map(({ family, visible }) => {
                  const familyIds = family.items.map((item) => item.id);
                  const discardedInFamily = familyIds.filter((id) => controls.discarded.has(id)).length;
                  const familyAllKept = discardedInFamily === 0;
                  const familyAllDiscarded = discardedInFamily === familyIds.length;
                  return (
                    <div key={family.id} className={familyAllDiscarded ? 'ba-family is-discard' : 'ba-family'}>
                      <div className="ba-family-head">
                        <button
                          type="button"
                          className="ba-family-title"
                          title="点击复制族名称"
                          onClick={() => void copyFamilyName(family.id, family.title)}
                        >
                          {copiedFamily === family.id ? '已复制' : family.title}
                        </button>
                        <span className="ba-freq">{family.freqLabel}</span>
                        <div className="ba-family-actions">
                          <label className="ba-keep">
                            <input
                              type="checkbox"
                              checked={familyAllKept}
                              ref={(node) => {
                                if (node) node.indeterminate = !familyAllKept && !familyAllDiscarded;
                              }}
                              onChange={(event) => controls.setFamily(familyIds, event.target.checked)}
                            />
                            整族保留
                          </label>
                          <DsButton size="sm" variant="ghost" onClick={() => controls.setFamily(familyIds, false)}>整族打叉</DsButton>
                        </div>
                      </div>
                      <p className="ba-note">{family.note}</p>
                      <p className="ba-source">{family.source}</p>
                      <div className={family.wide ? 'ba-grid ba-wide' : 'ba-grid'}>
                        {visible.map((item) => {
                          const kept = !controls.discarded.has(item.id);
                          return (
                            <div key={item.id} className={kept ? 'ba-card' : 'ba-card is-discard'}>
                              <div className={family.wide ? 'ba-sample ba-sample-fill' : 'ba-sample'}>
                                <ControlSample widget={item.widget} />
                                <span className="ba-x" aria-hidden>×</span>
                              </div>
                              <div className="ba-label">{item.label}</div>
                              <label className="ba-keep">
                                <input
                                  type="checkbox"
                                  checked={kept}
                                  onChange={(event) => controls.toggle(item.id, event.target.checked)}
                                />
                                保留
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

export default ButtonAuditPage;
