import { useThree } from '@react-three/fiber';
import { DepthOfField, EffectComposer, Vignette } from '@react-three/postprocessing';
import { ThreeCanvas } from '@remotion/three';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { AbsoluteFill } from 'remotion';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { clamp, ease, HEIGHT, keys, PACE, prog, springAt, WIDTH } from '../../lib/time';
import { S } from '../../strings';
import { font } from '../../theme';
import {
  applyCam,
  camAtT,
  camLocal,
  camPose,
  cards,
  FOV,
  HIT_BASE,
  HIT_D,
  HIT_H,
  HIT_SLOT_X,
  HIT_SLOT_Y,
  HIT_W,
  hitScreenRect,
  probePos,
  PROBE_REST,
  pulseOrigin,
  PULSE_SPEED,
  PULSES,
  STRIP_D,
  strip3D,
  type Card,
} from './archive';
import { renderDpr, useArchiveAssets, type ArchiveAssets } from './assets';
import { BAR, barLen, cellRGB, cellValue, HITS, RV, STRIP } from './beats';
import type { CardType } from './textures';

// ── 时间曲线 ──────────────────────────────────────────
// 开场与 DOM 一样是白底（匹配剪辑无缝），资料展开时褪成浅灰纸面，退场回白交给界面
const space = (t: number) => keys(t, [[RV.cut, 0], [RV.probe, 0], [7.36, 1, ease.inOutCubic], [8.12, 1], [8.36, 0, ease.inOutCubic]]);
const fogNear = (t: number) => keys(t, [[RV.cut, 3.2], [RV.probe, 3.2], [7.42, 6, ease.outCubic], [8.14, 6], [8.36, 4.7, ease.inOutCubic]]);
// 退场：雾向镜头合拢，只留命中卡（命中卡在 fog.near 以内不受雾影响）
const fogFar = (t: number) => keys(t, [[RV.cut, 3.4], [RV.probe, 3.4], [7.42, 68, ease.outCubic], [8.14, 68], [8.36, 5, ease.inOutCubic]]);
const bokeh = (t: number) => keys(t, [[RV.cut, 0], [7.16, 0], [7.36, 2.6], [8.2, 2.6], [8.36, 0]]);
const vignette = (t: number) => keys(t, [[RV.cut, 0], [7.2, 0.22], [8.12, 0.22], [8.36, 0]]);
const extractK = (t: number, i: number) => springAt(t, RV.extract + i * 0.06, { stiffness: 150, damping: 21 });

const SRGB = THREE.SRGBColorSpace;
const rgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, SRGB);
const WHITE = new THREE.Color(1, 1, 1);
const SPACE = rgb(233, 236, 241);
const PRIMARY = rgb(30, 94, 184);
const PRIMARY_SOFT = rgb(118, 158, 222);
const TINT = rgb(214, 228, 250);
const SHADOW = rgb(24, 34, 54);
const smooth = (a: number, b: number, x: number) => {
  const k = clamp((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};

// ── 纹理 ──────────────────────────────────────────────
export const canvasTex = (c: HTMLCanvasElement) => {
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = SRGB;
  tx.anisotropy = 16;
  return tx;
};
const paint = (w: number, h: number, fn: (g: CanvasRenderingContext2D) => void) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  fn(c.getContext('2d')!);
  return canvasTex(c);
};
const radialTex = () =>
  paint(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  });
/** 软边圆角矩形（阴影 / 光晕平面的 alpha）：边缘按 blur 渐隐。 */
const softRectTex = (blur: number) =>
  paint(256, 256, (g) => {
    g.filter = `blur(${blur}px)`;
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(blur * 2.2, blur * 2.2, 256 - blur * 4.4, 256 - blur * 4.4, 14);
    g.fill();
  });
/** 柔边环带：波前用，内外都渐隐，不是一根细线。 */
const ringTex = () =>
  paint(512, 512, (g) => {
    const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0)');
    gr.addColorStop(0.9, 'rgba(255,255,255,0.5)');
    gr.addColorStop(0.955, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 512, 512);
  });
const pillTex = () =>
  paint(32, 128, (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(0, 0, 32, 128, 16);
    g.fill();
  });

