import { useThree } from '@react-three/fiber';
import { ThreeCanvas } from '@remotion/three';
import { useLayoutEffect, useMemo } from 'react';
import { AbsoluteFill } from 'remotion';
import * as THREE from 'three';
import { clamp, ease, HEIGHT, keys, lerp, motion, prog, WIDTH } from '../../lib/time';
import { brand, font } from '../../theme';
import { Pupil } from '../../ui/brand';
import { canvasTex } from '../retrieval/Archive3D';
import { renderDpr, useArchiveAssets, type ArchiveAssets } from '../retrieval/assets';
import { FN } from './beats';
import { BUMP_UNIFORMS, CONTOUR, GLSL_TERRAIN, GROW, growthAt, SUMMITS, surfaceAt } from './terrain';

/**
 * 收尾：「从一页纸，到一整座知识库」。
 * 教材第 134 页平放在纸面上 → 脚下的纸隆起成山，等高线从山顶一圈圈荡开 →
 * 镜头抬起、拉远，整片知识地形铺满画面，每座山是一个主题，山越高资料越多。
 */
const FOV = 35;
const D_END = 41;
const TILT_END = 1.0;
const TARGET_END = new THREE.Vector3(0.5, 12.5, 3.5);
const PAGE = { w: 0.96, h: 0.96 * 1.33, lift: 0.035 };
/** 画面上缘的「天」：从下往上数的屏幕比例。 */
const SKY = { y0: 0.56, y1: 0.8 };

const col = (h: number, s: number, l: number) => new THREE.Color().setHSL(h / 360, s / 100, l / 100, THREE.SRGBColorSpace);
const PAPER = col(0, 0, 97);
const INK = col(220, 12, 16);
const ACCENT = col(215, 72, 40);
const SHADE = col(220, 12, 82);
/** 地形着色器直接写 sRGB 帧缓冲（不走 colorspace_fragment），uniform 给 sRGB 编码值，混色规则与 CSS 一致。 */
const srgb = (c: THREE.Color) => c.clone().convertLinearToSRGB();

// ── 镜头 ──────────────────────────────────────────────
const camDist = (t: number) =>
  Math.exp(
    keys(t, [
      [FN.pull0, Math.log(2.05)],
      [FN.pull0 + 0.5, Math.log(4.4), motion.camGlide],
      [FN.pull1, Math.log(D_END), ease.inOutCubic],
    ]),
  ) *
  (1 + 0.022 * Math.max(0, t - FN.pull1));
const camTilt = (t: number) => TILT_END * ease.inOutCubic(prog(t, FN.pull0 + 0.7, FN.pull1 - 0.15));
const camAz = (t: number) => lerp(-0.12, 0.2, ease.inOutCubic(prog(t, FN.pull0, FN.fade1)));
const pageZ = (t: number) => surfaceAt(t, 0, 0) + PAGE.lift;

export const camPose = (t: number) => {
  const d = camDist(t);
  const phi = camTilt(t);
  const th = camAz(t);
  const k = ease.inOutCubic(prog(t, FN.pull0 + 0.8, FN.pull1));
  const tgt = new THREE.Vector3(lerp(0, TARGET_END.x, k), lerp(0, TARGET_END.y, k), lerp(pageZ(t), TARGET_END.z, k));
  const fwd = new THREE.Vector3(-Math.sin(th), Math.cos(th), 0);
  const pos = tgt.clone().addScaledVector(fwd, -Math.sin(phi) * d);
  pos.z += Math.cos(phi) * d;
  const up = fwd.clone().multiplyScalar(Math.cos(phi));
  up.z += Math.sin(phi);
  return { pos, tgt, up, d };
};

const PROJ = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.05, 900);
export const toScreen = (t: number, p: THREE.Vector3) => {
  const { pos, tgt, up } = camPose(t);
  PROJ.position.copy(pos);
  PROJ.up.copy(up);
  PROJ.lookAt(tgt);
  PROJ.updateMatrixWorld();
  const v = p.clone().project(PROJ);
  return { x: (v.x * 0.5 + 0.5) * WIDTH, y: (-v.y * 0.5 + 0.5) * HEIGHT, behind: v.z > 1, dist: pos.distanceTo(p) };
};

/** 「你在这里」：瞳点停在那一页的高亮句上，片尾从这里飞进 Logo。 */
const PIN = new THREE.Vector3(0.02, -0.17, 0);
export const pinScreen = (t: number) => toScreen(t, new THREE.Vector3(PIN.x, PIN.y, pageZ(t) + 0.01));

const fogRange = (d: number) => ({ near: d * 1.05, far: d * 2.7 });

