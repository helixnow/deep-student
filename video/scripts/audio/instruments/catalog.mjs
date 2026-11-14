// 采样音色目录：每个角色的默认 / 备选音色从哪个开源库取哪些文件、怎么映射。
// fetch-samples.mjs --resolve 据此生成 samples.manifest.json；index.mjs 据此加载与映射。

export const SOURCES = {
  vcsl: {
    name: 'Versilian Community Sample Library (VCSL)',
    repo: 'sgossner/VCSL',
    commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
    license: 'CC0-1.0',
    credit: 'Versilian Community Sample Library — Versilian Studios / Samuel Gossner and contributors (CC0 1.0)',
    homepage: 'https://github.com/sgossner/VCSL',
  },
  vsco: {
    name: 'VSCO 2 Community Edition',
    repo: 'sgossner/VSCO-2-CE',
    commit: '440300901dfe9275fd84e0b7763af1f8443ae62e',
    license: 'CC0-1.0',
    credit: 'Versilian Studios Chamber Orchestra 2: Community Edition — Versilian Studios / Samuel Gossner (CC0 1.0)',
    homepage: 'https://github.com/sgossner/VSCO-2-CE',
  },
  osiris: {
    name: 'Osiris Piano',
    repo: 'sfzinstruments/Osiris_Piano',
    commit: '18c6afccb60cff458edbf7c394571783e074e1e9',
    license: 'CC0-1.0',
    credit: 'Osiris Piano — Versilian Studios & Karoryfer Samples (CC0 1.0)',
    homepage: 'https://github.com/sfzinstruments/Osiris_Piano',
  },
  sneakybass: {
    name: 'Sneakybass',
    repo: 'sfzinstruments/karoryfer.sneakybass',
    commit: 'cc1a67e5c913678b85eaad1a3b5cb180d3be3e2d',
    license: 'CC0-1.0',
    credit: 'Sneakybass — Karoryfer Samples, played by D. Smolken (CC0 1.0)',
    homepage: 'https://github.com/sfzinstruments/karoryfer.sneakybass',
  },
  growlybass: {
    name: 'Growlybass',
    repo: 'sfzinstruments/karoryfer.growlybass',
    commit: '4f483268fc66b5a6d5781d421c0d11b8d08d3fc6',
    license: 'CC0-1.0',
    credit: 'Growlybass — Karoryfer Samples (CC0 1.0)',
    homepage: 'https://github.com/sfzinstruments/karoryfer.growlybass',
  },
  bodyperc: {
    name: 'Body Percussion',
    repo: 'sfzinstruments/body_percussion',
    commit: '4ac9d8966679c648b62fa10a188179e186b97f24',
    license: 'CC0-1.0',
    credit: 'Open source body percussion — sfzinstruments / Karoryfer Samples (CC0 1.0)',
    homepage: 'https://github.com/sfzinstruments/body_percussion',
  },
  virtuosity: {
    name: 'Virtuosity Drums',
    repo: 'sfzinstruments/virtuosity_drums',
    commit: '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc',
    license: 'CC0-1.0',
    credit: 'Virtuosity Drums — Versilian Studios & Karoryfer Samples, drummer Austin McMahon (CC0 1.0)',
    homepage: 'https://github.com/sfzinstruments/virtuosity_drums',
  },
  kenney: {
    name: 'Kenney RPG Audio / Casino Audio',
    repo: 'series-ai/jam-ready-assets',
    commit: 'ab1b21fe61bc3adeb759c286e770033563f18a97',
    lfs: true,
    license: 'CC0-1.0',
    credit: 'RPG Audio & Casino Audio — Kenney (kenney.nl) (CC0 1.0)',
    homepage: 'https://kenney.nl/assets/rpg-audio',
  },
  freesound: {
    name: 'Freesound (CC0 sounds)',
    license: 'CC0-1.0',
    credit: 'Freesound.org CC0 sounds (see per-file credits)',
    homepage: 'https://freesound.org',
  },
};