/** 纸片：受光的标准材质，逐实例 aTint（相关 → 浅蓝）与 aFade（不相关 → 褪向雾色）。 */
const paperMaterial = (map: THREE.Texture) => {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTint = { value: TINT };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade;\nattribute float aTint;\nvarying float vFade;\nvarying float vTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;\nvTint = aTint;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTint;\nvarying float vFade;\nvarying float vTint;')
      .replace('#include <opaque_fragment>', 'outgoingLight *= mix(vec3(1.0), uTint, vTint);\n#include <opaque_fragment>')
      .replace('#include <fog_fragment>', '#include <fog_fragment>\n#ifdef USE_FOG\ngl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, vFade);\n#endif');
  };
  return m;
};

/** 软阴影 / 光晕：不写深度的透明平面，逐实例 aAlpha。 */
const alphaMaterial = (map: THREE.Texture, color: THREE.Color, fog: boolean) => {
  const m = new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false, toneMapped: false, fog });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
  };
  return m;
};
const instancedFloat = (geom: THREE.BufferGeometry, name: string, n: number) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  a.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute(name, a);
  return a;
};

// ── 每张纸片的逐帧状态 ────────────────────────────────
const pulseFlash = (pos: THREE.Vector3, t: number) => {
  let f = 0;
  for (let k = 0; k < PULSES.length; k++) {
    const age = t - PULSES[k];
    if (age <= 0) continue;
    const d = pulseOrigin(k).distanceTo(pos);
    const x = (d - age * PULSE_SPEED) / 5;
    f = Math.max(f, Math.exp(-x * x) * Math.exp(-age * 1.1));
  }
  return f;
};

type CardFx = { pos: THREE.Vector3; rot: THREE.Euler; tint: number; fade: number; halo: number; shadow: number };
const _v = new THREE.Vector3();
const cardState = (c: Card, t: number, out: CardFx) => {
  const sway = t * PACE;
  out.pos.set(c.pos.x + Math.sin(sway * 0.5 + c.phase) * 0.05, c.pos.y + Math.cos(sway * 0.43 + c.phase) * 0.05, c.pos.z);
  // 选中后：离探针近的纸片被推开，给命中让路
  const part = prog(t, RV.select, RV.select + 0.4, ease.outCubic);
  if (part > 0) {
    _v.copy(out.pos).sub(PROBE_REST);
    const d = _v.length();
    const push = Math.max(0, 1 - d / 15) * 4.5 * part;
    if (d > 1e-3) out.pos.addScaledVector(_v.normalize(), push);
  }
  out.rot.set(c.rot.x + Math.sin(sway * 0.35 + c.phase) * 0.03, c.rot.y + Math.cos(sway * 0.3 + c.phase * 1.3) * 0.04, c.rot.z);
  const shown = prog(t, c.reveal, c.reveal + 0.12);
  const rel = smooth(0.3, 0.78, c.sim);
  const flash = pulseFlash(c.pos, t);
  out.tint = clamp(flash * 0.45 + shown * rel * 0.6 * (1 - part * 0.55));
  out.halo = clamp(flash * 0.3 + shown * rel * rel * 0.5 * (1 - part * 0.7));
  out.fade = clamp(shown * (1 - rel) * 0.3 + part * (0.5 - rel * 0.3));
  out.shadow = 0.9 * (1 - out.fade);
};

// ── 场景组件 ──────────────────────────────────────────
const Rig = ({ t }: { t: number }) => {
  const { camera, scene } = useThree();
  const fog = useMemo(() => new THREE.Fog(0xffffff, 3.2, 3.4), []);
  const bg = useMemo(() => new THREE.Color(), []);
  useLayoutEffect(() => {
    applyCam(camera as THREE.PerspectiveCamera, t);
    bg.copy(WHITE).lerp(SPACE, space(t));
    scene.background = bg;
    fog.color.copy(bg);
    fog.near = fogNear(t);
    fog.far = fogFar(t);
    scene.fog = fog;
  }, [t, camera, scene, fog, bg]);
  return null;
};