// ── 地形着色器 ────────────────────────────────────────
const VERT = /* glsl */ `
${GLSL_TERRAIN}
varying vec3 vWorld;
void main() {
  vec2 p = position.xy;
  float h = growth(p) * terrainH(p).x;
  vec4 wp = modelMatrix * vec4(p, h, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${GLSL_TERRAIN}
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uShade;
uniform float uInterval;
uniform float uFogNear;
uniform float uFogFar;
uniform float uLines;
uniform vec2 uPage;
uniform float uPageZ;
uniform float uSky;
uniform float uSkyY0;
uniform float uSkyY1;
uniform vec2 uRes;
varying vec3 vWorld;

// 抗锯齿等宽线：x 每过一个整数画一条，宽 wpx 像素（按 1080p 计，4K 同比加粗）；线挤得太密时自动淡出
float isoLine(float x, float wpx) {
  float px = uRes.y / 1080.0;
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x - 0.5) - 0.5) / fw;
  float a = 1.0 - smoothstep(wpx * px * 0.5 - 0.5, wpx * px * 0.5 + 0.5, d);
  return a * (1.0 - smoothstep(0.24, 0.5, fw * px));
}

void main() {
  vec2 p = vWorld.xy;
  float g = growth(p);
  vec2 hm = terrainH(p);
  float h = g * hm.x;
  float e = 0.025;
  float hx = growth(p + vec2(e, 0.0)) * terrainH(p + vec2(e, 0.0)).x;
  float hy = growth(p + vec2(0.0, e)) * terrainH(p + vec2(0.0, e)).x;
  vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.0));

  // 晕渲：光从左上方（西北）来，平地正好是纸色；只做极轻的明暗，主角是线
  vec3 L = normalize(vec3(-0.5, 0.62, 0.6));
  float k = dot(n, L) - L.z;
  vec3 c = k < 0.0 ? mix(uPaper, uShade, clamp(-k * 1.3, 0.0, 1.0)) : mix(uPaper, vec3(1.0), clamp(k * 1.4, 0.0, 1.0));

  // 那一页纸投在山顶上的软影
  vec2 bp = abs(p - vec2(0.05, -0.06)) - uPage;
  float sd = length(max(bp, 0.0)) + min(max(bp.x, bp.y), 0.0);
  c *= 1.0 - 0.13 * (1.0 - smoothstep(-0.02, 0.22, sd)) * step(uPageZ - 0.2, h);

  // 等高线：首曲线细而淡，每 5 条一根加粗的计曲线；教材所在那座山用品牌蓝
  float x = h / uInterval;
  float above = smoothstep(0.35, 0.75, x);
  float minor = isoLine(x, 1.2);
  float major = isoLine(x / ${CONTOUR.major.toFixed(1)}, 2.1);
  float a = max(minor * 0.30, major * 0.62) * above * uLines;
  float mainShare = smoothstep(0.55, 0.8, hm.y);
  vec3 lc = mix(uInk, uAccent, mainShare);
  c = mix(c, lc, a);

  float dist = length(vWorld - cameraPosition);
  float fog = smoothstep(uFogNear, uFogFar, dist);
  // 远景在画面上缘化进纸里，给标题留一片干净的天
  float sky = uSky * smoothstep(uSkyY0, uSkyY1, gl_FragCoord.y / uRes.y);
  gl_FragColor = vec4(mix(c, uPaper, max(fog, sky)), 1.0);
}
`;

const Terrain = ({ t }: { t: number }) => {
  const mat = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uBumpA: { value: chunk(BUMP_UNIFORMS.a) },
        uBumpB: { value: chunk(BUMP_UNIFORMS.b) },
        uT: { value: 0 },
        uGrow0: { value: GROW.t0 },
        uGrowSpeed: { value: GROW.speed },
        uGrowDur: { value: GROW.dur },
        uPaper: { value: srgb(PAPER) },
        uInk: { value: srgb(INK) },
        uAccent: { value: srgb(ACCENT) },
        uShade: { value: srgb(SHADE) },
        uInterval: { value: CONTOUR.interval },
        uFogNear: { value: 10 },
        uFogFar: { value: 40 },
        uLines: { value: 1 },
        uPage: { value: new THREE.Vector2(PAGE.w / 2, PAGE.h / 2) },
        uPageZ: { value: 0 },
        uSky: { value: 0 },
        uSkyY0: { value: SKY.y0 },
        uSkyY1: { value: SKY.y1 },
        uRes: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      },
    });
    return m;
  }, []);
  const geom = useMemo(() => new THREE.PlaneGeometry(150, 150, 600, 600).translate(0, 20, 0), []);
  const { gl } = useThree();
  useLayoutEffect(() => {
    const { d } = camPose(t);
    const f = fogRange(d);
    mat.uniforms.uT.value = t;
    mat.uniforms.uFogNear.value = f.near;
    mat.uniforms.uFogFar.value = f.far;
    mat.uniforms.uPageZ.value = pageZ(t);
    mat.uniforms.uSky.value = prog(camTilt(t), 0.35, 0.9);
    gl.getDrawingBufferSize(mat.uniforms.uRes.value);
  }, [t, mat, gl]);
  return <mesh geometry={geom} material={mat} frustumCulled={false} />;
};

const chunk = (flat: number[]) => {
  const out: THREE.Vector4[] = [];
  for (let i = 0; i < flat.length; i += 4) out.push(new THREE.Vector4(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]));
  return out;
};