// ── 文件名解析工具 ───────────────────────────────────
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** 'C#4' / 'Db3' / 'ab2' / 'A-1' → MIDI（按 C4=60 的记法，库自身的八度偏差由 octave 字段 + 音高检测修正）。 */
export function noteToMidi(s) {
  const m = /^([A-Ga-g])([#sb]?)(-?\d)$/.exec(s);
  if (!m) return null;
  let pc = PC[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === 's') pc++;
  if (m[2] === 'b') pc--;
  return 12 * (Number(m[3]) + 1) + pc;
}
const DYN = { ppp: 0, pp: 1, p: 2, mp: 3, mf: 4, f: 5, ff: 6, fff: 7, soft: 2, med: 4, medium: 4, loud: 6 };
const base = (p) => p.split('/').pop().replace(/\.(wav|flac|ogg|mp3)$/i, '');
const num = (s, d = 0) => (s == null ? d : Number(s));

// ── 音色集合 ─────────────────────────────────────────
// kind: pitched（按根音映射）/ perc（按 artic 分组）/ slices（长录音切片）/ derived（由其它集合派生）
// play: damp（dur 后按 release 秒衰减）/ ring（自然余响，dur 只在 params.damp 时生效）/ sustain（可循环的长音）/ oneshot
export const SETS = [
  // ── piano ──
  {
    id: 'piano.osiris', role: 'piano', variant: 'osiris', default: true, source: 'osiris', kind: 'pitched',
    select: [{ dir: 'UC/B/', re: /\.flac$/ }],
    parse: (p) => { const m = /_([A-G]#?-?\d)_vl(\d)$/.exec(base(p)); return m && { note: m[1], layer: num(m[2]), rr: 0 }; },
    play: 'damp', release: 0.32, maxLen: 9, range: [21, 108], tail: 1.2,
    desc: 'Osiris Piano 立式钢琴，弱音踏板（una corda）近距离 B 话筒，2 个力度层；音色柔、暗、私密，带轻微机械声',
  },
  {
    id: 'piano.felt', role: 'piano', variant: 'felt', source: 'osiris', kind: 'derived', from: 'piano.osiris',
    lpf: 2600, attack: 0.004, play: 'damp', release: 0.4, range: [21, 108], tail: 1.4,
    desc: 'Osiris Piano + 2.6 kHz 低通 + 软化起音，模拟毛毡钢琴（felt piano）',
  },
  {
    id: 'piano.upright', role: 'piano', variant: 'upright', source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Chordophones/Zithers/Upright Piano, Yamaha/Sustains/', re: /\.wav$/ }],
    parse: (p) => { const m = /_Sus_([A-G]#?-?\d)_vl(\d)_rr(\d)/.exec(base(p)); return m && { note: m[1], layer: num(m[2]), rr: num(m[3]) }; },
    play: 'damp', release: 0.3, maxLen: 9, range: [24, 108], tail: 1.2,
    desc: 'VCSL Yamaha 立式钢琴，3 力度层 × 2 轮换，较明亮、颗粒感清楚',
  },
  // ── mallet ──
  {
    id: 'mallet.marimba', role: 'mallet', variant: 'marimba', default: true, source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Idiophones/Struck Idiophones/Marimba/', re: /\.wav$/ }],
    parse: (p) => { const m = /Outrigger_([A-G]#?-?\d)_(soft|med|loud)_(\d+)/.exec(base(p)); return m && { note: m[1], layer: DYN[m[2]], rr: num(m[3]) }; },
    play: 'ring', release: 0.25, maxLen: 4, range: [41, 96], tail: 1.5,
    desc: 'VCSL 马林巴（外侧槌），soft/med/loud 三层；木质、圆润',
  },
  {
    id: 'mallet.vibes', role: 'mallet', variant: 'vibes', source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Idiophones/Struck Idiophones/Vibraphone/Soft Mallets/', re: /\.wav$/ }],
    parse: (p) => { const m = /_([A-G]#?-?\d)_v(\d)_rr(\d)/.exec(base(p)); return m && { note: m[1], layer: num(m[2]), rr: num(m[3]) }; },
    play: 'ring', release: 0.6, maxLen: 6, range: [53, 89], tail: 3,
    desc: 'VCSL 颤音琴软槌（马达关），2 层；金属但柔和，长余响',
  },
  // ── bells ──
  {
    id: 'bells.glock', role: 'bells', variant: 'glock', default: true, source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Idiophones/Struck Idiophones/Glockenspiel/', re: /\.wav$/ }],
    parse: (p) => { const m = /glock_(soft|medium|loud)_([A-G]#?-?\d)_(\d+)/.exec(base(p)); return m && { note: m[2], layer: DYN[m[1]], rr: num(m[3]) }; },
    play: 'ring', release: 0.5, maxLen: 4, range: [79, 108], tail: 2.5,
    desc: 'VCSL 钟琴，soft/medium/loud 三层；清亮的点缀',
  },
  {
    id: 'bells.handchimes', role: 'bells', variant: 'handchimes', source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Idiophones/Struck Idiophones/Hand Chimes/', re: /\.wav$/ }],
    parse: (p) => { const m = /sus_([A-G]#?-?\d)_r(\d+)/.exec(base(p)); return m && { note: m[1], layer: 0, rr: num(m[2]) }; },
    play: 'ring', release: 0.8, maxLen: 6, range: [60, 96], tail: 4,
    desc: 'VCSL 手摇音钟（hand chimes），正弦般纯净、温暖的钟声',
  },
  // ── pluck ──
  {
    id: 'pluck.harp', role: 'pluck', variant: 'harp', default: true, source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Chordophones/Composite Chordophones/Concert Harp/', re: /\.wav$/ }],
    parse: (p) => { const m = /KSHarp_([A-G]#?-?\d)_(p|mp|mf|f)(\d)/.exec(base(p)); return m && { note: m[1], layer: DYN[m[2]] >= 4 ? DYN[m[2]] : 4, rr: num(m[3]) }; },
    play: 'ring', release: 0.7, maxLen: 6, range: [28, 103], tail: 3,
    desc: 'VCSL 音乐会竖琴，mf / f 两层；拨弦温暖、泛音干净',
  },
  {
    id: 'pluck.kalimba', role: 'pluck', variant: 'kalimba', source: 'vcsl', kind: 'pitched', tuneFromPitch: true,
    select: [{ dir: 'Idiophones/Plucked Idiophones/Kalimba, Tanzania/', re: /\.wav$/ }],
    parse: (p) => { const m = /Main_([A-G]#?-?\d)_k(\d+)/.exec(base(p)); return m && { note: m[1], layer: 0, rr: 0 }; },
    play: 'ring', release: 0.5, maxLen: 4, range: [55, 90], tail: 2,
    desc: 'VCSL 坦桑尼亚卡林巴（拇指琴），木箱共鸣、带轻微金属簧片嗡声；按实测音高校准',
  },
  // ── strings_long ──
  {
    id: 'strings_long.section', role: 'strings_long', variant: 'section', default: true, source: 'vsco', kind: 'pitched',
    select: [
      { dir: 'Strings/Violin Section/susVib/', re: /\.wav$/ },
      { dir: 'Strings/Viola Section/susvib/', re: /\.wav$/ },
      { dir: 'Strings/Cello Section/susvib/', re: /\.wav$/ },
    ],
    parse: (p) => {
      const m = /_([A-G]#?-?\d)_v(\d)/.exec(base(p));
      if (!m) return null;
      const sec = p.includes('Violin') ? 'vln' : p.includes('Viola') ? 'vla' : 'vc';
      return { note: m[1], layer: num(m[2]) > 1 ? 1 : 0, rr: 0, group: sec };
    },
    split: { vc: [0, 54], vla: [55, 66], vln: [67, 127] },
    play: 'sustain', attack: 0.12, release: 0.9, maxLen: 9, range: [36, 88], tail: 1.6,
    desc: 'VSCO 2 CE 弦乐组长音（大提琴组 / 中提琴组 / 小提琴组揉弦），按音区自动分配；2 力度层',
  },
  {
    id: 'strings_long.trem', role: 'strings_long', variant: 'trem', source: 'vsco', kind: 'pitched',
    select: [
      { dir: 'Strings/Violin Section/Trem/', re: /\.wav$/ },
      { dir: 'Strings/Viola Section/trem/', re: /\.wav$/ },
      { dir: 'Strings/Cello Section/trem/', re: /\.wav$/ },
    ],
    parse: (p) => {
      const m = /_([A-G]#?-?\d)(?:_v(\d))?/.exec(base(p));
      if (!m) return null;
      const sec = p.includes('Violin') ? 'vln' : p.includes('Viola') ? 'vla' : 'vc';
      return { note: m[1], layer: 0, rr: 0, group: sec };
    },
    split: { vc: [0, 54], vla: [55, 66], vln: [67, 127] },
    play: 'sustain', attack: 0.15, release: 0.8, maxLen: 9, range: [36, 88], tail: 1.4,
    desc: 'VSCO 2 CE 弦乐组震音（tremolo），微颤的紧张感 / 光感',
  },
  // ── strings_short ──
  {
    id: 'strings_short.pizz', role: 'strings_short', variant: 'pizz', default: true, source: 'vsco', kind: 'pitched',
    select: [
      { dir: 'Strings/Violin Section/Pizz/', re: /\.wav$/ },
      { dir: 'Strings/Viola Section/pizz/', re: /\.wav$/ },
      { dir: 'Strings/Cello Section/pizzT/', re: /\.wav$/ },
    ],
    parse: (p) => {
      const m = /_([A-G]#?-?\d)_v(\d)_(?:rr|RR)(\d)/i.exec(base(p));
      if (!m) return null;
      const sec = p.includes('Violin') ? 'vln' : p.includes('Viola') ? 'vla' : 'vc';
      return { note: m[1], layer: num(m[2]), rr: num(m[3]), group: sec };
    },
    split: { vc: [0, 54], vla: [55, 66], vln: [67, 127] },
    play: 'ring', release: 0.3, maxLen: 3, range: [36, 88], tail: 0.8,
    desc: 'VSCO 2 CE 弦乐组拨奏（pizzicato），2 层 × 2 轮换',
  },
  {
    id: 'strings_short.spic', role: 'strings_short', variant: 'spic', source: 'vsco', kind: 'pitched',
    select: [
      { dir: 'Strings/Violin Section/Spic/', re: /\.wav$/ },
      { dir: 'Strings/Viola Section/spic/', re: /\.wav$/ },
      { dir: 'Strings/Cello Section/spic/', re: /\.wav$/ },
    ],
    parse: (p) => {
      const m = /_([A-G]#?-?\d)(?:_v(\d))?(?:_(?:rr|RR)(\d))?/i.exec(base(p));
      if (!m) return null;
      const sec = p.includes('Violin') ? 'vln' : p.includes('Viola') ? 'vla' : 'vc';
      return { note: m[1], layer: num(m[2], 1), rr: num(m[3], 1), group: sec };
    },
    split: { vc: [0, 54], vla: [55, 66], vln: [67, 127] },
    play: 'damp', release: 0.15, maxLen: 2, range: [36, 88], tail: 0.6,
    desc: 'VSCO 2 CE 弦乐组跳弓（spiccato），短促有弹性',
  },
  // ── pad ──
  {
    id: 'pad.organ', role: 'pad', variant: 'organ', default: true, source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Aerophones/Edge-blown Aerophones/Pipe Organ/Quiet/', re: /\.wav$/ }],
    parse: (p) => { const m = /_([A-G]#?-?\d)_rr(\d)/.exec(base(p)); return m && { note: m[1], layer: 0, rr: num(m[2]) }; },
    play: 'sustain', attack: 0.45, release: 1.4, lpf: 4200, maxLen: 9, range: [36, 96], tail: 2,
    desc: 'VCSL 管风琴安静音栓（NT5 近距离），慢起音 + 4.2 kHz 低通，像呼吸一样的真实长音铺底',
  },
  {
    id: 'pad.bowedvibes', role: 'pad', variant: 'bowedvibes', source: 'vcsl', kind: 'pitched',
    select: [{ dir: 'Idiophones/Struck Idiophones/Vibraphone/Bowed/', re: /\.wav$/ }],
    parse: (p) => { const m = /_bowed_([A-G]#?-?\d)_rr(\d)/.exec(base(p)); return m && { note: m[1], layer: 0, rr: num(m[2]) }; },
    play: 'sustain', attack: 0.3, release: 1.6, maxLen: 9, range: [52, 93], tail: 3,
    desc: 'VCSL 弓擦颤音琴，玻璃般的持续音，空灵',
  },
  // ── bass ──
  {
    id: 'bass.sneaky', role: 'bass', variant: 'sneaky', default: true, source: 'sneakybass', kind: 'pitched',
    select: [{ dir: 'Samples/pluck/', re: /_(c|db|d|eb|e|f|gb|g|ab|a|bb|b)[2-4]_pluck_rr[1-4]\.wav$/ }],
    parse: (p) => { const m = /sneakybass_([a-g]b?)(\d)_pluck_rr(\d)/.exec(base(p)); return m && { note: m[1].toUpperCase().replace(/^([A-G])B$/, '$1b') + m[2], layer: 0, rr: num(m[3]) }; },
    play: 'damp', release: 0.18, maxLen: 5, range: [24, 60], tail: 0.5, pitchAt: 0.25, tuneCorrect: true,
    desc: 'Sneakybass 低音提琴拨奏，"深夜练琴"的极轻力度，近距离录音，每个半音都有采样 × 4 轮换',
  },
  {
    id: 'bass.growly', role: 'bass', variant: 'growly', source: 'growlybass', kind: 'pitched',
    select: [{ dir: 'sustain/', re: /^[a-g]b?[1-3]_(p|f)_rr[1-3]\.wav$/ }],
    parse: (p) => { const m = /^([a-g]b?)(\d)_(p|mp|mf|f|ff)_rr(\d)$/.exec(base(p)); return m && { note: m[1].toUpperCase().replace(/^([A-G])B$/, '$1b') + m[2], layer: DYN[m[3]], rr: num(m[4]) }; },
    play: 'damp', release: 0.12, maxLen: 5, range: [28, 60], tail: 0.4, pitchAt: 0.25, tuneCorrect: true,
    desc: 'Growlybass Squier Jazz Bass 电贝司直录，p / f 两层 × 3 轮换；圆润的流行贝司',
  },
  // ── kick / snare / hat（Virtuosity Drums：近距离话筒 + 头顶话筒合成）──
  {
    id: 'kick.virtuosity', role: 'kick', variant: 'virtuosity', default: true, source: 'virtuosity', kind: 'perc',
    select: [{ dir: 'Samples/kickmic/kick/', re: /_snoff_.*\.flac$/ }, { dir: 'Samples/oh/kick/', re: /_snoff_.*\.flac$/ }],
    parse: (p) => { const m = /^(kickmic|oh)_kick_snoff_vl(\d+)_rr(\d+)$/.exec(base(p)); return m && { artic: 'kick', layer: num(m[2]), rr: num(m[3]), mic: m[1], key: `${m[2]}_${m[3]}` }; },
    mics: { kickmic: 1, oh: 0.55 }, play: 'oneshot', maxLen: 1.5, tail: 0.6,
    desc: 'Virtuosity Drums 爵士鼓底鼓（关响弦），底鼓话筒 + 头顶话筒；自然、不过度压缩',
  },
  {
    id: 'kick.concert', role: 'kick', variant: 'concert', source: 'vcsl', kind: 'perc',
    select: [{ dir: 'Membranophones/Struck Membranophones/Bass Drum 1/', re: /\.wav$/ }],
    parse: (p) => { const m = /_v(\d)_rr(\d)/.exec(base(p)); return m && { artic: 'kick', layer: num(m[1]), rr: num(m[2]) }; },
    play: 'oneshot', maxLen: 2.5, tail: 1, lpf: 3000,
    desc: 'VCSL 音乐会大鼓轻击（短余响）+ 3 kHz 低通，更柔、更圆的“心跳”底鼓',
  },
  {
    id: 'snare.virtuosity', role: 'snare', variant: 'virtuosity', default: true, source: 'virtuosity', kind: 'perc', defaultArtic: 'center',
    select: [
      { dir: 'Samples/snaremic/snare/', re: /_(center|offcenter|crossstick|rimshot|muted|halfopen)_.*\.flac$/ },
      { dir: 'Samples/oh/snare/', re: /_(center|offcenter|crossstick|rimshot|muted|halfopen)_.*\.flac$/ },
    ],
    parse: (p) => { const m = /^(snaremic|oh)_snare_([a-z]+)_vl(\d+)(?:_rr(\d+))?$/.exec(base(p)); return m && { artic: m[2], layer: num(m[3]), rr: num(m[4], 1), mic: m[1], key: `${m[2]}_${m[3]}_${m[4] ?? 1}` }; },
    mics: { snaremic: 1, oh: 0.5 }, play: 'oneshot', maxLen: 1.5, tail: 0.5,
    desc: 'Virtuosity Drums 军鼓，默认中心击（params.variant 可选 center / offcenter / crossstick / rimshot / muted / halfopen），最多 16 层力度',
  },
  {
    id: 'snare.rim', role: 'snare', variant: 'rim', source: 'virtuosity', kind: 'derived', from: 'snare.virtuosity', defaultArtic: 'crossstick',
    play: 'oneshot', tail: 0.4,
    desc: 'Virtuosity Drums 军鼓边击（cross-stick），木质“咔”声，适合安静段落',
  },
  {
    id: 'hat.virtuosity', role: 'hat', variant: 'virtuosity', default: true, source: 'virtuosity', kind: 'perc', defaultArtic: 'closed',
    select: [{ dir: 'Samples/oh/hh/', re: /_(closed|half|open|pedal)_.*\.flac$/ }],
    parse: (p) => { const m = /^oh_hh_([a-z]+)_vl(\d+)_rr(\d+)$/.exec(base(p)); return m && { artic: m[1], layer: num(m[2]), rr: num(m[3]) }; },
    play: 'oneshot', maxLen: 3, tail: 0.4, chokeOnDur: true,
    desc: 'Virtuosity Drums 踩镲（头顶话筒），closed / half / open / pedal，4 层 × 4 轮换；dur 可截断开镲',
  },
  {
    id: 'hat.vcsl', role: 'hat', variant: 'vcsl', source: 'vcsl', kind: 'perc', defaultArtic: 'closed',
    select: [{ dir: 'Idiophones/Struck Idiophones/Hi-Hat Cymbal/', re: /\.wav$/ }],
    parse: (p) => {
      const b = base(p);
      let m = /HiHat_HitC_v(\d)_rr(\d)/.exec(b);
      if (m) return { artic: 'closed', layer: num(m[1]), rr: num(m[2]) };
      m = /HiHat_HitO_rr(\d)/.exec(b);
      if (m) return { artic: 'open', layer: 1, rr: num(m[1]) };
      m = /HiHat_HitLoose_rr(\d)/.exec(b);
      if (m) return { artic: 'half', layer: 1, rr: num(m[1]) };
      m = /HiHat_Close_rr(\d)/.exec(b);
      if (m) return { artic: 'pedal', layer: 1, rr: num(m[1]) };
      return null;
    },
    play: 'oneshot', maxLen: 3, tail: 0.4, chokeOnDur: true,
    desc: 'VCSL 踩镲（单独录制，更近更干），closed 4 层 + open / half / pedal',
  },
  // ── clap ──
  {
    id: 'clap.hand', role: 'clap', variant: 'hand', default: true, source: 'bodyperc', kind: 'perc', defaultArtic: 'handclap',
    select: [{ dir: 'Samples/body/', re: /(handclap|fingerclap|snap|pinkysnap)/ }],
    parse: (p) => { const m = /^(handclap|fingerclap|pinkysnap|snap)(?:_([lr]))?(?:_vl(\d))?_rr(\d+)$/.exec(base(p)); return m && { artic: m[1], layer: num(m[3], 1), rr: num(m[4]) + (m[2] === 'l' ? 100 : 0) }; },
    play: 'oneshot', maxLen: 1.2, tail: 0.3,
    desc: 'Body Percussion 真人拍手（handclap），params.variant 可选 fingerclap / snap / pinkysnap',
  },
  {
    id: 'clap.snap', role: 'clap', variant: 'snap', source: 'bodyperc', kind: 'derived', from: 'clap.hand', defaultArtic: 'snap',
    play: 'oneshot', tail: 0.3,
    desc: 'Body Percussion 响指（finger snap），干净、私密',
  },
  // ── shaker ──
  {
    id: 'shaker.small', role: 'shaker', variant: 'small', default: true, source: 'vcsl', kind: 'perc', defaultArtic: 'stroke',
    select: [{ dir: 'Idiophones/Struck Idiophones/Shaker, Small/', re: /\.wav$/ }],
    parse: (p) => {
      const b = base(p);
      let m = /Mid_Shaker(Double|HighFaster|LowFaster)_(Down|Up)_rr(\d)/.exec(b);
      if (m) return { artic: m[2] === 'Down' ? 'stroke' : 'up', layer: m[1] === 'HighFaster' ? 1 : m[1] === 'LowFaster' ? 2 : 3, rr: num(m[3]) };
      m = /Mid_Shaker_Slap_rr(\d)/.exec(b);
      if (m) return { artic: 'slap', layer: 1, rr: num(m[1]) };
      return null;
    },
    play: 'oneshot', maxLen: 1, tail: 0.2,
    desc: 'VCSL 小沙锤，下 / 上方向分开录制（params.variant: stroke=下拍、up=上拍、slap），按力度在 3 种手法间切换',
  },
  {
    id: 'shaker.large', role: 'shaker', variant: 'large', source: 'vcsl', kind: 'perc', defaultArtic: 'stroke',
    select: [{ dir: 'Idiophones/Struck Idiophones/Shaker, Large/', re: /\.wav$/ }, { dir: 'Idiophones/Struck Idiophones/Cabasa/', re: /\.wav$/ }],
    parse: (p) => {
      const b = base(p);
      let m = /LShaker_Shake1([DU])_rr(\d)/.exec(b);
      if (m) return { artic: m[1] === 'D' ? 'stroke' : 'up', layer: 1, rr: num(m[2]) };
      m = /LShaker_Hit_rr(\d)/.exec(b);
      if (m) return { artic: 'slap', layer: 1, rr: num(m[1]) };
      m = /Cabasa1_(Hit|Rub)(?:_v(\d))?_rr(\d)/.exec(b);
      if (m) return { artic: m[1] === 'Hit' ? 'cabasa' : 'cabasa_rub', layer: num(m[2], 1), rr: num(m[3]) };
      return null;
    },
    play: 'oneshot', maxLen: 1.5, tail: 0.25,
    desc: 'VCSL 大沙锤（更多颗粒）+ 卡巴萨（params.variant: cabasa / cabasa_rub）',
  },
  // ── perc_wood ──
  {
    id: 'perc_wood.woodblock', role: 'perc_wood', variant: 'woodblock', default: true, source: 'vcsl', kind: 'perc', defaultArtic: 'block',
    select: [{ dir: 'Idiophones/Struck Idiophones/Woodblock/', re: /\.wav$/ }],
    parse: (p) => {
      const b = base(p);
      let m = /wood_click_(pp|mp|f|ff)(?:_rr(\d))?$/.exec(b);
      if (m) return { artic: 'block', layer: DYN[m[1]], rr: num(m[2], 1) };
      m = /wood_click(2|3)_(mp|vl\d)$/.exec(b);
      if (m) return { artic: `block${m[1]}`, layer: m[2] === 'mp' ? 3 : num(m[2].slice(2)), rr: 1 };
      return null;
    },
    play: 'oneshot', maxLen: 1.2, tail: 0.3,
    desc: 'VCSL 木鱼 / 木块，pp–ff 四层（params.variant: block / block2 / block3 不同木块）',
  },
  {
    id: 'perc_wood.claves', role: 'perc_wood', variant: 'claves', source: 'vcsl', kind: 'perc', defaultArtic: 'claves1',
    select: [{ dir: 'Idiophones/Struck Idiophones/Claves/', re: /^Claves\d_Hit.*\.wav$/ }],
    parse: (p) => { const m = /Claves(\d)_Hit_v(\d)_rr(\d)/.exec(base(p)); return m && { artic: `claves${m[1]}`, layer: num(m[2]), rr: num(m[3]) }; },
    play: 'oneshot', maxLen: 1, tail: 0.25,
    desc: 'VCSL 响棒（claves），两副 × 3 层；清脆的木质高音点',
  },
  // ── perc_metal ──
  {
    id: 'perc_metal.triangle', role: 'perc_metal', variant: 'triangle', default: true, source: 'vcsl', kind: 'perc', defaultArtic: 'open',
    select: [{ dir: 'Idiophones/Struck Idiophones/Triangles/', re: /^Triangle[136]_(Hit|HitM|HitFM|hitFM)_v\d_rr\d_Mid\.wav$/ }],
    parse: (p) => { const m = /Triangle(\d)_(Hit|HitM|HitFM|hitFM)_v(\d)_rr(\d)/.exec(base(p)); return m && { artic: m[2] === 'Hit' ? 'open' : m[2] === 'HitM' ? 'muted' : 'fmuted', layer: num(m[3]), rr: num(m[1]) * 10 + num(m[4]) }; },
    play: 'oneshot', maxLen: 4, tail: 1.5, chokeOnDur: false,
    desc: 'VCSL 三角铁（3 支不同尺寸作轮换），open / muted / fmuted（手捏闷音）',
  },
  {
    id: 'perc_metal.handbells', role: 'perc_metal', variant: 'handbells', source: 'vcsl', kind: 'perc', defaultArtic: 'bell',
    select: [{ dir: 'Idiophones/Struck Idiophones/Hand Bells, Nepalese/', re: /\.wav$/ }, { dir: 'Idiophones/Struck Idiophones/Finger Cymbals/', re: /\.wav$/ }],
    parse: (p) => { const b = base(p); const m = /HB_(\d)/.exec(b); if (m) return { artic: 'bell', layer: 1, rr: num(m[1]) }; if (/Fing_Cymb/.test(b)) return { artic: 'fingercymbal', layer: 1, rr: 1 }; return null; },
    play: 'oneshot', maxLen: 5, tail: 2,
    desc: 'VCSL 尼泊尔手铃 + 指钹（params.variant: bell / fingercymbal），细小温暖的金属“叮”',
  },
  // ── impact ──
  {
    id: 'impact.bassdrum', role: 'impact', variant: 'bassdrum', default: true, source: 'vcsl', kind: 'perc', defaultArtic: 'hit',
    select: [{ dir: 'Membranophones/Struck Membranophones/Bass Drum 2/', re: /bassdrum_hit_.*\.wav$/ }],
    parse: (p) => { const m = /bassdrum_hit_(pp|mp|mf|f|ff)(\d)?$/.exec(base(p)); return m && { artic: 'hit', layer: DYN[m[1]], rr: num(m[2], 1) }; },
    play: 'oneshot', maxLen: 6, tail: 4,
    desc: 'VCSL 音乐会大鼓（Bass Drum 2）pp–ff 五层，低频厚重的英雄时刻重击',
  },
  {
    id: 'impact.timpani', role: 'impact', variant: 'timpani', source: 'vcsl', kind: 'perc', defaultArtic: 'hit',
    select: [{ dir: 'Membranophones/Struck Membranophones/Timpani 1/Hit/', re: /^Timpani[12]_Hit.*\.wav$/ }],
    parse: (p) => { const m = /Timpani(\d)_Hit_v(\d)_rr(\d)/.exec(base(p)); return m && { artic: m[1] === '1' ? 'hit' : 'hit2', layer: num(m[2]), rr: num(m[3]) }; },
    play: 'oneshot', maxLen: 6, tail: 3.5,
    desc: 'VCSL 定音鼓重击（最低两面鼓，params.variant: hit / hit2），有音高的低频冲击',
  },
  // ── swell ──
  {
    id: 'swell.cymbal', role: 'swell', variant: 'cymbal', default: true, source: 'vcsl', kind: 'perc', defaultArtic: 'cresc', swell: true,
    select: [{ dir: 'Idiophones/Struck Idiophones/Suspended Cymbal 1/', re: /susCymb1_cresc_.*\.wav$/ }],
    parse: (p) => { const m = /cresc_([\d.]+)s$/.exec(base(p)); return m && { artic: 'cresc', layer: 1, rr: Math.round(Number(m[1]) * 10) }; },
    play: 'oneshot', maxLen: 12, tail: 2.5, trimDb: -70,
    desc: 'VCSL 吊镲软槌滚奏渐强（1.5 / 2 / 4 / 7.5 秒真实录音），按 dur 选最接近的一条并微调速度，使高潮落在 t+dur',
  },
  {
    id: 'swell.reversepiano', role: 'swell', variant: 'reversepiano', source: 'osiris', kind: 'derived', from: 'piano.osiris', reverse: true, swell: true,
    play: 'oneshot', tail: 0.05, range: [36, 96],
    desc: 'Osiris Piano 真实钢琴音反向播放（midi 指定音高，默认 D3+A3+D4+F#4 和弦），在 t+dur 处收住',
  },
  // ── foley ──
  {
    id: 'foley_paper.cards', role: 'foley_paper', variant: 'cards', default: true, source: 'kenney', kind: 'perc', defaultArtic: 'slide',
    select: [{ dir: 'kenney-casino-audio/audio/Audio/', re: /card-(slide|shove|fan|place|shuffle)/ }],
    parse: (p) => { const m = /card-(slide|shove|fan|place|shuffle)(?:-(\d))?$/.exec(base(p)); return m && { artic: m[1], layer: 1, rr: num(m[2], 1) }; },
    play: 'oneshot', maxLen: 2, tail: 0.2,
    desc: 'Kenney Casino Audio 纸牌声：slide / shove / fan / place / shuffle，作纸张滑动、翻动的节奏元素',
  },
  {
    id: 'foley_paper.pages', role: 'foley_paper', variant: 'pages', source: 'kenney', kind: 'perc', defaultArtic: 'flip',
    select: [{ dir: 'kenney-rpg-audio/audio/Audio/', re: /bookFlip\d\.ogg$/ }],
    parse: (p) => { const m = /bookFlip(\d)$/.exec(base(p)); return m && { artic: 'flip', layer: 1, rr: num(m[1]) }; },
    play: 'oneshot', maxLen: 2, tail: 0.2,
    desc: 'Kenney RPG Audio 书页翻动（3 条），更“书本”的纸声',
  },
  {
    id: 'foley_pencil.writing', role: 'foley_pencil', variant: 'writing', default: true, source: 'freesound', kind: 'slices',
    select: [{ dir: 'freesound/', re: /234016/ }],
    slice: { minLen: 0.07, maxLen: 1.4, gapMs: 45, thrDb: -32 },
    play: 'oneshot', maxLen: 1.5, tail: 0.1,
    desc: 'Freesound #234016 “Writing On Paper”（rivernile7, CC0）切成单笔划，按 dur 选长度最接近的笔划',
  },
  {
    id: 'foley_pencil.scribble', role: 'foley_pencil', variant: 'scribble', source: 'freesound', kind: 'slices',
    select: [{ dir: 'freesound/', re: /(211247|82610)/ }],
    slice: { minLen: 0.07, maxLen: 1.4, gapMs: 40, thrDb: -30 },
    play: 'oneshot', maxLen: 1.5, tail: 0.1,
    desc: 'Freesound #211247 “Scribble”（Tomoyo Ichijouji）+ #82610 “scribble”（indigosierra），CC0，快速涂写',
  },
  {
    id: 'foley_book.kenney', role: 'foley_book', variant: 'kenney', default: true, source: 'kenney', kind: 'perc', defaultArtic: 'place',
    select: [{ dir: 'kenney-rpg-audio/audio/Audio/', re: /book(Place\d|Close|Open)\.ogg$/ }],
    parse: (p) => { const m = /book(Place|Close|Open)(\d)?$/.exec(base(p)); return m && { artic: m[1].toLowerCase(), layer: 1, rr: num(m[2], 1) }; },
    play: 'oneshot', maxLen: 1.5, tail: 0.2,
    desc: 'Kenney RPG Audio 书本：place（放下，3 条）/ close（合上）/ open（打开）',
  },
];

/** Freesound 单文件（预览 HQ ogg；原始文件需登录）。 */
export const FREESOUND = [
  { id: 234016, file: 'freesound/234016_writing-on-paper.ogg', url: 'https://cdn.freesound.org/previews/234/234016_3735801-hq.ogg', page: 'https://freesound.org/people/rivernile7/sounds/234016/', credit: '"Writing On Paper.wav" by rivernile7 (CC0)' },
  { id: 211247, file: 'freesound/211247_scribble.ogg', url: 'https://cdn.freesound.org/previews/211/211247_1506161-hq.ogg', page: 'https://freesound.org/people/Tomoyo%20Ichijouji/sounds/211247/', credit: '"Scribble" by Tomoyo Ichijouji (CC0)' },
  { id: 82610, file: 'freesound/82610_scribble.ogg', url: 'https://cdn.freesound.org/previews/82/82610_1316563-hq.ogg', page: 'https://freesound.org/people/indigosierra/sounds/82610/', credit: '"scribble.mp3" by indigosierra (CC0)' },
];

/** 开源脉冲响应（OpenAIR，CC BY 4.0）。 */
export const IRS = [
  {
    name: 'room', file: 'elveden_smoking_room.wav',
    url: 'https://webfiles.york.ac.uk/OPENAIR/IRs/elveden-hall-suffolk-england/stereo/18a_smoking_room.wav',
    desc: '小房间：Elveden Hall 吸烟室（木饰墙面的小客厅），近、暖',
    credit: 'Elveden Hall, Suffolk — Smoking Room. OpenAIR, Audiolab, University of York (www.openairlib.net), CC BY 4.0',
  },
  {
    name: 'wood', file: 'spokane_womans_club.wav',
    url: 'https://webfiles.york.ac.uk/OPENAIR/IRs/spokane-womans-club/stereo/spokane_womans_club_ir.wav',
    desc: '木质空间：Spokane Woman\'s Club 礼堂（木结构中型厅）',
    credit: 'Spokane Woman\'s Club. OpenAIR, Audiolab, University of York (www.openairlib.net), CC BY 4.0',
  },
  {
    name: 'hall', file: 'elveden_marble_hall.wav',
    url: 'https://webfiles.york.ac.uk/OPENAIR/IRs/elveden-hall-suffolk-england/stereo/1a_marble_hall.wav',
    desc: '中等厅堂：Elveden Hall 大理石厅，明亮、较长的尾音',
    credit: 'Elveden Hall, Suffolk — Marble Hall. OpenAIR, Audiolab, University of York (www.openairlib.net), CC BY 4.0',
  },
];
export const IR_LICENSE = 'CC-BY-4.0';