const SHADOW_LOCAL = new THREE.Matrix4().compose(new THREE.Vector3(0.03, -0.055, -0.03), new THREE.Quaternion(), new THREE.Vector3(1.14, 1.11, 1));
const HALO_LOCAL = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -0.02), new THREE.Quaternion(), new THREE.Vector3(1.22, 1.17, 1));

const CardField = ({ t, assets }: { t: number; assets: ArchiveAssets }) => {
  const scene = useMemo(() => {
    const list = cards();
    const by = new Map<string, { type: CardType; variant: number; idx: number[] }>();
    list.forEach((c, i) => {
      const key = `${c.type}:${c.variant}`;
      if (!by.has(key)) by.set(key, { type: c.type, variant: c.variant, idx: [] });
      by.get(key)!.idx.push(i);
    });
    const groups = [...by.values()].map((g) => {
      const tex = assets.cards[g.type][g.variant];
      const geom = new THREE.BoxGeometry(1, 1, 0.012);
      const fade = instancedFloat(geom, 'aFade', g.idx.length);
      const tint = instancedFloat(geom, 'aTint', g.idx.length);
      const mesh = new THREE.InstancedMesh(geom, paperMaterial(canvasTex(tex.canvas)), g.idx.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      return { ...g, mesh, fade, tint, aspect: tex.aspect };
    });
    const plane = (tex: THREE.Texture, color: THREE.Color, fogged: boolean) => {
      const geom = new THREE.PlaneGeometry(1, 1);
      const alpha = instancedFloat(geom, 'aAlpha', list.length);
      const mesh = new THREE.InstancedMesh(geom, alphaMaterial(tex, color, fogged), list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      return { mesh, alpha };
    };
    return { groups, shadows: plane(softRectTex(10), SHADOW, true), halos: plane(softRectTex(16), PRIMARY, true) };
  }, [assets]);

  useLayoutEffect(() => {
    const list = cards();
    const dummy = new THREE.Object3D();
    const m = new THREE.Matrix4();
    const st: CardFx = { pos: new THREE.Vector3(), rot: new THREE.Euler(), tint: 0, fade: 0, halo: 0, shadow: 1 };
    for (const g of scene.groups) {
      g.idx.forEach((ci, n) => {
        const c = list[ci];
        cardState(c, t, st);
        dummy.position.copy(st.pos);
        dummy.rotation.copy(st.rot);
        dummy.scale.set(c.scale, c.scale * g.aspect, 1);
        dummy.updateMatrix();
        g.mesh.setMatrixAt(n, dummy.matrix);
        g.fade.setX(n, st.fade);
        g.tint.setX(n, st.tint);
        scene.shadows.mesh.setMatrixAt(ci, m.copy(dummy.matrix).multiply(SHADOW_LOCAL));
        scene.shadows.alpha.setX(ci, 0.38 * st.shadow);
        scene.halos.mesh.setMatrixAt(ci, m.copy(dummy.matrix).multiply(HALO_LOCAL));
        scene.halos.alpha.setX(ci, 0.42 * st.halo);
      });
      g.mesh.instanceMatrix.needsUpdate = true;
      g.fade.needsUpdate = true;
      g.tint.needsUpdate = true;
    }
    for (const p of [scene.shadows, scene.halos]) {
      p.mesh.instanceMatrix.needsUpdate = true;
      p.alpha.needsUpdate = true;
    }
  }, [t, scene]);

  return (
    <>
      <primitive object={scene.shadows.mesh} />
      <primitive object={scene.halos.mesh} />
      {scene.groups.map((g) => (
        <primitive key={`${g.type}:${g.variant}`} object={g.mesh} />
      ))}
    </>
  );
};

/** 开场：与 DOM 完全对齐的 64 根细竖条，随后收拢成探针。 */
const QueryBars = ({ t }: { t: number }) => {
  const { mesh, base, center, quat, unit } = useMemo(() => {
    const { pitch, unit: u } = strip3D();
    const m = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: pillTex(), transparent: true, toneMapped: false, fog: false, depthWrite: false }),
      STRIP.cells,
    );
    m.setColorAt(0, WHITE);
    m.frustumCulled = false;
    const b = Array.from({ length: STRIP.cells }, (_, j) => camLocal(RV.cut, (j - (STRIP.cells - 1) / 2) * pitch, 0, STRIP_D));
    return { mesh: m, base: b, center: camLocal(RV.cut, 0, 0, STRIP_D), quat: camAtT(RV.cut).quaternion.clone(), unit: u };
  }, []);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let j = 0; j < STRIP.cells; j++) {
      const off = Math.abs(j - (STRIP.cells - 1) / 2) / ((STRIP.cells - 1) / 2);
      const k = prog(t, RV.cut + 0.02 + off * 0.07, RV.probe, ease.inCubic);
      const v = cellValue(j);
      dummy.position.copy(base[j]).lerp(center, k);
      dummy.quaternion.copy(quat);
      dummy.scale.set(BAR.w * unit * (1 - 0.5 * k), barLen(v) * BAR.h * unit * (1 - 0.86 * k), 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(j, dummy.matrix);
      const [r, g, b] = cellRGB(v);
      col.setRGB(r, g, b, SRGB).lerp(PRIMARY, k);
      mesh.setColorAt(j, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = t < RV.probe + 0.01;
  }, [t, mesh, base, center, quat, unit]);
  return <primitive object={mesh} />;
};

