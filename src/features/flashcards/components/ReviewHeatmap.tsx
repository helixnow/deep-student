/**
 * GitHub 风格年度复习热力图（纯 CSS grid，无第三方图表库）。
 * 数据为「每张卡最近一次复习」的按日聚合近似，由调用方给出。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { addDays, localDayKey } from '../hooks/useReviewActivity';

const WEEKS = 53;

interface HeatDay {
  key: string;
  date: Date;
  count: number;
  /** 0..4 强度档 */
  level: number;
  inRange: boolean;
}

export interface ReviewHeatmapProps {
  dayCounts: Map<string, number>;
}

function buildWeeks(dayCounts: Map<string, number>): { weeks: HeatDay[][]; max: number } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 周一为每列首行；末列为本周
  const mondayOffset = (today.getDay() + 6) % 7;
  const lastMonday = addDays(today, -mondayOffset);
  const firstMonday = addDays(lastMonday, -7 * (WEEKS - 1));

  let max = 0;
  const weeks: HeatDay[][] = [];
  for (let w = 0; w < WEEKS; w += 1) {
    const week: HeatDay[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(firstMonday, w * 7 + d);
      const key = localDayKey(date);
      const inRange = date.getTime() <= today.getTime();
      const count = inRange ? dayCounts.get(key) ?? 0 : 0;
      if (count > max) max = count;
      week.push({ key, date, count, level: 0, inRange });
    }
    weeks.push(week);
  }
  if (max > 0) {
    for (const week of weeks) {
      for (const day of week) {
        if (day.count > 0) {
          day.level = Math.max(1, Math.min(4, Math.ceil((day.count / max) * 4)));
        }
      }
    }
  }
  return { weeks, max };
}

export const ReviewHeatmap: React.FC<ReviewHeatmapProps> = ({ dayCounts }) => {
  const { t, i18n } = useTranslation('flashcards');
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const { weeks } = useMemo(() => buildWeeks(dayCounts), [dayCounts]);

  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short' }),
    [i18n.language],
  );
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }),
    [i18n.language],
  );

  // 首次渲染滚动到最右（当前周）
  useEffect(() => {
    if (scrollViewport) scrollViewport.scrollLeft = scrollViewport.scrollWidth;
  }, [scrollViewport]);

  const monthLabels = useMemo(() => {
    const labels: Array<{ week: number; label: string }> = [];
    let previousMonth = -1;
    weeks.forEach((week, index) => {
      const month = week[0].date.getMonth();
      if (month !== previousMonth) {
        // 跳过第一列的残月标签，避免与第二列新月标签挤在一起
        if (index > 0 || week[0].date.getDate() <= 7) {
          labels.push({ week: index, label: monthFormat.format(week[0].date) });
        }
        previousMonth = month;
      }
    });
    return labels;
  }, [weeks, monthFormat]);

  return (
    <CustomScrollArea
      className="wb-fcx-heatmap"
      viewportRef={setScrollViewport}
      orientation="horizontal"
      fullHeight={false}
    >
      <div className="wb-fcx-heatmap-inner">
        <div className="wb-fcx-heat-months" aria-hidden="true">
          {monthLabels.map((item) => (
            <span
              key={`${item.week}-${item.label}`}
              className="wb-fcx-heat-month"
              style={{ gridColumnStart: item.week + 1 }}
            >
              {item.label}
            </span>
          ))}
        </div>
        <div className="wb-fcx-heat-grid">
          {weeks.map((week) => (
            <div key={week[0].key} className="wb-fcx-heat-week">
              {week.map((day) => (
                <div
                  key={day.key}
                  className="wb-fcx-heat-cell"
                  data-level={day.level}
                  data-future={day.inRange ? undefined : 'true'}
                  title={
                    day.inRange
                      ? t('stats.heatmap.cell', {
                          date: dateFormat.format(day.date),
                          count: day.count,
                        })
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>
        <div className="wb-fcx-heat-legend" aria-hidden="true">
          <span>{t('stats.heatmap.legendLess')}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="wb-fcx-heat-cell" data-level={level} />
          ))}
          <span>{t('stats.heatmap.legendMore')}</span>
        </div>
      </div>
    </CustomScrollArea>
  );
};
