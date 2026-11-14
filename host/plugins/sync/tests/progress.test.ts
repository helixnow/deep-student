import { expect, it, vi } from 'vitest';
import { ProgressTracker, SpeedCalculator, displayName, isTerminal, progress, withCurrentItem, withPercent, withSpeed } from '../src/progress.ts';
import type { SyncProgress } from '../api.ts';

it('test_sync_phase_display_name', () => {
  expect(displayName('preparing')).toBe('准备中');
  expect(displayName('uploading')).toBe('上传中');
  expect(displayName('completed')).toBe('已完成');
});
it('test_sync_phase_is_terminal', () => {
  expect(isTerminal('preparing')).toBe(false);
  expect(isTerminal('uploading')).toBe(false);
  expect(isTerminal('completed')).toBe(true);
  expect(isTerminal('failed')).toBe(true);
});
it('test_sync_progress_builders', () => {
  expect(progress.preparing()).toMatchObject({ phase: 'preparing', percent: 0 });
  const uploading = progress.uploading(50, 100);
  expect(uploading).toMatchObject({ phase: 'uploading', current: 50, total: 100 });
  expect(uploading.percent).toBeGreaterThanOrEqual(60);
  expect(uploading.percent).toBeLessThanOrEqual(85);
  expect(progress.completed()).toMatchObject({ phase: 'completed', percent: 100 });
  expect(progress.failed('test error')).toMatchObject({ phase: 'failed', error: 'test error', outcome: 'failed' });
});
it('legacy_progress_deserializes_without_operation_metadata', () => {
  const value: SyncProgress = JSON.parse(JSON.stringify({ phase: 'preparing', percent: 0, current: 0, total: 0,
    current_item: null, speed_bytes_per_sec: null, eta_seconds: null, error: null }));
  expect(value.operation_id ?? null).toBeNull();
  expect(value.outcome ?? null).toBeNull();
});
it('test_sync_progress_with_methods', () => {
  const value = withPercent(withSpeed(withCurrentItem(progress.uploading(10, 100), 'file.txt'), 1024, 60), 25);
  expect(value).toMatchObject({ current_item: 'file.txt', speed_bytes_per_sec: 1024, eta_seconds: 60, percent: 25 });
});
it('test_speed_calculator_insufficient_samples', () => {
  const calc = new SpeedCalculator(5);
  expect(calc.calculateSpeed()).toBeNull();
  calc.addSample(100);
  expect(calc.calculateSpeed()).toBeNull();
});
it('test_speed_calculator_with_samples', () => {
  const clock = vi.spyOn(performance, 'now');
  try {
    const calc = new SpeedCalculator(5);
    clock.mockReturnValue(0); calc.addSample(0);
    clock.mockReturnValue(100); calc.addSample(1000);
    expect(calc.calculateSpeed()).not.toBeNull();
    expect(calc.calculateSpeed()).toBeGreaterThan(5000);
    expect(calc.calculateSpeed()).toBeLessThan(15000);
  } finally { clock.mockRestore(); }
});
it('test_speed_calculator_eta', () => {
  const clock = vi.spyOn(performance, 'now');
  try {
    const calc = new SpeedCalculator(5);
    clock.mockReturnValue(0); calc.addSample(0);
    clock.mockReturnValue(100); calc.addSample(1000);
    expect(calc.calculateEta(10000)).not.toBeNull();
    expect(calc.calculateEta(10000)).toBeLessThanOrEqual(3);
  } finally { clock.mockRestore(); }
});
it('test_speed_calculator_window_overflow', () => {
  const calc = new SpeedCalculator(3);
  [0, 100, 200, 300].forEach(value => calc.addSample(value));
  expect(calc.sampleCount()).toBe(3);
});
it('test_progress_tracker', () => {
  const tracker = new ProgressTracker();
  tracker.setTotalBytes(10000); tracker.setPhase('uploading');
  tracker.updateItems(0, 10); tracker.setCurrentItem('test.txt');
  expect(tracker.getProgress()).toMatchObject({ phase: 'uploading', total: 10, current_item: 'test.txt' });
  tracker.complete();
  expect(tracker.getProgress().phase).toBe('completed');
});
it('test_progress_tracker_fail', () => {
  const tracker = new ProgressTracker(); tracker.fail('Network error');
  expect(tracker.getProgress()).toMatchObject({ phase: 'failed', error: 'Network error' });
});
it('preserves every f32 arithmetic step and does not clamp builder progress', () => {
  const f = Math.fround;
  expect(progress.uploading(2, 3).percent).toBe(f(60 + f(f(f(2) / f(3)) * 25)));
  expect(progress.downloading(2, 0).percent).toBe(10);
  expect(progress.applying(10, 1).percent).toBe(240);
  expect(withPercent(progress.preparing(), 200).percent).toBe(100);
});