/** 探针：品牌瞳点同色的实心点 + 柔光晕 + 渐隐尾迹；选中那一下从点上荡开一圈柔边环。 */
const TRAIL_N = 40;
const Probe = ({ t }: { t: number }) => {
  const parts = useMemo(() => {
    const group = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshBasicMaterial({ color: PRIMARY, toneMapped: false, fog: false }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex(), color: PRIMARY, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: ringTex(), color: PRIMARY, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
    );
    const geom = new LineGeometry();
    geom.setPositions(new Array(TRAIL_N * 3).fill(0));
    geom.setColors(new Array(TRAIL_N * 3).fill(1));
    const mat = new LineMaterial({ vertexColors: true, linewidth: 2, transparent: true, depthWrite: false, toneMapped: false });
    mat.resolution.set(WIDTH, HEIGHT);
    const trail = new Line2(geom, mat);
    trail.frustumCulled = false;
    group.add(halo, core, ring, trail);
    return { group, core, halo, ring, trail, geom };
  }, []);

  useLayoutEffect(() => {
    const on = t >= RV.probe - 0.005 && t < RV.reveal;
    parts.group.visible = on;
    if (!on) return;
    const p = probePos(t);
    const birth = Math.exp(-Math.max(0, t - RV.probe) * PACE * 6);
    const fade = 1 - prog(t, 8.18, 8.38);
    const selectPulse = Math.exp(-Math.max(0, t - RV.select) * PACE * 4) * (t >= RV.select ? 1 : 0);
    parts.core.position.copy(p);
    parts.core.scale.setScalar(0.034 * fade * (1 + birth * 0.6));
    parts.halo.position.copy(p);
    parts.halo.scale.setScalar(0.26 * fade * (1 + birth * 0.8 + selectPulse * 0.6));
    (parts.halo.material as THREE.SpriteMaterial).opacity = 0.3 * fade;
    parts.ring.position.copy(p);
    parts.ring.quaternion.copy(camAtT(t).quaternion);
    parts.ring.scale.setScalar(0.05 + (1 - selectPulse) * 0.5 * fade);
    (parts.ring.material as THREE.MeshBasicMaterial).opacity = selectPulse * 0.55 * fade;
    const bg = WHITE.clone().lerp(SPACE, space(t));
    const cam = camPose(t).pos;
    const pos: number[] = [];
    const cols: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < TRAIL_N; i++) {
      const tp = probePos(t - i * 0.0035);
      pos.push(tp.x, tp.y, tp.z);
      // 尾迹越旧越接近底色（等于淡出）；离镜头太近的一段也隐去，免得横穿画面
      const k = (1 - i / TRAIL_N) ** 1.6 * prog(cam.distanceTo(tp), 1.2, 2.6) * prog(t - i * 0.0035, RV.probe, RV.probe + 0.06);
      c.copy(bg).lerp(PRIMARY_SOFT, k * fade);
      cols.push(c.r, c.g, c.b);
    }
    parts.geom.setPositions(pos);
    parts.geom.setColors(cols);
  }, [t, parts]);
  return <primitive object={parts.group} />;
};