const Page = ({ t, assets }: { t: number; assets: ArchiveAssets }) => {
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 0.012),
      new THREE.MeshStandardMaterial({ map: canvasTex(assets.page.canvas), roughness: 0.8, metalness: 0 }),
    );
    m.scale.set(PAGE.w, PAGE.h, 1);
    return m;
  }, [assets]);
  useLayoutEffect(() => {
    mesh.position.set(0, 0, pageZ(t) + 0.006);
  }, [t, mesh]);
  return <primitive object={mesh} />;
};

const Rig = ({ t }: { t: number }) => {
  const { camera, scene } = useThree();
  useLayoutEffect(() => {
    const { pos, tgt, up } = camPose(t);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = FOV;
    cam.aspect = WIDTH / HEIGHT;
    cam.near = 0.05;
    cam.far = 900;
    cam.position.copy(pos);
    cam.up.copy(up);
    cam.lookAt(tgt);
    cam.updateProjectionMatrix();
    scene.background = PAPER;
  }, [t, camera, scene]);
  return null;
};

// ── 山头标注（DOM，制图式：▲ + 名称 + 资料数） ─────────────
const LABEL_IN = FN.pull0 + 2.1;
const Labels = ({ t }: { t: number }) => {
  const { d } = camPose(t);
  const f = fogRange(d);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: font.ui }}>
      {SUMMITS.map((p, i) => {
        const main = i === 0;
        const at = main ? LABEL_IN : LABEL_IN + 0.5 + Math.hypot(p.sx, p.sy) / 26;
        const k = prog(t, at, at + 0.4, ease.brand) * prog(growthAt(t, p.sx, p.sy), 0.7, 1) * (main ? prog(d, 8, 14) : 1);
        if (k <= 0) return null;
        const s = main ? pinScreen(t) : toScreen(t, new THREE.Vector3(p.sx, p.sy, surfaceAt(t, p.sx, p.sy)));
        if (s.behind || s.x < -200 || s.x > WIDTH + 40 || s.y < 250 || s.y > HEIGHT + 40) return null;
        const fog = 1 - clamp((s.dist - f.near * 1.05) / (f.far * 0.85 - f.near * 1.05));
        const o = k * fog * clamp((s.y - 250) / 60);
        if (o <= 0.01) return null;
        const ink = main ? brand.accent : brand.ink;
        return (
          <div key={p.name} style={{ position: 'absolute', left: s.x, top: s.y, opacity: o }}>
            {main ? null : (
              <svg width={14} height={12} viewBox="0 0 14 12" style={{ position: 'absolute', left: -7, top: -9 }}>
                <path d="M7 1 L13 11 H1 Z" fill={ink} />
              </svg>
            )}
            <div
              style={{
                position: 'absolute',
                left: main ? 24 : 14,
                top: main ? -27 : -22,
                whiteSpace: 'nowrap',
                transform: `translateY(${(1 - k) * 6}px)`,
                textShadow: `0 0 3px ${brand.paper}, 0 0 6px ${brand.paper}, 0 0 10px ${brand.paper}`,
              }}
            >
              <div style={{ fontSize: main ? 24 : 21, fontWeight: 600, letterSpacing: '0.06em', color: ink }}>{p.name}</div>
              <div style={{ marginTop: 2, fontSize: 15, color: main ? brand.accent : brand.ink2, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>
                {main ? `你在这里 · ${p.count} 份资料` : `${p.count} 份资料`}
              </div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const KnowledgeTerrain = ({ t }: { t: number }) => {
  const assets = useArchiveAssets();
  const veil = 1 - prog(t, FN.veil0, FN.veil1, ease.inOutCubic);
  const fade = 1 - prog(t, FN.fade0, FN.fade1, ease.inOutCubic);
  const pin = pinScreen(t);
  const pinIn = prog(t, FN.veil1 - 0.1, FN.veil1 + 0.08, ease.brand);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: fade }}>
        {/* 纹理到了才挂画布：先挂画布、后加纸页时 R3F 不补画，新标签页的第一帧会缺那页纸 */}
        {assets ? (
          <ThreeCanvas
            width={WIDTH}
            height={HEIGHT}
            flat
            dpr={renderDpr()}
            gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
            camera={{ fov: FOV, near: 0.05, far: 900, position: [0, 0, 2.05] }}
          >
            <Rig t={t} />
            <hemisphereLight args={[0xffffff, 0xe6eaf0, 1.9]} />
            <directionalLight position={[-3, 5, 9]} intensity={1.1} />
            <Terrain t={t} />
            <Page t={t} assets={assets} />
          </ThreeCanvas>
        ) : null}
        <Labels t={t} />
        {veil > 0.001 ? <AbsoluteFill style={{ background: brand.paper, opacity: veil }} /> : null}
      </AbsoluteFill>
      {t < FN.pupil0 && pinIn > 0 ? <Pupil x={pin.x} y={pin.y} t={t} opacity={pinIn} /> : null}
    </AbsoluteFill>
  );
};
