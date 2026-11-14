import { project } from '../../lib/camera';
import { ease, lerp, prog } from '../../lib/time';
import { CW } from '../../ui/classic';
import { dockIconCenter } from '../../ui/workbench';
import { PR } from '../practice/beats';
import { classicCam } from '../SceneClassic';

/**
 * 「复习这批」→ 工作台的交接：经典窗口缩进 Dock 的对话图标，
 * 夜色以窗口为圆心收拢（光圈），收拢完时工作台已就位。
 */
export const MIN0 = PR.reviewClick + 0.04;
export const MIN1 = 16.62;
export const FREEZE = PR.reviewClick + 0.1;

export const minimizeAt = (t: number) => {
  const cam = classicCam(FREEZE);
  const c0 = project(cam, CW.w / 2, CW.h / 2);
  const to = dockIconCenter('chat');
  const s1 = 42 / (CW.w * cam.zoom);
  const k = prog(t, MIN0, MIN1);
  const e = ease.inOutCubic(k);
  const s = Math.exp(Math.log(s1) * e);
  return {
    k,
    c0,
    x: lerp(c0.x, to.x, e),
    y: lerp(c0.y, to.y, ease.inCubic(k)),
    sx: s,
    sy: s * (1 - 0.22 * Math.sin(Math.PI * k) * k),
  };
};