/** 相似度波前：从探针荡开的柔边蓝环。 */
const Pulses = ({ t }: { t: number }) => {
  const rings = useMemo(() => {
    const tex = ringTex();
    return PULSES.map(() => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: tex, color: PRIMARY, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
      );
      m.frustumCulled = false;
      return m;
    });
  }, []);
  useLayoutEffect(() => {
    const q = camAtT(t).quaternion;
    rings.forEach((m, k) => {
      const age = t - PULSES[k];
      m.visible = age > 0 && age < 1.2;
      if (!m.visible) return;
      m.position.copy(pulseOrigin(k));
      m.quaternion.copy(q);
      m.scale.setScalar(Math.max(0.01, age * PULSE_SPEED));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.26 * Math.exp(-age * 2.4) * prog(age, 0, 0.04);
    });
  }, [t, rings]);
  return (
    <>
      {rings.map((m, k) => (
        <primitive key={k} object={m} />
      ))}
    </>
  );
};

const hitPose = (t: number, i: number) => {
  const k = extractK(t, i);
  const sway = t * PACE;
  const base = HIT_BASE[i].clone().add(new THREE.Vector3(Math.sin(sway * 0.5 + i) * 0.05, Math.cos(sway * 0.43 + i) * 0.05, 0));
  const slot = camLocal(t, HIT_SLOT_X[i], HIT_SLOT_Y, HIT_D);
  const pos = base.lerp(slot, clamp(k, 0, 1.2));
  const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06 * (i - 1), -0.12 * (i - 1), 0.04 * (1 - i)));
  const q = q0.slerp(camAtT(t).quaternion, clamp(k));
  return { pos, q, k };
};

const HitCards = ({ t, assets }: { t: number; assets: ArchiveAssets }) => {
  const parts = useMemo(() => {
    const shadowTex = softRectTex(18);
    const haloTex = softRectTex(22);
    return HITS.map((_, i) => {
      const group = new THREE.Group();
      // 受雾影响：开场时藏在雾里；抽离后离镜头 4.6 < fog.near，退场合拢的雾也盖不到它们
      const card = new THREE.Mesh(new THREE.BoxGeometry(HIT_W, HIT_H, 0.014), new THREE.MeshBasicMaterial({ map: canvasTex(assets.hits[i].canvas), toneMapped: false }));
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(HIT_W * 1.16, HIT_H * 1.12),
        new THREE.MeshBasicMaterial({ map: shadowTex, color: SHADOW, transparent: true, depthWrite: false, toneMapped: false }),
      );
      shadow.position.set(0.03, -0.07, -0.04);
      const halo = new THREE.Mesh(
        new THREE.PlaneGeometry(HIT_W * 1.3, HIT_H * 1.24),
        new THREE.MeshBasicMaterial({ map: haloTex, color: PRIMARY, transparent: true, depthWrite: false, toneMapped: false }),
      );
      halo.position.set(0, 0, -0.03);
      group.add(shadow, halo, card);
      return { group, shadow, halo };
    });
  }, [assets]);

  useLayoutEffect(() => {
    parts.forEach(({ group, shadow, halo }, i) => {
      group.visible = t < RV.reveal;
      if (!group.visible) return;
      const { pos, q, k } = hitPose(t, i);
      group.position.copy(pos);
      group.quaternion.copy(q);
      group.scale.setScalar(i === 1 ? 1 + 0.08 * clamp(k) : 1);
      const flash = pulseFlash(HIT_BASE[i], t);
      const lit = prog(t, RV.select, RV.select + 0.12);
      const settle = Math.exp(-Math.max(0, t - RV.select) * PACE * 2.2);
      (halo.material as THREE.MeshBasicMaterial).opacity = clamp(flash * 0.3 + lit * (0.16 + 0.34 * settle));
      (shadow.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.12 * clamp(k);
    });
  }, [t, parts]);
  return (
    <>
      {parts.map((p, i) => (
        <primitive key={i} object={p.group} />
      ))}
    </>
  );
};

