import { describe, expect, it } from 'vitest';
import {
  DROP_CLOSEST_HYSTERESIS,
  DROP_TARGET_RADIUS,
  pickClosestDropTarget,
  resolveDropMode,
  resolveDropTarget,
  type DropCandidate,
} from '@/features/mindmap/utils/dropTarget';

const box = (id: string, x: number, y: number, w = 100, h = 40): DropCandidate => ({
  id,
  x,
  y,
  width: w,
  height: h,
});

describe('pickClosestDropTarget', () => {
  it('picks nearest within 150px radius', () => {
    const candidates = [box('a', 0, 0), box('b', 200, 0)];
    // drag center near a
    const r = pickClosestDropTarget(50, 20, candidates, null);
    expect(r.targetId).toBe('a');
  });

  it('returns null when all candidates beyond radius', () => {
    const candidates = [box('a', 0, 0)];
    const r = pickClosestDropTarget(400, 400, candidates, null);
    expect(r.targetId).toBeNull();
  });

  it('keeps previous target under closest hysteresis', () => {
    // a at (0,0) center (50,20); b at (30,0) center (80,20)
    const candidates = [box('a', 0, 0), box('b', 30, 0)];
    // drag at (70, 20): closer to b (dist 10) than a (dist 20)
    const raw = pickClosestDropTarget(70, 20, candidates, null);
    expect(raw.targetId).toBe('b');

    // with previous=a: prevDist=20, closestDist=10, 20 <= 10+24 → keep a
    const held = pickClosestDropTarget(70, 20, candidates, 'a');
    expect(held.targetId).toBe('a');
    expect(DROP_CLOSEST_HYSTERESIS).toBe(24);
  });

  it('switches when previous is clearly farther than hysteresis', () => {
    const candidates = [box('a', 0, 0), box('b', 80, 0)];
    // drag near b center (130,20)
    const held = pickClosestDropTarget(130, 20, candidates, 'a');
    expect(held.targetId).toBe('b');
  });

  it('drops previous when it leaves the radius', () => {
    const candidates = [box('a', 0, 0), box('b', 100, 0)];
    const r = pickClosestDropTarget(150, 20, candidates, 'a');
    // a center (50,20), dist from (150,20)=100 < 150, b center (150,20) dist=0
    // prevDist 100, closest 0, 100 <= 0+24? no → b
    expect(r.targetId).toBe('b');
  });
});

describe('resolveDropMode vertical thirds', () => {
  const target = box('t', 0, 0, 100, 100); // centerY=50, band=30

  it('maps upper / middle / lower bands', () => {
    expect(resolveDropMode(10, target, 'child', 0.3, 0)).toBe('sibling-before');
    expect(resolveDropMode(50, target, 'child', 0.3, 0)).toBe('child');
    expect(resolveDropMode(90, target, 'child', 0.3, 0)).toBe('sibling-after');
  });

  it('applies mode hysteresis near band edges', () => {
    // band=30, hyst=8 → from child, need relY < -38 to enter before
    expect(resolveDropMode(50 - 32, target, 'child')).toBe('child');
    expect(resolveDropMode(50 - 40, target, 'child')).toBe('sibling-before');

    // from sibling-before, stay until relY >= -band+hyst = -22
    expect(resolveDropMode(50 - 25, target, 'sibling-before')).toBe('sibling-before');
    expect(resolveDropMode(50 - 10, target, 'sibling-before')).toBe('child');
  });
});

describe('resolveDropTarget', () => {
  it('resets mode stickiness when target changes', () => {
    const candidates = [box('a', 0, 0, 100, 100), box('b', 0, 120, 100, 100)];
    // over a upper band while previous was sibling-after on b
    const r = resolveDropTarget({
      dragCenterX: 50,
      dragCenterY: 10,
      candidates,
      previousTargetId: 'b',
      previousMode: 'sibling-after',
      modeHysteresisRatio: 0,
    });
    expect(r.targetId).toBe('a');
    expect(r.mode).toBe('sibling-before');
  });

  it('preserves 150px radius constant', () => {
    expect(DROP_TARGET_RADIUS).toBe(150);
  });
});