/** top-k 连线：探针 → 三张命中，二次贝塞尔弧线，线上有光点流动。 */
const LINK_N = 32;
const Links = ({ t }: { t: number }) => {
  const parts = useMemo(() => {
    const dotTex = radialTex();
    return HITS.map(() => {
      const geom = new LineGeometry();
      geom.setPositions(new Array(LINK_N * 3).fill(0));
      const mat = new LineMaterial({ color: PRIMARY, linewidth: 1.6, transparent: true, depthWrite: false, toneMapped: false });
      mat.resolution.set(WIDTH, HEIGHT);
      const line = new Line2(geom, mat);
      line.frustumCulled = false;
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: PRIMARY, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
      return { line, geom, mat, dot };
    });
  }, []);
  useLayoutEffect(() => {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camAtT(t).quaternion);
    parts.forEach(({ line, geom, mat, dot }, i) => {
      const grow = prog(t, RV.select + i * 0.035, RV.select + 0.16 + i * 0.035, ease.outCubic);
      const fade = 1 - prog(t, 8.12, 8.3);
      line.visible = grow > 0 && fade > 0;
      dot.visible = line.visible;
      if (!line.visible) return;
      const a = probePos(t);
      const b = hitPose(t, i).pos;
      const ctrl = a.clone().lerp(b, 0.5).addScaledVector(up, 0.16 * a.distanceTo(b));
      const at = (u: number) => {
        const s = 1 - u;
        return new THREE.Vector3().addScaledVector(a, s * s).addScaledVector(ctrl, 2 * s * u).addScaledVector(b, u * u);
      };
      const pts: number[] = [];
      for (let n = 0; n < LINK_N; n++) {
        const p = at((n / (LINK_N - 1)) * grow);
        pts.push(p.x, p.y, p.z);
      }
      geom.setPositions(pts);
      line.computeLineDistances();
      mat.opacity = 0.75 * fade;
      const f = ((t - RV.select) * PACE * 1.6 + i * 0.3) % 1;
      dot.position.copy(at(f * grow));
      dot.scale.setScalar(0.16 * fade);
      (dot.material as THREE.SpriteMaterial).opacity = 0.85 * fade;
    });
  }, [t, parts]);
  return (
    <>
      {parts.map((p, i) => (
        <group key={i}>
          <primitive object={p.line} />
          <primitive object={p.dot} />
        </group>
      ))}
    </>
  );
};

type Fx = { bokehScale: number; target: THREE.Vector3 | null };
type Dark = { darkness: number };

const Post = ({ t }: { t: number }) => {
  const dof = useRef<Fx>(null);
  const vig = useRef<Dark>(null);
  const target0 = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  useLayoutEffect(() => {
    if (dof.current) {
      dof.current.bokehScale = bokeh(t) * renderDpr();
      const focusHits = prog(t, RV.extract, RV.extract + 0.25, ease.inOutCubic);
      const f = probePos(t).lerp(camLocal(t, 0, 0, HIT_D), focusHits);
      dof.current.target?.copy(f);
    }
    if (vig.current) vig.current.darkness = vignette(t);
  }, [t]);
  return (
    <EffectComposer multisampling={4}>
      <DepthOfField ref={dof as never} target={target0} worldFocusRange={5} bokehScale={0} />
      <Vignette ref={vig as never} offset={0.32} darkness={0} />
    </EffectComposer>
  );
};

const Lights = () => (
  <>
    <hemisphereLight args={[0xffffff, 0xdfe4ec, 2.0]} />
    <directionalLight position={[-4, 6, 9]} intensity={2.1} />
  </>
);

// ── DOM 叠层：HUD / 命中标签（浅色玻璃卡，与产品界面同一套） ──
const GLASS = {
  background: 'hsl(0 0% 100% / 0.86)',
  backdropFilter: 'blur(14px) saturate(1.4)',
  border: '1px solid hsl(220 14% 20% / 0.08)',
  boxShadow: '0 14px 32px -12px hsl(220 30% 20% / 0.18), 0 2px 6px hsl(220 30% 20% / 0.05)',
} as const;
const INK = 'hsl(220 12% 16%)';
const MUTED = 'hsl(220 8% 46%)';
const PRIMARY_CSS = 'hsl(215 72% 42%)';

// 不给扫描中的纸片挂 cos 读数：镜头在扫描窗口里冲过约 60 个单位，波前扫到时还在画面里的纸片
// 0.16 脚本秒内就飞出安全区（读数只闪一下），且都离命中簇很远、相似度只有 0.02–0.2
const REVEALS = cards()
  .map((c) => c.reveal)
  .sort((a, b) => a - b);
const TOTAL = REVEALS.length + HITS.length;
const scannedAt = (t: number) => {
  let lo = 0;
  let hi = REVEALS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (REVEALS[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const sweep = Math.round(TOTAL * ease.inOutCubic(prog(t, RV.scan + 0.04, RV.select)));
  return Math.min(TOTAL, Math.max(lo, sweep));
};

const Overlay = ({ t }: { t: number }) => {
  const hud = prog(t, 7.16, 7.3, ease.brand) * (1 - prog(t, 8.2, 8.34));
  const n = scannedAt(t);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: font.ui }}>
      {hud > 0 ? (
        <div
          style={{
            position: 'absolute',
            right: 96,
            top: 76,
            width: 300,
            padding: '14px 18px 16px',
            borderRadius: 14,
            ...GLASS,
            opacity: hud,
            transform: `translateY(${(1 - hud) * -8}px)`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: MUTED }}>
            <span>
              {S.unifiedSearch} · {S.memorySearch}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>top-k 3</span>
          </div>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.01em', color: INK }}>{n.toLocaleString('en-US')}</span>
            <span style={{ fontSize: 13, color: MUTED }}>/ {TOTAL.toLocaleString('en-US')} 份资料已比对</span>
          </div>
          <div style={{ marginTop: 12, height: 3, borderRadius: 2, background: 'hsl(220 14% 20% / 0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${(n / TOTAL) * 100}%`, height: '100%', background: PRIMARY_CSS }} />
          </div>
        </div>
      ) : null}

      {HITS.map((h, i) => {
        const k = prog(t, RV.extract + 0.16 + i * 0.05, RV.extract + 0.3 + i * 0.05, ease.brand) * (1 - prog(t, RV.reveal - 0.06, RV.reveal));
        if (k <= 0) return null;
        const r = hitScreenRect(i, t);
        const memory = h.tag === 'memory';
        return (
          <div
            key={h.title}
            style={{
              position: 'absolute',
              left: r.x + r.w / 2,
              top: r.y + r.h + 22,
              transform: `translateX(-50%) translateY(${(1 - k) * 8}px)`,
              opacity: k,
              textAlign: 'center',
              whiteSpace: 'nowrap',
              padding: '10px 16px 11px',
              borderRadius: 12,
              ...GLASS,
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span
                style={{
                  padding: '2px 9px',
                  borderRadius: 999,
                  background: memory ? 'hsl(152 62% 36% / 0.1)' : 'hsl(215 72% 42% / 0.08)',
                  color: memory ? 'hsl(152 62% 30%)' : PRIMARY_CSS,
                  fontWeight: 500,
                }}
              >
                {memory ? S.memorySearch : S.unifiedSearch}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: MUTED }}>
                cos <span style={{ color: INK, fontWeight: 600 }}>{h.score.toFixed(2)}</span>
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 500, color: INK }}>{h.title}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const Archive3D = ({ t }: { t: number }) => {
  const assets = useArchiveAssets();
  const fade = 1 - prog(t, RV.reveal, RV.reveal + 0.14);
  // 纹理到了再挂 3D 画布：画布先挂、网格后加时，R3F 不会为这次状态更新补画一帧，截图里纸片全缺
  if (fade <= 0 || !assets) return null;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <ThreeCanvas
        width={WIDTH}
        height={HEIGHT}
        flat
        dpr={renderDpr()}
        gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
        camera={{ fov: FOV, near: 0.05, far: 400, position: camPose(RV.cut).pos.toArray() }}
      >
        <Rig t={t} />
        <Lights />
        <CardField t={t} assets={assets} />
        <HitCards t={t} assets={assets} />
        <QueryBars t={t} />
        <Pulses t={t} />
        <Probe t={t} />
        <Links t={t} />
        <Post t={t} />
      </ThreeCanvas>
      <Overlay t={t} />
    </AbsoluteFill>
  );
};
