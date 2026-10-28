/* ============================================================
   神经星环主题本体
   ------------------------------------------------------------
   来源：agent-display「03 · NEURAL 神经星环」
         SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
         Required Notice: Copyright (c) 2026 赛博老爸
         非商业用途可免费使用；商业使用需另行获得授权。
         https://github.com/cyberdaddyleo/agent-display
   改动：把「智能体 / 工作流 / 渠道」换成插件的「星域 / 记忆类型 /
         记忆状态」，数据全部来自插件真实接口；其余渲染与交互原样保留。
   ============================================================ */
var BSM_THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.147.0/";
var BSM_THREE_DEPS = ["build/three.min.js", "examples/js/shaders/CopyShader.js",
  "examples/js/shaders/LuminosityHighPassShader.js", "examples/js/postprocessing/EffectComposer.js",
  "examples/js/postprocessing/RenderPass.js", "examples/js/postprocessing/ShaderPass.js",
  "examples/js/postprocessing/UnrealBloomPass.js"].map(function (p) { return BSM_THREE_CDN + p; });

function BSM_loadScripts(list) {
  return list.reduce(function (p, src) {
    return p.then(function () {
      return new Promise(function (res) {
        var s = document.createElement("script");
        s.src = src;
        s.onload = res;
        s.onerror = res;
        document.head.appendChild(s);
      });
    });
  }, Promise.resolve());
}

window.BSMNeural = {
  deps: BSM_THREE_DEPS,
  loadScripts: BSM_loadScripts,
  mount: mountNeural
};

function mountNeural(host, SR){
'use strict';

/* ================= 0. 工具 ================= */
const $ = s => SR.querySelector(s), $$ = s => SR.querySelectorAll(s);
const TAU = Math.PI * 2;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapPI = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = n => Math.round(n).toLocaleString('en-US');
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const hex3 = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = mulberry32(20261020);                       // 几何用固定种子：每次打开星环长得一样
const rg = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
const MONO = '"JetBrains Mono","Noto Sans SC","PingFang SC",ui-monospace,Menlo,monospace';
const CJK = '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';

/* ================= 1. 配置：记忆就是星 —— 11 个星域 + 记忆中枢 + 遗忘站 + 维护探针 =================
   结构沿用 agent-display「03 · NEURAL 神经星环」：0 号是中枢，1..11 是神经团（这里对应星域），
   12 号是复核站（这里对应"半衰期到了 → 归档"），13 号是巡检探针（每日遗忘维护）。
   数据全部来自插件真实接口，不造假。 */
const MODEL = window.__BSM_MODEL__ || {scopes: [], stars: [], totals: {}, types: []};
const SCOPE_SLOTS = 11;
const SCOPE_COLORS = ['#2fd27a', '#a774ff', '#ff4458', '#ff5cae', '#3b7cff', '#25d6f0',
                      '#ff9a1f', '#ffd23f', '#ff7b54', '#b5ef3a', '#62e6c7'];
const AG = [];
AG[0] = {k: 'CORE', zh: '记忆中枢', role: '写入 · 巩固 · 召回', tag: 'ENGINE', col: '#f3f4f8', sp: 1};
for (let i = 0; i < SCOPE_SLOTS; i++) {
  const s = MODEL.scopes[i];
  AG[1 + i] = s
    ? {k: s.short, zh: s.scope, role: `${s.total} 颗星 · 明亮 ${s.active}`, tag: 'SCOPE', col: SCOPE_COLORS[i % 11], sp: .55 + Math.min(.45, (s.total || 0) / 60)}
    : {k: 'IDLE', zh: '空位', role: '暂无记忆', tag: 'IDLE', col: '#39424f', sp: .6};
}
AG[12] = {k: 'FADE', zh: '遗忘站', role: '半衰期到了就熄灯', tag: 'DECAY', col: '#ff9a1f', sp: .9};
AG[13] = {k: 'MAINT', zh: '维护', role: '半衰期扫描 · 变暗归档', tag: 'MAINT', col: '#45e6f5', sp: 1};
const PROOF = 12, CRAWLER = 13, NCL = 13;               // 0 中枢 / 1..11 星域 / 12 遗忘站 / 13 维护探针

// 记忆类型 = 工作流：决定这颗星归属哪个星域、最终落到哪个状态环
const TYPE_ZH = {fact: '事实', event: '经历', preference: '偏好', promise: '约定',
                 emotion: '情绪', skill: '技能', commitment: '约定', insight: '灵光',
                 task: '待办', person: '人物', profile: '画像', other: '其他'};
const types = (MODEL.types && MODEL.types.length ? MODEL.types : [{key: 'other', count: 0, scopeIndex: 0, ch: 0, names: []}]).slice(0, 11);
function buildWF(list){
  return list.map((t, i) => {
    const scopeSlot = 1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, t.scopeIndex == null ? 0 : t.scopeIndex));
    return {
      id: 'M' + String(i + 1).padStart(2, '0'),
      zh: TYPE_ZH[t.key] || t.key || '记忆',
      ch: (t.ch == null ? i % 6 : t.ch),
      path: t.faded ? [scopeSlot, PROOF] : [scopeSlot],
      names: (t.names && t.names.length ? t.names : [TYPE_ZH[t.key] || t.key || '记忆'])
    };
  });
}
const WF = buildWF(types);
const CH = [{zh: '明亮', en: 'ACTIVE', col: '#2fd27a'}, {zh: '变暗', en: 'FADED', col: '#ff9a1f'},
            {zh: '归档', en: 'ARCHIVE', col: '#9aa6ff'}, {zh: '置顶', en: 'PIN', col: '#ff3f8e'},
            {zh: '纠正', en: 'FIX', col: '#25d6f0'}, {zh: '星核', en: 'CORE', col: '#ffd23f'}];
const CHECKS = ['清晰度不足', '时效已过', '情绪残留低', '主体含糊', '重复冗余'];
const BAD = '#ff4d5e', CYAN = '#45e6f5';
const DAY_TARGET = (MODEL.dayTarget || 30), PER_MIN = (MODEL.recallRate || 6);
const PRICE = {inMiss: 2, inHit: .5, out: 8};                                   // 占位：算力栏已改成情绪残留
const TOKR = [25, 140, 90, 150, 110, 160, 30, 80, 60, 50, 40, 90, 25];         // 每个星域的活跃权重
const INR  = [.8, .92, .7, .55, .6, .62, .75, .88, .8, .7, .75, .7, .85];      // 情绪占比
let AGC = AG.map(a => hex3(a.col));

/* ================= 2. 模拟状态（接真实数据时替换这一段） ================= */
let simT = 0, animT = 0, paused = false;
let tid = 0, chiefT = 1.0, chiefDur = 1.0, passN = 0, failN = 0, lastDispatch = '—';
let reinforced = 0;                                        // 本次会话里被重新点亮的星星数
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
let total = (MODEL.todayNew || 0);                        // 今日新写入的星星
let tokDay = (MODEL.emotionEnergy || 0);                  // 情绪残留总量（替代 token 账）
let tokIn = tokDay * .7, tokOut = tokDay - tokIn, cacheHit = .62;
const costDay = () => (tokIn * (1 - cacheHit) * PRICE.inMiss + tokIn * cacheHit * PRICE.inHit + tokOut * PRICE.out) / 1e6;
const tokWin = new Array(24).fill(0); let tokWinAcc = 0, tokWinCur = 0;     // 最近 60 秒（24 × 2.5s）用来算每分钟速率
let sumTOKR = TOKR.reduce((p, v) => p + v, 0);
for (let i = 0; i < 24; i++) tokWin[i] = sumTOKR * .62 * 2.5 * rnd(.8, 1.2);
AG.forEach((a, i) => Object.assign(a, {i, inbox: [], cur: null, prog: 0, dur: 1, outs: (i > 0 && i < 13) ? 20 + ((Math.random() * 40) | 0) : 0,
  tok: tokDay * (TOKR[i] || 0) / sumTOKR * rnd(.85, 1.15), act: .05, flash: 0, bad: 0, hitT: 0}));
const workers = AG.slice(1, 13);
const tasks = [], feed = [], signals = [];
let feedDirty = true, capDirty = true, tapeDirty = true;
let caption = {a: 0, verb: '派单', text: '—', kind: ''};
const tape = [];
const rateBins = new Array(60).fill(0); let rateCur = 0, rateAcc = 0;
for (let i = 0; i < 60; i++) rateBins[i] = Math.round(rnd(1, 4));
const HEATN = 12, HEAT_SLOT = 2.5;
const heat = Array.from({length: 12}, (_, r) => Array.from({length: HEATN}, () => .05));
const heatCur = new Array(12).fill(0); let heatAcc = 0;
const NSEG = 72, SEG_SLOT = 1.4;                       // 条码环：每块 = 1.4 秒内的 token 量
const slotVals = Array.from({length: NSEG}, () => .05), slotDisp = slotVals.slice();
const slotDims = Array.from({length: NSEG}, () => new Array(6).fill(.05));   // 每颗星 6 个维度：保持/清晰/重要/情绪/复访/召回
let slotHead = 0, slotAcc = 0, slotTok = 0;
const crawl = {patrols: 0, read: 0, bugs: 0, target: 0};
const chanN = CH.map(() => 0), chanFlash = CH.map(() => 0);
let boost = 0, lastHand = null, bunHot = new Float32Array(48);

// 星星池：插件接口真实返回的星星，按「该被想起」排序轮流上场
const starPool = (MODEL.stars || []).map(s => ({
  id: s.id, content: s.content, scope: s.scope, type: s.type, status: s.status,
  retention: Number(s.retention) || 0, clarity: Number(s.clarity) || 0,
  importance: Number(s.importance) || 0, valence: Number(s.valence) || 0,
  arousal: Number(s.arousal) || 0, pinned: !!s.pinned,
  scopeIndex: s.scopeIndex == null ? 0 : s.scopeIndex, wf: s.wf || 0
}));
let starCursor = 0;
function nextStar(){
  if (!starPool.length) return null;
  const s = starPool[starCursor % starPool.length]; starCursor++;
  return s;
}
function starLabel(s){
  const c = String(s.content || '').replace(/\s+/g, ' ').trim();
  return (c.length > 18 ? c.slice(0, 17) + '…' : c) || ('#' + s.id);
}
function newTask(wi){
  const w = WF[wi] || WF[0];
  const s = nextStar();
  const t = {id: s ? ('#' + s.id) : ('M-' + pad(++tid, 3)), wf: wi, name: s ? starLabel(s) : (w.names[0] || '记忆'),
             star: s || null, stage: 0, rework: 0, born: simT, fail: false, failIdx: 0, path: null};
  if (s) {
    // 这颗星真实的状态决定它走哪条路：变暗/熄灭的星要先过遗忘站
    const slot = 1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, s.scopeIndex || 0));
    t.path = (s.status === 'faded' || s.status === 'archived') ? [slot, PROOF] : [slot];
  }
  tasks.push(t);
  return t;
}
function log(ai, verb, text, kind){
  feed.unshift({t: hms(new Date()), a: ai, verb, text, kind: kind || ''});
  if (feed.length > 40) feed.pop();
  caption = {a: ai, verb, text, kind: kind || ''};
  tape.unshift(`${AG[ai].k} ${verb} ${text}`); if (tape.length > 40) tape.pop();
  AG[ai].hitT = 1.2;
  feedDirty = capDirty = tapeDirty = true;
}
const queueTotal = () => workers.reduce((n, a) => n + a.inbox.length, 0);
const liveN = () => workers.filter(a => a.cur).length;
const inFlight = () => signals.filter(s => s.kind !== 'ray').length;

function dispatch(){
  // 记忆中枢想起一颗该想起的星：脉冲沿突触束送到它所在的星域
  const free = a => !a.cur && !a.inbox.length;
  const score = WF.map((w, i) => ({i, s: w.path.reduce((n, ai, k) => n + (free(AG[ai]) ? (k === 0 ? 2 : 1) : 0), 0) + Math.random() * .8}));
  score.sort((p, q) => q.s - p.s);
  const wi = Math.random() < .85 ? score[0].i : (Math.random() * WF.length) | 0;
  const t = newTask(wi);
  const slot = 1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, t.star ? t.star.scopeIndex : 0));
  const b = AG[slot];
  lastDispatch = t.id;
  log(0, '想起', `${t.id} ${t.name} → ${b.k}`);
  AG[0].flash = 1;
  sendSignal(0, b.i, b.col, () => b.inbox.push(t), 'dispatch');
}
function startWork(a){
  const t = a.inbox.shift();
  a.cur = t; a.prog = 0; a.dur = rnd(5, 9.5) * a.sp * (t.rework ? .75 : 1);
  if (a.i === PROOF) {
    // 到了遗忘站：真实状态是变暗/熄灭的星才归档，不随机编
    t.fail = !!(t.star && (t.star.status === 'archived' || t.star.status === 'faded')) && t.rework < 2;
    t.failIdx = t.star ? (t.star.clarity < .55 ? 0 : (t.star.retention < .45 ? 1 : 2)) : 0;
  }
  log(a.i, '接手', `${t.id} ${t.name}`);
}
function finishStage(a){
  const t = a.cur, path = t.path || WF[t.wf].path;
  a.cur = null; a.prog = 0; a.outs++;
  if (a.i === PROOF && t.fail) {
    // 到了维护站：半衰期到了、清晰度不够 → 这颗星归档
    t.rework++; t.stage--; t.fail = false; failN++;
    const b = AG[path[t.stage]], item = CHECKS[t.failIdx];
    log(a.i, '归档', `${t.id} ${item} → ${b.k} 熄灯`, 'bad');
    a.bad = 1;
    sendSignal(a.i, b.i, BAD, () => b.inbox.push(t), 'bad');
    return;
  }
  if (a.i === PROOF) passN++;
  if (t.stage < path.length - 1) {
    t.stage++;
    const b = AG[path[t.stage]];
    log(a.i, '交接', `${t.id} ${t.name} → ${b.k}`);
    sendSignal(a.i, b.i, a.col, () => b.inbox.push(t), 'hand');
  } else deliver(a, t);
}
function deliver(a, t){
  const w = WF[t.wf] || WF[0];
  const faded = !!(t.star && (t.star.status === 'archived' || t.star.status === 'faded'));
  reinforced++;
  passN++;
  tasks.splice(tasks.indexOf(t), 1);
  if (faded) log(a.i, '归档', `${t.id} ${t.name} → ${CH[2].zh}`, 'bad');
  else log(a.i, '强化', `${t.id} ${t.name} → ${CH[w.ch].zh}`, 'ship');
  sendRay(a.i, faded ? 2 : w.ch);
  boost = Math.min(1.4, boost + .4);
}

/* 巡检探针：在神经团之间沿外弧飞，落地就扫一圈 */
const probe = {p: null, a: null, b: null, c: null, u: 1, dur: 2, dwell: 1.2, trail: []};
function crawlerStep(dt){
  if (!probe.p) return;
  if (probe.u < 1) {
    probe.u = Math.min(1, probe.u + dt / probe.dur);
    const u = probe.u, v = 1 - u;
    probe.p.set(v * v * probe.a.x + 2 * v * u * probe.c.x + u * u * probe.b.x, v * v * probe.a.y + 2 * v * u * probe.c.y + u * u * probe.b.y, v * v * probe.a.z + 2 * v * u * probe.c.z + u * u * probe.b.z);
    if (probe.u >= 1) probeArrive();
  } else if ((probe.dwell -= dt) <= 0) probeNext();
}
function probeNext(){
  const busy = workers.filter(a => a.cur && a.i !== crawl.target);
  const k = busy.length && Math.random() < .8 ? pick(busy).i : 1 + ((Math.random() * 12) | 0);
  crawl.target = k;
  probe.a.copy(probe.p);
  const C = CL[k], out = new THREE.Vector3(C.x, C.y, 0).normalize();
  probe.b.set(C.x + out.x * .1, C.y + out.y * .1, C.z + .12);
  const mid = probe.a.clone().add(probe.b).multiplyScalar(.5), m = Math.hypot(mid.x, mid.y) || .01;
  probe.c.set(mid.x / m * 1.72, mid.y / m * 1.72, mid.z + rnd(-.3, .5));
  probe.u = 0; probe.dur = clamp(probe.a.distanceTo(probe.b) / 1.5, .9, 2.4);
}
function probeArrive(){
  probe.dwell = rnd(1.6, 3.0);
  crawl.patrols++; crawl.read += 1 + ((Math.random() * 6) | 0);
  scanAt(crawl.target);
  const a = AG[crawl.target];
  if (a.cur && Math.random() < .07) { crawl.bugs++; log(CRAWLER, '变暗', `${a.cur.id} ${a.cur.name} · 提醒 ${a.k}`, 'bad'); a.bad = .7; }
    else if (Math.random() < .2) log(CRAWLER, '巡检', `${a.k} · ${a.cur ? a.cur.id + ' 半衰期扫描' : '待命中'}`);
}

function simStep(dt){
  simT += dt;
  chiefT -= dt;
  if (chiefT <= 0) { if (queueTotal() + inFlight() < 15) dispatch(); chiefDur = chiefT = rnd(1.2, 2.4); }
  for (const a of workers) {
    if (!a.cur && a.inbox.length) startWork(a);
    if (a.cur) { a.prog += dt / a.dur; if (a.prog >= 1) finishStage(a); }
  }
  // 信号前进；到站时把任务交给下一个
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i];
    s.u += dt / s.dur;
    if (s.bun >= 0) bunHot[s.bun] = 1;
    if (s.mid && !s.midDone && s.u >= s.mid) { s.midDone = true; s.onMid(); }
    if (s.kind === 'ray' && glOK && !s.hit && s.u <= 1) { s.path(s.u, tmpV); const r = Math.hypot(tmpV.x, tmpV.y); if ((s.lr || 0) < HIT_R && r >= HIT_R) { s.hit = true; hitRing(Math.atan2(tmpV.y, tmpV.x) + spin.rotation.z, s.col); } s.lr = r; }
    if (s.u >= 1 && !s.done) { s.done = true; if (s.to >= 0) { AG[s.to].flash = 1; } if (s.cb) s.cb(); }
    if (s.u >= 1 + s.tr * s.gap) signals.splice(i, 1);
  }
  // token 账
  for (let i = 0; i < 13; i++) {
    const a = AG[i];
    if (!(i === 0 || a.cur)) continue;
    const amt = TOKR[i] * dt * rnd(.6, 1.4);
    a.tok += amt; tokDay += amt; tokIn += amt * INR[i]; tokOut += amt * (1 - INR[i]);
    slotTok += amt; tokWinCur += amt;
    if (i > 0) heatCur[i - 1] += amt;
  }
  cacheHit = clamp(cacheHit + (Math.random() - .5) * .01 * dt, .55, .7);
  if ((tokWinAcc += dt) >= 2.5) { tokWin.push(tokWinCur); tokWin.shift(); tokWinCur = 0; tokWinAcc = 0; }
  if ((heatAcc += dt) >= HEAT_SLOT) {
    heat.forEach((row, r) => { row.push(heatCur[r] / (TOKR[r + 1] * HEAT_SLOT)); row.shift(); heatCur[r] = 0; });
    heatAcc = 0;
  }
  if ((slotAcc += dt) >= SEG_SLOT) {
    // 星环的每一段代表一颗真实的星星，值由 setModel 写入，模拟只推进环的转角
    slotHead++; slotAcc = 0; slotTok = 0;
  }
  if ((rateAcc += dt) >= 1) { rateBins.push(rateCur); rateBins.shift(); rateCur = 0; rateAcc = 0; }
  crawlerStep(dt);
  partStep(dt);
}

/* ================= 3. 3D 场景 ================= */
const THREE = window.THREE;
const cv = $('#gl');
let renderer = null, scene, camera, composer = null, bloomPass = null, world, hud, spin;   // spin：神经网 + 智能体扇区环，一起慢转
let trGeo, coreSpr, brainLines, brainPts, sigGeo, sigMat, streaks, dust, barcode, tapeRing, ringRing, dashRing, sweep, tickA, tickB, arcsA, arcsB;
let ringTex, tapeTex, ringCtx, tapeCtx;
const AF = new Float32Array(96);                       // 每组 (活跃度, 聚焦系数)：0..12 神经团，13 背景，14+ 突触束
const focT = new Float32Array(48).fill(1);
for (let i = 0; i < 48; i++) { AF[i * 2] = .1; AF[i * 2 + 1] = 1; }
const SEC_A = TAU / NCL;
const secAng = k => Math.PI / 2 - k * SEC_A;            // 扇区中心角：CHIEF 在正上方，顺时针排
const CL = [];
const BUN = [], BMAP = {};
const chanAng = CH.map((_, j) => Math.PI / 2 - (j + .5) * TAU / 6 - .12);
let chanPos = [], chanSpr = [], scans = [];
const HIT_R = 2.05;                                   // 能量格那一圈的半径
const segFlash = new Float32Array(NSEG), segCol = Array.from({length: NSEG}, () => [1, 1, 1]);
const hits = [];
let NEU = 0, SYN = 0, NX = null, NY = null, NZ = null, MEM = null;
let glOK = false;
let mono = 0, bloomOn = true, pr = 1;          // 全程彩色 + 辉光

function spriteTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.18, 'rgba(255,255,255,.85)'); g.addColorStop(.42, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}
let SPRITE = null;

const BRAIN_VS_L = `
attribute vec3 col; attribute float grp; attribute float shade;
uniform vec2 af[48]; uniform float uMono; uniform float uFade; uniform float uGain;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec2 q = af[int(grp + 0.5)];
  float a = clamp(q.x, 0.0, 1.5);
  vec3 silver = vec3(0.74, 0.81, 0.92);
  vec3 base = mix(col, silver, uMono);
  vec3 lit = mix(col * 1.3 + 0.06, vec3(1.0), 0.2);
  vCol = mix(base, lit, clamp(a, 0.0, 1.0) * (0.35 + 0.65 * uMono));
  float depth = clamp((-mv.z - uFade) / 5.0, 0.0, 1.0);
  vA = shade * (0.55 + a * 1.3) * (1.0 - depth * 0.5) * q.y * uGain;
  gl_Position = projectionMatrix * mv;
}`;
const BRAIN_FS_L = `
varying vec3 vCol; varying float vA;
void main(){ gl_FragColor = vec4(vCol, vA); }`;
const BRAIN_VS_P = `
attribute vec3 col; attribute float grp; attribute float sz; attribute float ph;
uniform vec2 af[48]; uniform float uMono; uniform float uTime; uniform float uPx; uniform float uFade; uniform float uGain;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec2 q = af[int(grp + 0.5)];
  float a = clamp(q.x, 0.0, 1.5);
  float tw = 0.62 + 0.38 * sin(uTime * (0.9 + ph * 2.2) + ph * 40.0);
  vec3 silver = vec3(0.86, 0.9, 0.98);
  vCol = mix(mix(col, silver, uMono), col * 1.25 + 0.22, clamp(a, 0.0, 1.0) * (0.3 + 0.7 * uMono));
  float depth = clamp((-mv.z - uFade) / 5.0, 0.0, 1.0);
  vA = (0.42 + a * 1.1) * tw * (1.0 - depth * 0.55) * q.y * (0.4 + 0.6 * uGain);
  gl_PointSize = max(1.0, sz * uPx * (1.0 + a * 0.55) / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PT_FS = `
uniform sampler2D map; varying vec3 vCol; varying float vA;
void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vCol, t.a * vA); }`;
const SIG_VS = `
attribute vec3 col; attribute float sz; attribute float al;
uniform float uPx;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vCol = col; vA = al;
  gl_PointSize = sz <= 0.0 ? 0.0 : max(1.5, sz * uPx / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const STREAK_VS = `
attribute vec3 dir; attribute float r0; attribute float len; attribute float spd; attribute float endp;
uniform float uTime; uniform float uBoost;
varying float vA;
void main(){
  float span = 15.0;
  float r = 3.1 + mod(r0 + uTime * spd * (1.0 + uBoost * 2.5), span);
  float rr = r + endp * len * (1.0 + uBoost * 1.6);
  vA = smoothstep(3.1, 4.6, r) * (1.0 - smoothstep(11.0, 18.1, r)) * (0.25 + 0.75 * endp);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * rr, 1.0);
}`;
const STREAK_FS = `
varying float vA;
void main(){ gl_FragColor = vec4(0.72, 0.84, 1.0, vA * 0.42); }`;

function randUnit(){ let x, y, z, d; do { x = R() * 2 - 1; y = R() * 2 - 1; z = R() * 2 - 1; d = x * x + y * y + z * z; } while (d > 1 || d < .01); d = Math.sqrt(d); return new THREE.Vector3(x / d, y / d, z / d); }

function buildBrain(){
  SPRITE = spriteTexture();
  const V = THREE.Vector3;
  CL.push(new V(0, 0, 0));
  for (let i = 1; i <= 12; i++) { const a = secAng(i), r = 1.1 + (R() - .5) * .12; CL.push(new V(Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? 1 : -1) * (.14 + R() * .26))); }
  const px = [], py = [], pz = [], ng = [], nc = [], ns = [], members = Array.from({length: NCL}, () => []);
  function addN(x, y, z, g, c, s){
    const r = Math.hypot(x, y, z), lim = 1.8;
    if (r > lim) { const k = (lim - R() * .12) / r; x *= k; y *= k; z *= k; }
    const i = px.length; px.push(x); py.push(y); pz.push(z); ng.push(g); nc.push(c); ns.push(s);
    if (g < NCL) members[g].push(i);
    return i;
  }
  for (let c = 0; c < NCL; c++) {
    const C = CL[c], chief = c === 0;
    const n = chief ? 620 : 380, sig = chief ? .2 : .14;
    for (let k = 0; k < (chief ? 5 : 3); k++) addN(C.x + rg() * .025, C.y + rg() * .025, C.z + rg() * .025, c, c, chief ? .09 : .068);
    const core = Math.round(n * .4);
    for (let k = 0; k < core; k++) addN(C.x + rg() * sig, C.y + rg() * sig, C.z + rg() * sig * .9, c, c, .016 + R() * .016);
    const nd = chief ? 18 : 11, per = Math.round((n - core) / nd);
    for (let d = 0; d < nd; d++) {
      const dir = randUnit(), len = chief ? .68 + R() * .6 : .32 + R() * .42;
      const perp = randUnit().cross(dir).normalize(), bend = (R() - .5) * .3;
      for (let k = 0; k < per; k++) {
        const u = Math.pow(R(), .8), off = Math.sin(u * Math.PI) * bend, j = .018 + .035 * u;
        addN(C.x + dir.x * len * u + perp.x * off + rg() * j, C.y + dir.y * len * u + perp.y * off + rg() * j, C.z + dir.z * len * u + perp.z * off + rg() * j, c, c, .012 + R() * .012);
      }
    }
  }
  // 背景灰质：中心更密，铺满整个球，让星云连成一片
  for (let k = 0; k < 4200; k++) {
    let x, y, z; do { x = R() * 2 - 1; y = R() * 2 - 1; z = R() * 2 - 1; } while (x * x + y * y + z * z > 1);
    const dd = Math.hypot(x, y, z) || 1, rr = Math.pow(dd, 1.35) / dd;
    x *= 1.78 * rr; y *= 1.78 * rr; z *= 1.45 * rr;
    let best = 0, bd = 1e9;
    for (let c = 0; c < NCL; c++) { const d = (x - CL[c].x) ** 2 + (y - CL[c].y) ** 2 + (z - CL[c].z) ** 2; if (d < bd) { bd = d; best = c; } }
    addN(x, y, z, 13, best, .009 + R() * .011);
  }
  const N = px.length; NEU = N;
  NX = Float32Array.from(px); NY = Float32Array.from(py); NZ = Float32Array.from(pz); MEM = members;
  const ncol = i => { const c = AGC[nc[i]], k = ng[i] === 13 ? .72 : 1; return [c[0] * k, c[1] * k, c[2] * k]; };

  // 局部连接：空间网格找最近邻
  const CELL = .16, grid = new Map(), key = (a, b, c) => a + ',' + b + ',' + c;
  for (let i = 0; i < N; i++) { const k = key(Math.floor(px[i] / CELL), Math.floor(py[i] / CELL), Math.floor(pz[i] / CELL)); let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(i); }
  const seen = new Set(), LP = [], LC = [], LG = [], LS = [];
  function seg(x1, y1, z1, x2, y2, z2, c1, c2, g, s){ LP.push(x1, y1, z1, x2, y2, z2); LC.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]); LG.push(g, g); LS.push(s, s); }
  let syn = 0;
  for (let i = 0; i < N; i++) {
    const gx = Math.floor(px[i] / CELL), gy = Math.floor(py[i] / CELL), gz = Math.floor(pz[i] / CELL);
    const K = 3, maxD = ng[i] === 13 ? .28 : .22, cand = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const arr = grid.get(key(gx + a, gy + b, gz + c)); if (!arr) continue;
      for (const j of arr) { if (j === i) continue; const d = (px[i] - px[j]) ** 2 + (py[i] - py[j]) ** 2 + (pz[i] - pz[j]) ** 2; if (d < maxD * maxD) cand.push([d, j]); }
    }
    cand.sort((p, q) => p[0] - q[0]);
    for (let n = 0; n < Math.min(K, cand.length); n++) {
      const j = cand[n][1], lo = Math.min(i, j), hi = Math.max(i, j), id = lo * N + hi;
      if (seen.has(id)) continue; seen.add(id);
      const same = ng[i] === ng[j] && ng[i] < NCL;
      seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), same ? ng[i] : 13, same ? .55 : .32);
      syn++;
    }
  }
  // 远程细丝：让网更密、更乱一点
  for (let k = 0; k < 12000; k++) {
    const i = (R() * N) | 0, j = (R() * N) | 0;
    const d = Math.hypot(px[i] - px[j], py[i] - py[j], pz[i] - pz[j]);
    if (d < .22 || d > .6) continue;
    seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), 13, .15); syn++;
  }
  // 突触束：工作流里相邻的两个智能体之间、CHIEF 到每条流程的第一棒
  const pairs = new Map(), addPair = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b), k = lo + '-' + hi; if (!pairs.has(k)) pairs.set(k, {a: lo, b: hi}); };
  WF.forEach(w => { addPair(0, w.path[0]); for (let k = 0; k < w.path.length - 1; k++) addPair(w.path[k], w.path[k + 1]); });
  [...pairs.values()].forEach((p, bi) => {
    const g = 14 + bi; if (g >= 48) return;
    const strands = [], ns2 = p.a === 0 ? 10 : 14;
    for (let s = 0; s < ns2; s++) {
      const i0 = members[p.a][(R() * members[p.a].length) | 0], i1 = members[p.b][(R() * members[p.b].length) | 0];
      const p0 = new V(px[i0], py[i0], pz[i0]), p1 = new V(px[i1], py[i1], pz[i1]);
      const mid = p0.clone().add(p1).multiplyScalar(.5);
      let c;
      if (p.a === 0) c = mid.clone().add(randUnit().multiplyScalar(.14));
      else { const m = Math.hypot(mid.x, mid.y) || .01, push = .17 + R() * .24 + (1 - Math.min(1, m / 1.2)) * .26; c = new V(mid.x + mid.x / m * push, mid.y + mid.y / m * push, mid.z + (R() - .5) * .5); }
      strands.push({p0, c, p1, len: p0.distanceTo(c) + c.distanceTo(p1)});
      const ca = AGC[p.a], cb = AGC[p.b], SEG = 12;
      let lx = p0.x, ly = p0.y, lz = p0.z;
      for (let k = 1; k <= SEG; k++) {
        const u = k / SEG, v = 1 - u;
        const x = v * v * p0.x + 2 * v * u * c.x + u * u * p1.x, y = v * v * p0.y + 2 * v * u * c.y + u * u * p1.y, z = v * v * p0.z + 2 * v * u * c.z + u * u * p1.z;
        const u0 = (k - 1) / SEG;
        seg(lx, ly, lz, x, y, z, [ca[0] + (cb[0] - ca[0]) * u0, ca[1] + (cb[1] - ca[1]) * u0, ca[2] + (cb[2] - ca[2]) * u0], [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u], g, .16);
        lx = x; ly = y; lz = z;
      }
      syn++;
    }
    const b = {a: p.a, b: p.b, g, strands}; BUN.push(b); BMAP[p.a + '-' + p.b] = b;
  });
  SYN = syn;

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3));
  lg.setAttribute('col', new THREE.Float32BufferAttribute(LC, 3));
  lg.setAttribute('grp', new THREE.Float32BufferAttribute(LG, 1));
  lg.setAttribute('shade', new THREE.Float32BufferAttribute(LS, 1));
  const uni = {af: {value: AF}, uMono: {value: 0}, uFade: {value: 8}, uTime: {value: 0}, uPx: {value: 800}, uGain: {value: 1}, map: {value: SPRITE}};
  brainLines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({uniforms: uni, vertexShader: BRAIN_VS_L, fragmentShader: BRAIN_FS_L, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  spin.add(brainLines);

  const pg = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), col = new Float32Array(N * 3), grp = new Float32Array(N), sz = new Float32Array(N), ph = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i]; const c = ncol(i); col.set(c, i * 3); grp[i] = ng[i]; sz[i] = ns[i]; ph[i] = R(); }
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('col', new THREE.BufferAttribute(col, 3));
  pg.setAttribute('grp', new THREE.BufferAttribute(grp, 1)); pg.setAttribute('sz', new THREE.BufferAttribute(sz, 1)); pg.setAttribute('ph', new THREE.BufferAttribute(ph, 1));
  brainPts = new THREE.Points(pg, new THREE.ShaderMaterial({uniforms: uni, vertexShader: BRAIN_VS_P, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  spin.add(brainPts);

  // 信号脉冲：一个点缓冲，头亮尾暗
  const SIGN = 4000;
  sigGeo = new THREE.BufferGeometry();
  sigGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SIGN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('col', new THREE.BufferAttribute(new Float32Array(SIGN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('sz', new THREE.BufferAttribute(new Float32Array(SIGN), 1).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('al', new THREE.BufferAttribute(new Float32Array(SIGN), 1).setUsage(THREE.DynamicDrawUsage));
  sigMat = new THREE.ShaderMaterial({uniforms: {map: {value: SPRITE}, uPx: uni.uPx}, vertexShader: SIG_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const sp = new THREE.Points(sigGeo, sigMat); sp.frustumCulled = false; spin.add(sp);
  trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6000 * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6000 * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setDrawRange(0, 0);
  const tl = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
  tl.frustumCulled = false; spin.add(tl);

  probe.p = new V(CL[3].x, CL[3].y, CL[3].z + .12); probe.a = probe.p.clone(); probe.b = probe.p.clone(); probe.c = probe.p.clone();
}

/* ---------- HUD 星环 ---------- */
function lineMat(op, col){ return new THREE.LineBasicMaterial({color: col || 0xd4e8ff, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false}); }
function circle(r, z, op, seg = 320){ const a = new Float32Array(seg * 3); for (let i = 0; i < seg; i++) { const t = i / seg * TAU; a[i * 3] = Math.cos(t) * r; a[i * 3 + 1] = Math.sin(t) * r; a[i * 3 + 2] = z; } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); return new THREE.LineLoop(g, lineMat(op)); }
function ticks(r, n, len, every, long, op){ const a = []; for (let i = 0; i < n; i++) { const t = i / n * TAU, l = i % every === 0 ? long : len; a.push(Math.cos(t) * r, Math.sin(t) * r, 0, Math.cos(t) * (r + l), Math.sin(t) * (r + l), 0); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return new THREE.LineSegments(g, lineMat(op)); }
function arcs(r, list, op){ const a = []; list.forEach(([t0, t1]) => { const n = Math.max(4, Math.round((t1 - t0) / .02)); for (let i = 0; i < n; i++) { const u0 = t0 + (t1 - t0) * i / n, u1 = t0 + (t1 - t0) * (i + 1) / n; a.push(Math.cos(u0) * r, Math.sin(u0) * r, 0, Math.cos(u1) * r, Math.sin(u1) * r, 0); } }); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return new THREE.LineSegments(g, lineMat(op)); }
function polarRing(r0, r1, seg, tex, op){
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) { const t = i / seg * TAU, u = 1 - i / seg; pos.push(Math.cos(t) * r0, Math.sin(t) * r0, 0, Math.cos(t) * r1, Math.sin(t) * r1, 0); uv.push(u, 0, u, 1); }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: tex, transparent: true, opacity: op == null ? 1 : op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}));
}
const RW = 4096, RH = 112, TW = 4096, TH = 32;
const uOf = th => { let u = 1 - th / TAU; return ((u % 1) + 1) % 1; };

function buildHud(){
  hud = new THREE.Group(); world.add(hud);
  hud.add(circle(1.9, 0, .55)); hud.add(circle(1.885, 0, .2));
  tickA = ticks(1.915, 240, .016, 10, .034, .55); hud.add(tickA);
  // 写入头：条码环正上方的小三角
  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.962, .01, -.022, 1.94, .01, .022, 1.94, .01], 3));
    hud.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: 0xa6f1ff, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}))); }
  // 条码块环：72 块 × 6 道，每块是 1.4 秒的 token 量；新数据从正上方写入，顺时针流走
  {
    const NST = 6, SEG_A = TAU / NSEG, w = SEG_A * .58, pos = [], col = [], idx = [];
    for (let s = 0; s < NSEG; s++) for (let k = 0; k < NST; k++) {
      const a0 = Math.PI / 2 + s * SEG_A - w / 2, a1 = a0 + w, r0 = 1.965 + k * .033, r1 = r0 + .02, b = pos.length / 3;
      pos.push(Math.cos(a0) * r0, Math.sin(a0) * r0, 0, Math.cos(a1) * r0, Math.sin(a1) * r0, 0, Math.cos(a0) * r1, Math.sin(a0) * r1, 0, Math.cos(a1) * r1, Math.sin(a1) * r1, 0);
      for (let q = 0; q < 4; q++) col.push(.1, .1, .1);
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage)); g.setIndex(idx);
    barcode = new THREE.Mesh(g, new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}));
    hud.add(barcode);
  }
  // 圆柱框：让环有厚度
  hud.add(circle(2.165, .12, .3)); hud.add(circle(2.165, -.12, .3));
  { const a = []; for (let i = 0; i < 90; i++) { const t = i / 90 * TAU; a.push(Math.cos(t) * 2.165, Math.sin(t) * 2.165, .12, Math.cos(t) * 2.165, Math.sin(t) * 2.165, -.12); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); hud.add(new THREE.LineSegments(g, lineMat(.14))); }
  // 雷达扫描弧
  { const n = 60, a = [], c = []; for (let i = 0; i < n; i++) { const t0 = i / n * .75, t1 = (i + 1) / n * .75; a.push(Math.cos(t0) * 1.87, Math.sin(t0) * 1.87, .005, Math.cos(t1) * 1.87, Math.sin(t1) * 1.87, .005); const k = Math.pow(i / n, 2.2); c.push(.65 * k, .95 * k, 1 * k, .65 * k, .95 * k, 1 * k); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    sweep = new THREE.LineSegments(g, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false})); hud.add(sweep); }
  // 文字带：滚动执行记录
  const tc = document.createElement('canvas'); tc.width = TW; tc.height = TH; tapeCtx = tc.getContext('2d');
  tapeTex = new THREE.CanvasTexture(tc); tapeTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tapeRing = polarRing(2.18, 2.28, 360, tapeTex, .85); tapeRing.position.z = .03; hud.add(tapeRing);
  // 扇区 + 通道环（静止）
  const rc = document.createElement('canvas'); rc.width = RW; rc.height = RH; ringCtx = rc.getContext('2d');
  ringTex = new THREE.CanvasTexture(rc); ringTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  ringRing = polarRing(2.31, 2.69, 512, ringTex, 1); ringRing.position.z = -.04; spin.add(ringRing);
  // 虚线轨
  { const dc = document.createElement('canvas'); dc.width = 2048; dc.height = 8; const x = dc.getContext('2d'); x.fillStyle = '#fff';
    for (let px = 0; px < 2048;) { const w = 4 + R() * 40, gap = 3 + R() * 22; if (R() < .82) { x.globalAlpha = .3 + R() * .6; x.fillRect(px, 1, w, 6); } px += w + gap; }
    const dt = new THREE.CanvasTexture(dc); dashRing = polarRing(2.71, 2.73, 360, dt, .55); dashRing.position.z = -.07; hud.add(dashRing); }
  tickB = ticks(2.765, 360, .015, 10, .035, .42); tickB.position.z = -.1; hud.add(tickB);
  hud.add(circle(2.76, -.1, .25));
  arcsA = arcs(2.85, [[.1, .9], [1.3, 1.5], [2.2, 3.4], [3.9, 4.2], [4.6, 5.8]], .45); arcsA.position.z = -.14; hud.add(arcsA);
  arcsB = arcs(2.91, [[.5, .62], [1.0, 2.1], [2.7, 2.8], [3.2, 4.4], [5.1, 5.3], [5.6, 6.1]], .3); arcsB.position.z = -.18; hud.add(arcsB);
  // 通道落点：交付光束打到这里会闪
  CH.forEach((ch, j) => {
    const p = new THREE.Vector3(Math.cos(chanAng[j]) * 2.614, Math.sin(chanAng[j]) * 2.614, -.04);
    chanPos.push(p);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map: SPRITE, color: new THREE.Color(ch.col), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
    s.position.copy(p); s.scale.setScalar(.1); spin.add(s); chanSpr.push(s);
  });
  // 中心核：CHIEF 越忙越亮
  coreSpr = new THREE.Sprite(new THREE.SpriteMaterial({map: SPRITE, color: 0xcfe0ff, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false}));
  coreSpr.scale.setScalar(2.5); world.add(coreSpr);
  // 流星命中点的闪光
  for (let k = 0; k < 16; k++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: SPRITE, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false})); sp.visible = false; hud.add(sp); hits.push({s: sp, t: 9}); }
  // 巡检扫描圈
  for (let k = 0; k < 4; k++) { const m = new THREE.Mesh(new THREE.RingGeometry(.93, 1, 64), new THREE.MeshBasicMaterial({color: 0x45e6f5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide})); m.visible = false; spin.add(m); scans.push({m, t: 9}); }
}

function buildSky(){
  // 速度线：从环外往远处飞，交付时加速
  const n = 300, dir = [], r0 = [], len = [], spd = [], endp = [], pos = [];
  for (let i = 0; i < n; i++) {
    let d; if (R() < .78) { const t = R() * TAU, e = (R() - .5) * .9; d = [Math.cos(t) * Math.cos(e), Math.sin(t) * Math.cos(e), Math.sin(e)]; } else { const u = randUnit(); d = [u.x, u.y, u.z]; }
    const r = R() * 15, l = .2 + R() * .9, s = .25 + R() * .7;
    for (let e = 0; e < 2; e++) { dir.push(...d); r0.push(r); len.push(l); spd.push(s); endp.push(e); pos.push(0, 0, 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('dir', new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute('r0', new THREE.Float32BufferAttribute(r0, 1)); g.setAttribute('len', new THREE.Float32BufferAttribute(len, 1));
  g.setAttribute('spd', new THREE.Float32BufferAttribute(spd, 1)); g.setAttribute('endp', new THREE.Float32BufferAttribute(endp, 1));
  streaks = new THREE.LineSegments(g, new THREE.ShaderMaterial({uniforms: {uTime: {value: 0}, uBoost: {value: 0}}, vertexShader: STREAK_VS, fragmentShader: STREAK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  streaks.frustumCulled = false; scene.add(streaks);
  const dn = 1400, dp = new Float32Array(dn * 3);
  for (let i = 0; i < dn; i++) { const u = randUnit(), r = 7 + R() * 26; dp[i * 3] = u.x * r; dp[i * 3 + 1] = u.y * r; dp[i * 3 + 2] = u.z * r; }
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  dust = new THREE.Points(dg, new THREE.PointsMaterial({size: .06, map: SPRITE, color: 0x7f93b0, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true}));
  scene.add(dust);
}

/* ---------- 建场景（WebGL 不可用时只跑面板） ---------- */
try {
  if (!THREE) throw new Error('three.js 没加载');
  renderer = new THREE.WebGLRenderer({canvas: cv, antialias: true, powerPreference: 'high-performance'});
  renderer.setClearColor(0x03050a, 1);
  pr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(pr);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 16 / 9, .05, 200);
  camera.position.set(0, 0, 10);
  world = new THREE.Group(); scene.add(world);
  spin = new THREE.Group(); world.add(spin);
  buildBrain();
  buildHud();
  buildSky();
  if (THREE.EffectComposer && THREE.UnrealBloomPass && THREE.RenderPass) {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(512, 512), .62, .42, .3);
    composer.addPass(bloomPass);
  } else bloomOn = false;
  glOK = true;
} catch (e) {
  console.error(e);
  $('#glFail').hidden = false;
}

/* ---------- 信号 ---------- */
const tmpV = glOK ? new THREE.Vector3() : null, tmpW = glOK ? new THREE.Vector3() : null;
function sendSignal(a, b, colHex, cb, kind){
  rateCur++;
  lastHand = {a, b, col: colHex, t: 3};
  if (!glOK) { setTimeout(cb, 1100); return; }
  const bun = BMAP[Math.min(a, b) + '-' + Math.max(a, b)];
  const col = hex3(colHex);
  if (!bun) {
    const A = CL[a].clone(), B = CL[b].clone();
    signals.push({kind, path: (u, o) => o.lerpVectors(A, B, u), u: 0, dur: 1.2, col, cb, tr: 9, gap: .022, head: .085, bun: -1, to: b});
    return;
  }
  const s = bun.strands[(Math.random() * bun.strands.length) | 0], fwd = bun.a === a;
  const path = (u, o) => { const t = fwd ? u : 1 - u, v = 1 - t; o.set(v * v * s.p0.x + 2 * v * t * s.c.x + t * t * s.p1.x, v * v * s.p0.y + 2 * v * t * s.c.y + t * t * s.p1.y, v * v * s.p0.z + 2 * v * t * s.c.z + t * t * s.p1.z); };
  signals.push({kind, path, u: 0, dur: clamp(s.len / 1.5, .8, 1.8), col, cb, tr: 10, gap: .024, head: kind === 'bad' ? .1 : .085, bun: bun.g, to: b});
}
function sendRay(ai, ch){
  rateCur++;
  chanN[ch]++;
  if (!glOK) return;
  const A = CL[ai].clone(), M = chanPos[ch].clone(), F = M.clone().multiplyScalar(2.3);
  signals.push({kind: 'ray', path: (u, o) => { if (u < .5) o.lerpVectors(A, M, u / .5); else o.lerpVectors(M, F, (u - .5) / .5); },
    u: 0, dur: 1.9, col: hex3(CH[ch].col), cb: null, tr: 14, gap: .018, head: .1, bun: -1, to: -1, mid: .5, onMid: () => { chanFlash[ch] = 1; }});
  meteorBurst(ai, ch);
}
function scanAt(k){
  if (!glOK) return;
  const s = scans.find(q => q.t > 1.2) || scans[0];
  s.t = 0; s.m.visible = true; s.m.position.copy(CL[k]);
}

/* ---------- 算力粒子：忙碌的智能体之间来回跑的小光点 + 冲出星环的流星 ---------- */
// m=0 团内火花（直线）、m=1 突触束上的算力流（沿束弯曲）、m=2 流星（从神经团冲出星环外）
const PMAX = 1800;
// 背景粒子密度：0 = 第一版的样子（只有任务脉冲）。想更热闹就把数字调大，比如 {chatter: 20, spark: 10, meteor: 1.2, burst: 2}
const AMBIENT = {chatter: 0, spark: 0, meteor: 0, burst: 0};
const parts = Array.from({length: PMAX}, () => ({on: false, m: 0, ax: 0, ay: 0, az: 0, cx: 0, cy: 0, cz: 0, bx: 0, by: 0, bz: 0, u: 0, dur: 1, col: [1, 1, 1], sz: .03, al: 1, tr: 4, gap: .03}));
let pFree = 0, partAlive = 0, partScale = 1, chatAcc = 0, sparkAcc = 0, metAcc = 0;
const busy = i => i === 0 || !!AG[i].cur;
const whiten = (c, k) => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];
function pGet(){ for (let n = 0; n < PMAX; n++) { const i = (pFree + n) % PMAX; if (!parts[i].on) { pFree = (i + 1) % PMAX; parts[i].on = true; parts[i].u = 0; return parts[i]; } } return null; }
function busyList(){ const l = []; for (let i = 0; i < NCL; i++) if (busy(i)) l.push(i); return l; }
function spawnChatter(){
  // 挑一条两端至少有一个在忙的突触束，从忙的那头往外送
  let b = null;
  for (let t = 0; t < 6; t++) { const q = BUN[(Math.random() * BUN.length) | 0]; if (busy(q.a) || busy(q.b)) { b = q; break; } }
  if (!b) b = BUN[(Math.random() * BUN.length) | 0];
  const s = b.strands[(Math.random() * b.strands.length) | 0], fwd = busy(b.a) && (!busy(b.b) || Math.random() < .5);
  const p = pGet(); if (!p) return;
  const A = fwd ? s.p0 : s.p1, B = fwd ? s.p1 : s.p0;
  p.m = 1; p.ax = A.x; p.ay = A.y; p.az = A.z; p.cx = s.c.x; p.cy = s.c.y; p.cz = s.c.z; p.bx = B.x; p.by = B.y; p.bz = B.z;
  p.dur = clamp(s.len / rnd(1.9, 3.4), .35, 1.2); p.col = whiten(AGC[fwd ? b.a : b.b], .22); p.sz = rnd(.05, .075); p.al = rnd(.7, 1); p.tr = 6; p.gap = .04;
}
function spawnSpark(l){
  const c = l.length ? l[(Math.random() * l.length) | 0] : 0, mem = MEM[c];
  const i0 = mem[(Math.random() * mem.length) | 0], i1 = mem[(Math.random() * mem.length) | 0];
  const p = pGet(); if (!p) return;
  p.m = 0; p.ax = NX[i0]; p.ay = NY[i0]; p.az = NZ[i0]; p.bx = NX[i1]; p.by = NY[i1]; p.bz = NZ[i1];
  p.dur = rnd(.25, .6); p.col = whiten(AGC[c], .35); p.sz = rnd(.04, .06); p.al = rnd(.6, 1); p.tr = 3; p.gap = .06;
}
function spawnMeteor(c, ang){
  const p = pGet(); if (!p) return;
  const C = CL[c], th = ang != null ? ang + rnd(-.28, .28) : (c === 0 ? Math.random() * TAU : Math.atan2(C.y, C.x) + rnd(-.6, .6));
  const ox = C.x + rnd(-.18, .18), oy = C.y + rnd(-.18, .18), oz = C.z + rnd(-.15, .15);
  const ez = rnd(-.35, .35), L = rnd(4.6, 7.2), dx = Math.cos(th) * Math.cos(ez), dy = Math.sin(th) * Math.cos(ez), dz = Math.sin(ez), bend = rnd(-.5, .5);
  p.m = 2; p.ax = ox; p.ay = oy; p.az = oz; p.bx = ox + dx * L; p.by = oy + dy * L; p.bz = oz + dz * L;
  p.cx = ox + dx * L * .5 - dy * bend; p.cy = oy + dy * L * .5 + dx * bend; p.cz = oz + dz * L * .5;
  p.dur = rnd(1.3, 2.3); p.col = whiten(AGC[c], .12); p.sz = rnd(.08, .11); p.al = 1; p.tr = 12; p.gap = .018; p.lr = 0; p.hit = false;
}
function hitRing(th, col){
  // 世界角度换成能量格自己的格子编号（能量格本身在转）
  const local = th - barcode.rotation.z - Math.PI / 2, SA = TAU / NSEG;
  const s0 = ((Math.round(local / SA) % NSEG) + NSEG) % NSEG;
  [[0, 1], [-1, .45], [1, .45]].forEach(([d, k]) => { const s = (s0 + d + NSEG) % NSEG; if (k >= segFlash[s]) { segFlash[s] = k; segCol[s] = col; } });
  const h = hits.find(q => q.t >= .55) || hits[0];
  if (!h) return;
  h.t = 0; h.s.visible = true; h.s.material.color.setRGB(col[0], col[1], col[2]);
  h.s.position.set(Math.cos(th) * HIT_R, Math.sin(th) * HIT_R, .02);
}
function meteorBurst(c, ch){ if (!glOK) return; for (let k = 0; k < AMBIENT.burst; k++) spawnMeteor(c, chanAng[ch]); }
function partStep(dt){
  if (!glOK) return;
  const live = liveN(), l = busyList();
  chatAcc += dt * AMBIENT.chatter * (1 + .2 * live) * partScale;
  sparkAcc += dt * AMBIENT.spark * (1 + .2 * live) * partScale;
  metAcc += dt * AMBIENT.meteor * (1 + .2 * live) * partScale;
  for (; chatAcc >= 1; chatAcc--) spawnChatter();
  for (; sparkAcc >= 1; sparkAcc--) spawnSpark(l);
  for (; metAcc >= 1; metAcc--) spawnMeteor(l.length ? l[(Math.random() * l.length) | 0] : 0);
  let n = 0;
  for (const p of parts) {
    if (!p.on) continue;
    p.u += dt / p.dur;
    if (p.m === 2 && !p.hit && p.u <= 1) {
      pEval(p, p.u, tmpV);
      const r = Math.hypot(tmpV.x, tmpV.y);
      if (p.lr < HIT_R && r >= HIT_R) { p.hit = true; hitRing(Math.atan2(tmpV.y, tmpV.x) + spin.rotation.z, p.col); }
      p.lr = r;
    }
    if (p.u >= 1 + p.tr * p.gap) p.on = false; else n++;
  }
  partAlive = n;
}
function pEval(p, u, o){
  if (p.m === 0) { o.set(p.ax + (p.bx - p.ax) * u, p.ay + (p.by - p.ay) * u, p.az + (p.bz - p.az) * u); return; }
  const v = 1 - u;
  o.set(v * v * p.ax + 2 * v * u * p.cx + u * u * p.bx, v * v * p.ay + 2 * v * u * p.cy + u * u * p.by, v * v * p.az + 2 * v * u * p.cz + u * u * p.bz);
}

/* ---------- 镜头 ---------- */
const MODES = [{id: 'orbit', zh: '环绕'}, {id: 'front', zh: '正视'}, {id: 'tilt', zh: '斜看'}, {id: 'close', zh: '贴近'}];
let modeI = 0;
const cam = glOK ? {pos: new THREE.Vector3(0, .4, 14), tgt: new THREE.Vector3(), want: new THREE.Vector3(), wantT: new THREE.Vector3(), yaw: 0, pitch: 0, zoom: 1, userT: 0} : null;
let fitD = 10, W = 1, H = 1, narrow = false, bs = .5, sizeGain = 1;
function camWant(t){
  const D = fitD * cam.zoom;
  let az = 0, el = 0, r = D, tx = 0, ty = 0;
  switch (MODES[modeI].id) {
    case 'orbit': az = .42 * Math.sin(t * .07); el = .2 + .12 * Math.sin(t * .051); break;
    case 'front': az = .03 * Math.sin(t * .13); el = .025 * Math.cos(t * .11); break;
    case 'tilt':  az = .8 + .06 * Math.sin(t * .09); el = .28 + .05 * Math.sin(t * .07); r = D; tx = -.15; ty = .14; break;
    case 'close': az = 1.02 + .12 * Math.sin(t * .05); el = -.16 + .07 * Math.sin(t * .07); r = D * .45; tx = 1.1; ty = .35; break;
  }
  az += cam.yaw; el = clamp(el + cam.pitch, -1.25, 1.25);
  cam.want.set(r * Math.sin(az) * Math.cos(el) + tx, r * Math.sin(el) + ty, r * Math.cos(az) * Math.cos(el));
  cam.wantT.set(tx, ty, 0);
}

/* ================= 4. DOM 面板 ================= */
const nr = $('#nr'), board = $('#board'), fitIn = $('#fitIn');
const clsEl = $('#cls'), feedEl = $('#feed'), tip = $('#tip');
const rows = AG.map((a, i) => {
  const el = document.createElement('div');
  el.className = 'cl idle'; el.style.setProperty('--c', a.col);
  el.innerHTML = `<span class="sw"></span><b class="k">${a.k}</b><span class="z">${a.zh} · ${a.role}</span><span class="pc">—</span><span class="bar"><i></i></span><span class="st">—</span>`;
  clsEl.appendChild(el);
  return {el, pc: el.querySelector('.pc'), bar: el.querySelector('.bar i'), st: el.querySelector('.st')};
});
let rowY = AG.map((_, i) => 31 + i * 48 + 22);                  // 每行中心的 y，布局变了会重新量
function ltMetaText(){
  const extra = MODEL.extraScopes ? ` · 另 ${MODEL.extraScopes} 个星域折叠` : '';
  return `11 星域 + 遗忘站 · ${fmt((MODEL.totals || {}).all || 0)} 颗星${extra}`;
}
$('#ltMeta').textContent = ltMetaText();

function renderList(){
  AG.forEach((a, i) => {
    const r = rows[i];
    let cls = 'cl', pc = '—', w = 0, st = '';
    if (i === 0) {
      cls += ' work'; pc = 'Q' + queueTotal(); w = 1 - clamp(chiefT / chiefDur, 0, 1);
      st = `想起 ${lastDispatch} · 在途 ${inFlight()} · 下一颗 ${Math.max(0, chiefT).toFixed(1)}s`;
    } else if (i === CRAWLER) {
      cls += ' work'; pc = String(crawl.patrols); w = probe.u < 1 ? probe.u : 1 - clamp(probe.dwell / 3, 0, 1);
      st = `${probe.u < 1 ? '飞往' : '扫描'} ${AG[crawl.target].k} · 已读 ${fmt(crawl.read)} 页`;
    } else if (a.cur) {
      cls += ' work'; pc = Math.round(a.prog * 100) + '%'; w = a.prog;
      st = `${a.cur.id} ${a.cur.name}${a.cur.rework ? ' · 返工 ' + a.cur.rework : ''}${a.inbox.length ? ' · 排队 ' + a.inbox.length : ''}`;
    } else if (a.inbox.length) { cls += ' idle'; pc = 'Q' + a.inbox.length; st = `排队 ${a.inbox.length} · 下一个 ${a.inbox[0].id}`; }
    else { cls += ' idle'; st = `待命 · 本次会话召回 ${a.outs}`; }
    if (a.hitT > 0) cls += ' hit';
    if (focus === i) cls += ' foc';
    if (r.el.className !== cls) r.el.className = cls;
    r.pc.textContent = pc; r.bar.style.width = (w * 100).toFixed(1) + '%'; r.st.textContent = st;
  });
  const p = $('#connP');
  if (lastHand && lastHand.t > 0) {
    const y1 = rowY[lastHand.a], y2 = rowY[lastHand.b], bulge = 18 + Math.abs(y2 - y1) * .09;
    p.setAttribute('d', `M2 ${y1} C ${2 + bulge} ${y1}, ${2 + bulge} ${y2}, 2 ${y2}`);
    p.setAttribute('stroke', lastHand.col); p.setAttribute('opacity', String(clamp(lastHand.t, 0, 1)));
  } else p.setAttribute('opacity', '0');
}
function renderFeed(){
  feedDirty = false;
  const n = Math.max(6, Math.floor(feedEl.clientHeight / 15));
  feedEl.innerHTML = feed.slice(0, n).map(e => `<li class="${e.kind}"><time>${e.t}</time><b style="color:${AG[e.a].col}">${AG[e.a].k}</b><em>${e.verb}</em><span>${e.text}</span></li>`).join('');
}
function renderCap(){
  capDirty = false;
  const c = caption, a = AG[c.a];
  $('#cap').className = 'cap ' + c.kind;
  $('#capK').textContent = a.k; $('#capK').style.color = a.col;
  $('#capV').textContent = c.verb; $('#capT').textContent = c.text;
  $('#mCap').innerHTML = `<b style="color:${a.col}">${a.k}</b>${c.verb} · ${c.text}`;
}
const heatCv = $('#heat'), heatX = heatCv.getContext('2d');
const sparkCv = $('#spark'), sparkX = sparkCv.getContext('2d');
// 画板被整体缩放过，按「缩放后的实际像素」出图才清楚
function sizeCv(cv, x){ const w = cv.clientWidth || 1, h = cv.clientHeight || 1, k = clamp((window.devicePixelRatio || 1) * bs, 1, 3); cv.width = Math.round(w * k); cv.height = Math.round(h * k); x.setTransform(k, 0, 0, k, 0, 0); return [w, h]; }
let heatWH = [1, 1], sparkWH = [1, 1];
function heatCol(v){
  // 暗 → 冰蓝 → 琥珀：越烧 token 越热
  if (v < .04) return 'rgba(186,212,240,.05)';
  if (v < 1) { const k = v; return `rgba(${Math.round(30 + 136 * k)},${Math.round(70 + 171 * k)},${Math.round(100 + 155 * k)},${(.25 + .65 * k).toFixed(2)})`; }
  const k = clamp(v - 1, 0, .5) * 2; return `rgb(${Math.round(166 + 89 * k)},${Math.round(241 - 60 * k)},${Math.round(255 - 184 * k)})`;
}
function renderHeat(){
  const [w, h] = heatWH, x = heatX, lw = 62, cols = HEATN + 1, cw = (w - lw - 6) / cols, rh = (h - 22) / 12;
  x.clearRect(0, 0, w, h);
  x.font = `700 9.5px ${MONO}`; x.textBaseline = 'middle';
  for (let r = 0; r < 12; r++) {
    const a = AG[r + 1], y = r * rh;
    x.fillStyle = a.cur ? a.col : '#6b7685'; x.fillText(a.k, 0, y + rh / 2);
    for (let c = 0; c < cols; c++) {
      const v = c < HEATN ? heat[r][c] : (heatCur[r] / (TOKR[r + 1] * Math.max(.3, heatAcc)));
      x.fillStyle = heatCol(v);
      x.fillRect(lw + c * cw + 1, y + 1.5, cw - 2.5, rh - 3);
    }
  }
  x.strokeStyle = 'rgba(166,241,255,.8)'; x.lineWidth = 1;
  x.strokeRect(lw + HEATN * cw + .5, .5, cw - 1.5, 12 * rh - 1);
  x.font = `500 8.5px ${MONO}`; x.fillStyle = '#6b7685'; x.textAlign = 'left';
  x.fillText('-30s', lw, h - 8); x.textAlign = 'right'; x.fillStyle = '#a6f1ff'; x.fillText('NOW', w - 6, h - 8); x.textAlign = 'left';
  x.fillStyle = '#6b7685'; x.fillText('token / 满速', lw + cw * 4, h - 8);
}
function renderSpark(){
  const [w, h] = sparkWH, x = sparkX, n = rateBins.length, mx = Math.max(6, ...rateBins);
  x.clearRect(0, 0, w, h);
  x.strokeStyle = 'rgba(186,212,240,.12)'; x.lineWidth = 1;
  for (let k = 1; k < 3; k++) { x.beginPath(); x.moveTo(0, h * k / 3 + .5); x.lineTo(w, h * k / 3 + .5); x.stroke(); }
  const pt = i => [i / (n - 1) * (w - 4), h - 3 - rateBins[i] / mx * (h - 8)];
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(166,241,255,.28)'); g.addColorStop(1, 'rgba(166,241,255,0)');
  x.beginPath(); x.moveTo(0, h); for (let i = 0; i < n; i++) x.lineTo(...pt(i)); x.lineTo(w - 4, h); x.closePath(); x.fillStyle = g; x.fill();
  x.beginPath(); for (let i = 0; i < n; i++) { const [px, py] = pt(i); i ? x.lineTo(px, py) : x.moveTo(px, py); } x.strokeStyle = '#a6f1ff'; x.lineWidth = 1.2; x.stroke();
  const [ex, ey] = pt(n - 1); x.fillStyle = '#fff'; x.beginPath(); x.arc(ex, ey, 2.4, 0, TAU); x.fill();
}
let fps = 60, fpsN = 0, fpsT = 0, lowT = 0, autoNote = '';
function renderBottom(){
  const T = MODEL.totals || {};
  $('#bTopo').innerHTML = `${fmt(T.all || 0)}<small>颗星</small>`;
  $('#bTopoS').innerHTML = `<b>${MODEL.scopeCount || 0}</b> 星域 · 明亮 <b>${T.active || 0}</b> · 变暗 <b>${T.faded || 0}</b>`;
  $('#bRate').innerHTML = `${rateBins[rateBins.length - 1]}<small>次/秒</small>`;
  $('#bOut').textContent = fmt(total);
  const pct = DAY_TARGET ? total / DAY_TARGET : 0;
  $('#bOutS').innerHTML = `今日新星 · 目标 <b>${fmt(DAY_TARGET)}</b> · <b>${(pct * 100).toFixed(1)}%</b> · 在跑 <b>${liveN()}</b>`;
  $('#bOutBar').style.width = (Math.min(1, pct) * 100).toFixed(2) + '%';
  const keep = (MODEL.avgRetention == null ? 0 : MODEL.avgRetention * 100);
  $('#bPass').textContent = keep.toFixed(1) + '%';
  $('#bPassS').innerHTML = `召回 <b>${passN}</b> · 归档 <b>${failN}</b> · 强化 <b>${reinforced}</b>`;
  const perMin = tokWin.reduce((p, v) => p + v, 0);
  $('#bTok').textContent = fmtTok(tokDay);
  $('#bTokS').innerHTML = `情绪残留 · 心绪 <b>${(MODEL.mood || {}).valence == null ? '—' : (MODEL.mood.valence).toFixed(2)}</b> · 唤起 <b>${(MODEL.mood || {}).arousal == null ? '—' : (MODEL.mood.arousal).toFixed(2)}</b>`;
  $('#bFps').innerHTML = glOK ? `${fps}<small>fps</small>` : '—';
  $('#bFpsS').innerHTML = glOK ? `${MODES[modeI].zh} · DPR <b>${pr.toFixed(2)}</b>${autoNote}` : 'WebGL 不可用';
  $('#bRateS').innerHTML = `想起 · 接手 · 交接 · 强化 · 在飞 <b>${inFlight()}</b>`;
  $('#cwP').textContent = fmt(crawl.patrols); $('#cwR').textContent = fmt(crawl.read); $('#cwB').textContent = crawl.bugs; $('#cwF').textContent = failN;
  const ta = AG[crawl.target];
  $('#cwNow').innerHTML = `<b>${probe.u < 1 ? '飞往' : '正在看'}</b>${ta.k} ${ta.zh}${ta.cur ? ' · ' + ta.cur.id + ' ' + ta.cur.name : ' · 待命'}`;
  $('#feedMeta').textContent = `${inFlight()} in flight · ${tasks.length} open`;
  $('#mOut').textContent = fmt(total); $('#mLive').textContent = `${liveN()} / 12`; $('#mTok').textContent = fmtTok(tokDay);
}
function clockTick(){ $('#clock').textContent = hms(new Date()); }

/* ---------- HUD 画布：扇区 + 通道环、文字带 ---------- */
function drawAt(c, x, y, flip, fn){ for (const xx of [x, x - RW, x + RW]) { if (xx < -420 || xx > RW + 420) continue; c.save(); c.translate(xx, y); if (flip) c.rotate(Math.PI); fn(c); c.restore(); } }
const spinA = () => spin ? spin.rotation.z : 0;
function drawRing(){
  if (!glOK) return;
  const c = ringCtx; c.clearRect(0, 0, RW, RH);
  // 外圈刻度
  c.fillStyle = 'rgba(200,225,255,.22)';
  for (let x = 0; x < RW; x += 16) c.fillRect(x, 2, 1.5, x % 128 === 0 ? 9 : 4);
  c.fillRect(0, 44, RW, 1);
  // 通道
  CH.forEach((ch, j) => {
    const th = chanAng[j], f = chanFlash[j];
    drawAt(c, uOf(th) * RW, 25, Math.sin(th + spinA()) < 0, q => {
      q.strokeStyle = rgba(ch.col, .5 + .5 * f); q.lineWidth = 2;
      q.beginPath(); q.moveTo(-150, -9); q.lineTo(-150, -13); q.lineTo(150, -13); q.lineTo(150, -9); q.moveTo(-150, 9); q.lineTo(-150, 13); q.lineTo(150, 13); q.lineTo(150, 9); q.stroke();
      if (f > .02) { q.fillStyle = rgba(ch.col, .32 * f); q.fillRect(-150, -13, 300, 26); }
      q.font = `700 17px ${MONO}`; q.textAlign = 'center'; q.textBaseline = 'middle';
      q.fillStyle = f > .3 ? '#ffffff' : 'rgba(225,236,250,.82)';
      q.fillText(`${ch.en} ${ch.zh} · ${fmt(chanN[j])}`, 0, 1);
    });
  });
  // 智能体扇区
  const sw = RW / NCL;
  for (let k = 0; k < NCL; k++) {
    const a = AG[k], th = secAng(k), on = k === 0 || !!a.cur, flip = Math.sin(th + spinA()) < -1e-4;
    const prog = k === 0 ? 1 - clamp(chiefT / chiefDur, 0, 1) : a.cur ? a.prog : 0, hit = clamp(a.hitT, 0, 1);
    drawAt(c, uOf(th) * RW, 78, flip, q => {
      const w = sw * .93, y0 = 26;
      if (hit > 0) { q.fillStyle = rgba(a.col, .12 * hit); q.fillRect(-w / 2, -30, w, 60); }
      q.fillStyle = 'rgba(200,225,255,.14)'; q.fillRect(-w / 2, y0, w, 4);
      q.fillStyle = a.bad > .05 ? rgba('#ff4d5e', .6 + .4 * a.bad) : rgba(a.col, on ? .95 : .4);
      q.fillRect(-w / 2, y0, w * (on ? prog : 0), 4);
      q.fillStyle = rgba(a.col, .9); q.fillRect(-w / 2, -24, 3, 46);
      q.textBaseline = 'middle'; q.textAlign = 'left';
      q.font = `800 24px ${MONO}`; q.fillStyle = on ? '#ffffff' : 'rgba(225,236,250,.5)';
      q.fillText(a.k, -w / 2 + 14, -10);
      const kw = q.measureText(a.k).width;
      q.font = `500 19px ${CJK}`; q.fillStyle = on ? 'rgba(225,236,250,.8)' : 'rgba(225,236,250,.4)';
      q.fillText(a.zh, -w / 2 + 24 + kw, -9);
      q.font = `500 15px ${MONO}`; q.fillStyle = 'rgba(200,220,240,.62)';
      const st = k === 0 ? `DISPATCH ${lastDispatch}` : a.cur ? `${a.cur.id} · ${Math.round(a.prog * 100)}%` : a.inbox.length ? `QUEUE ${a.inbox.length}` : 'IDLE';
      q.fillText(st, -w / 2 + 14, 13);
      q.textAlign = 'right';
      for (let p = 0; p < Math.min(6, a.inbox.length); p++) { q.fillStyle = rgba(a.col, .85); q.fillRect(w / 2 - 12 - p * 11, 8, 7, 7); }
    });
  }
  ringTex.needsUpdate = true;
}
function drawTape(){
  if (!glOK) return;
  tapeDirty = false;
  const c = tapeCtx; c.clearRect(0, 0, TW, TH);
  c.font = `500 18px ${MONO}`; c.textBaseline = 'middle';
  const items = tape.length ? tape : ['CHIEF 派单 T-040 口播短视频 → SCOUT'];
  let x = 6, k = 0;
  while (x < TW) {
    const s = items[k % items.length]; k++;
    c.fillStyle = 'rgba(166,241,255,.85)'; c.fillRect(x, 9, 2, 14);
    c.fillStyle = 'rgba(225,236,250,.78)'; c.fillText(s, x + 10, 16.5);
    x += c.measureText(s).width + 40;
    c.fillStyle = 'rgba(200,225,255,.3)'; for (let t = 0; t < 4; t++) c.fillRect(x - 26 + t * 5, 14, 2, 5);
    if (k > 200) break;
  }
  tapeTex.needsUpdate = true;
}

/* ================= 5. 主循环 ================= */
let focus = -1, hover = -1, needsT = 1, uiAcc = 0, tapeAcc = 0, lastNow = performance.now();
const SIGBUF = 4000;
const TRMAX = 6000;
function writeSignals(){
  const P = sigGeo.attributes.position.array, C = sigGeo.attributes.col.array, S = sigGeo.attributes.sz.array, A = sigGeo.attributes.al.array;
  const LP = trGeo.attributes.position.array, LC = trGeo.attributes.color.array;
  let n = 0, m = 0;
  const put = (p, col, sz, al) => { if (n >= SIGBUF) return; P[n * 3] = p.x; P[n * 3 + 1] = p.y; P[n * 3 + 2] = p.z; C[n * 3] = col[0]; C[n * 3 + 1] = col[1]; C[n * 3 + 2] = col[2]; S[n] = sz; A[n] = al; n++; };
  // 拖尾光线：两端亮度不同，叠加混合下就是一条渐隐的彗尾
  const line = (p, q, col, a0, a1) => { if (m >= TRMAX) return; const o = m * 6; LP[o] = p.x; LP[o + 1] = p.y; LP[o + 2] = p.z; LP[o + 3] = q.x; LP[o + 4] = q.y; LP[o + 5] = q.z;
    LC[o] = col[0] * a0; LC[o + 1] = col[1] * a0; LC[o + 2] = col[2] * a0; LC[o + 3] = col[0] * a1; LC[o + 4] = col[1] * a1; LC[o + 5] = col[2] * a1; m++; };
  const cy = hex3(CYAN), pt = probe.trail, pl = pt.length;
  pt.forEach((q, k) => { const f = 1 - k / pl; put(q, cy, k === 0 ? .14 : .06 * f, k === 0 ? 1.6 : .6 * f); if (k) line(pt[k - 1], q, cy, 1.2 * (f + 1 / pl), 1.2 * f); });
  // 任务脉冲：最大最亮，一眼能和背景粒子分开
  for (const s of signals) {
    const col = s.col;
    for (let k = 0; k < s.tr; k++) {
      const u = s.u - k * s.gap; if (u < 0) break;
      s.path(Math.min(1, u), tmpV);
      const f = 1 - k / s.tr;
      put(tmpV, col, k === 0 ? s.head : s.head * .45 * f, k === 0 ? 1.9 : .9 * f);
      if (k) line(tmpW, tmpV, col, 1.3 * (f + 1 / s.tr), 1.3 * f);
      tmpW.copy(tmpV);
    }
  }
  // 算力粒子
  for (const q of parts) {
    if (!q.on) continue;
    for (let k = 0; k < q.tr; k++) {
      const u = q.u - k * q.gap; if (u < 0) break;
      const uu = Math.min(1, u); pEval(q, uu, tmpV);
      const f = 1 - k / q.tr, fade = q.m === 2 ? Math.min(1, uu * 5) * (uu > .72 ? (1 - uu) / .28 : 1) : 1;
      if (k === 0) put(tmpV, q.col, q.sz, 1.6 * q.al * fade);
      else if (q.m === 0) put(tmpV, q.col, q.sz * .55 * f, .8 * f * q.al);
      else line(tmpW, tmpV, q.col, (f + 1 / q.tr) * q.al * fade, f * q.al * fade);
      tmpW.copy(tmpV);
    }
  }
  for (let i = n; i < sigLast; i++) S[i] = 0;
  sigLast = n;
  for (const k of ['position', 'col', 'sz', 'al']) sigGeo.attributes[k].needsUpdate = true;
  trGeo.setDrawRange(0, m * 2);
  trGeo.attributes.position.needsUpdate = true; trGeo.attributes.color.needsUpdate = true;
}
let sigLast = 0;

function updateScene(dt){
  // 神经团活跃度：干活时按节律放电，刚收到信号时闪一下
  for (let i = 0; i < NCL; i++) {
    const a = AG[i];
    let t = i === 0 ? .45 + .1 * Math.sin(animT * 2.2) : a.cur ? .48 + .26 * Math.sin(animT * 7 + i * 1.7) : a.inbox.length ? .14 : .05;
    t += a.flash * 1.4 + a.bad * .7;
    AF[i * 2] += (t - AF[i * 2]) * (1 - Math.exp(-dt * 6));
  }
  AF[26] = .16 + boost * .12;
  for (const b of BUN) { const g = b.g, cur = AF[g * 2] * Math.exp(-dt * 1.6); AF[g * 2] = Math.max(cur, bunHot[g] * .85); bunHot[g] = 0; }
  // 聚焦：其他神经团和突触束压暗
  for (let g = 0; g < 48; g++) {
    let tgt = 1;
    if (focus >= 0) {
      if (g < NCL) tgt = g === focus ? 1 : .2;
      else if (g === 13) tgt = .35;
      else { const b = BUN[g - 14]; tgt = b && (b.a === focus || b.b === focus) ? 1.4 : .1; }
    }
    AF[g * 2 + 1] += (tgt - AF[g * 2 + 1]) * (1 - Math.exp(-dt * 4));
  }
  const u = brainLines.material.uniforms;
  u.uMono.value = mono; u.uTime.value = animT; u.uFade.value = camera.position.length() - 1.7;
  u.uGain.value += ((bloomOn && composer ? .62 : 1) * sizeGain - u.uGain.value) * (1 - Math.exp(-dt * 4));   // 开辉光时线条收一点，避免中心糊成一团
  // 探针拖尾
  probe.trail.unshift(probe.p.clone()); if (probe.trail.length > 16) probe.trail.pop();
  writeSignals();
  // HUD 转动
  spin.rotation.z = animT * .035;                     // 约 3 分钟转一圈
  tickA.rotation.z = animT * .02; tickB.rotation.z = -animT * .008;
  tapeRing.rotation.z = -animT * .028; dashRing.rotation.z = animT * .05;
  arcsA.rotation.z = animT * .09; arcsB.rotation.z = -animT * .06;
  sweep.rotation.z = -animT * .85;
  barcode.rotation.z = -(slotHead + slotAcc / SEG_SLOT) * (TAU / NSEG);
  const bc = barcode.geometry.attributes.color.array, cur = slotHead % NSEG;
  const SA = TAU / NSEG, rot = barcode.rotation.z;
  for (let s = 0; s < NSEG; s++) {
    slotDisp[s] += (slotVals[s] - slotDisp[s]) * (1 - Math.exp(-dt * 5));
    const v = slotDisp[s], live = s === cur;
    // 这一格此刻转到了哪个智能体的扇区下面
    const th = Math.PI / 2 + s * SA + rot;
    const ag = ((Math.round((Math.PI / 2 + spin.rotation.z - th) / SEC_A) % NCL) + NCL) % NCL, A = AG[ag], ac = AGC[ag];
    const load = ag === 0 ? .5 : A.cur ? .55 + .45 * A.prog : A.inbox.length ? .22 : .06;
    // 均衡器式跳动：扇区里的智能体越忙，跳得越高越快
    const jit = load * (.55 + .45 * Math.sin(animT * (1.1 + ((s * 7) % 6) * .22) + s * 2.3)) * 1.8;
    // 两道充能波沿环反向扫过
    const w = Math.exp(-(wrapPI(th - animT * .42) ** 2) / .045) + Math.exp(-(wrapPI(th + animT * .27 + 2.1) ** 2) / .03);
    const lit = Math.min(6, v * 4.8 + jit + w * 2.2);
    const tint = (A.cur || ag === 0) ? .35 * load : 0;
    for (let k = 0; k < 6; k++) {
      // 外圈那道常亮当底座，往圆心方向充能（k=0 是最里面那道）
      const dim = slotDims[s] ? slotDims[s][k] : 0;
      const on = Math.max(clamp(lit - (5 - k), 0, 1) * .3, dim);
      let r, g, b;
      if (v > .86 && k === 0) { r = 1; g = .66; b = .26; }
      else { r = .78 + (ac[0] - .78) * tint; g = .9 + (ac[1] - .9) * tint; b = 1 + (ac[2] - 1) * tint; }
      let br = .07 + on * (live ? .75 + .25 * Math.sin(animT * 6) : .85) * (1 + w * .6);
      const fl = segFlash[s];
      if (fl > .01) { const fc = segCol[s], mk = fl * .7; r += (fc[0] - r) * mk; g += (fc[1] - g) * mk; b += (fc[2] - b) * mk; br = Math.max(br, fl * 1.5); }
      for (let q = 0; q < 4; q++) { const o = ((s * 6 + k) * 4 + q) * 3; bc[o] = r * br; bc[o + 1] = g * br; bc[o + 2] = b * br; }
    }
  }
  barcode.geometry.attributes.color.needsUpdate = true;
  for (let s = 0; s < NSEG; s++) segFlash[s] *= Math.exp(-dt * 3.2);
  hits.forEach(h => { if (!h.s.visible) return; h.t += dt; const k = h.t / .55; if (k >= 1) { h.s.visible = false; return; } h.s.scale.setScalar(.1 + .32 * k); h.s.material.opacity = 1 - k; });
  coreSpr.material.opacity = .1 + AF[0] * .14 + boost * .05;
  chanSpr.forEach((s, j) => { const f = chanFlash[j]; s.material.opacity = f; s.scale.setScalar(.12 + .55 * f); });
  scans.forEach(s => { if (!s.m.visible) return; s.t += dt; const k = s.t / 1.2; if (k >= 1) { s.m.visible = false; return; } s.m.scale.setScalar(.07 + .38 * k); s.m.material.opacity = (1 - k) * .9; s.m.lookAt(camera.position); });
  streaks.material.uniforms.uTime.value = animT; streaks.material.uniforms.uBoost.value = boost;
  dust.rotation.y = animT * .004; dust.rotation.x = animT * .002;
}
function decay(dt){
  AG.forEach(a => { a.flash *= Math.exp(-dt * 2.4); a.bad *= Math.exp(-dt * 1.6); a.hitT = Math.max(0, a.hitT - dt); });
  for (let j = 0; j < chanFlash.length; j++) chanFlash[j] *= Math.exp(-dt * 1.8);
  boost *= Math.exp(-dt * .9);
  if (lastHand) lastHand.t -= dt;
}
function frame(now){
  requestAnimationFrame(frame);
  if (host.hidden || document.hidden) { lastNow = now; return; }
  const real = (now - lastNow) / 1000, dt = Math.min(.1, real); lastNow = now;
  if (!paused) { simStep(dt); decay(dt); animT += dt; }
  uiAcc += dt; tapeAcc += dt;
  if (uiAcc >= .25) {
    uiAcc = 0;
    renderList(); renderBottom(); renderHeat(); renderSpark(); drawRing();
    if (feedDirty) renderFeed();
    if (capDirty) renderCap();
    if (tapeDirty && tapeAcc > 1) { tapeAcc = 0; drawTape(); }
  }
  if (!glOK) return;
  if (cam.userT > 0) cam.userT -= dt; else { cam.yaw *= Math.exp(-dt * .7); cam.pitch *= Math.exp(-dt * .7); }
  camWant(animT);
  const k = 1 - Math.exp(-dt * 1.5);
  cam.pos.lerp(cam.want, k); cam.tgt.lerp(cam.wantT, k);
  const moving = cam.pos.distanceToSquared(cam.want) > 1e-5 || cam.userT > 0;
  if (paused && !moving && needsT <= 0) return;
  needsT -= dt;
  camera.position.copy(cam.pos); camera.lookAt(cam.tgt);
  updateScene(dt);
  if (bloomOn && composer) composer.render(); else renderer.render(scene, camera);
  // 帧率 + 自动降档
  fpsN++; fpsT += Math.min(real, 2);
  if (fpsT >= 1) {
    fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0;
    if (!paused && fps < 30) lowT++; else lowT = 0;
    if (lowT >= 3) { lowT = 0; if (pr > 1) { pr = 1; autoNote = ' · 已自动降清晰度'; layout(); } else if (pr > .75) { pr = .75; autoNote = ' · 已自动降清晰度'; layout(); } else if (partScale > .5) { partScale = .5; autoNote = ' · 已自动减少粒子'; } }
  }
  if (hover >= 0 && !tip.hidden) showTip(hover);
}

/* ---------- 尺寸 ---------- */
function layout(){
  if (host.hidden || host.clientWidth < 2) return;   // 主题被隐藏时不重排
  const r = host.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  narrow = W < 760 || W / H < 1.05;
  nr.classList.toggle('narrow', narrow);
  const fr = fitIn.getBoundingClientRect();
  bs = Math.min(fr.width / 1920, fr.height / 1080);
  // 画板不锁 16:9：宽度或高度多出来的部分直接让画板变大，四周的面板贴着屏幕边
  const BW = fr.width / bs, BH = fr.height / bs;
  board.style.width = BW + 'px'; board.style.height = BH + 'px';
  board.style.setProperty('--s', bs);
  rowY = rows.map(r => r.el.offsetTop + r.el.offsetHeight / 2);
  heatWH = sizeCv(heatCv, heatX); sparkWH = sizeCv(sparkCv, sparkX);
  if (feed.length) renderFeed();
  if (!glOK) return;
  renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
  if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); }
  camera.aspect = W / H;
  const t = Math.tan(camera.fov * Math.PI / 360), Rr = 2.95;
  if (narrow) { fitD = Math.max(Rr * H / (.94 * W * t), Rr / (.6 * t)); camera.setViewOffset(W, H, 0, H * .02, W, H); }
  else { const ringPx = Math.min(BH * .9, BW - 900) * bs; fitD = Rr * H / (ringPx * t); camera.setViewOffset(W, H, 0, 30 * bs, W, H); }
  camera.updateProjectionMatrix();
  brainLines.material.uniforms.uPx.value = H * pr / (2 * t);
  // 星环在屏幕上越小，线条叠得越密，按尺寸减淡，免得小屏糊成一团白
  sizeGain = clamp(Rr * H / (fitD * t) / 900, .32, 1);
  needsT = .6;
}

/* ---------- 交互 ---------- */
const v3 = glOK ? new THREE.Vector3() : null;
function screenOf(p){ v3.copy(p).applyMatrix4(spin.matrixWorld).project(camera); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H]; }
function pickAt(x, y){
  if (!glOK) return -1;
  let best = -1, bd = 44 * 44;
  const test = (i, p) => { const [sx, sy] = screenOf(p); const d = (sx - x) ** 2 + (sy - y) ** 2; if (d < bd) { bd = d; best = i; } };
  for (let i = 0; i < NCL; i++) test(i, CL[i]);
  test(CRAWLER, probe.p);
  return best;
}
function showTip(i){
  const a = AG[i];
  let now;
  if (i === 0) now = `刚派 ${lastDispatch} · 全局排队 ${queueTotal()} · 在途 ${inFlight()}`;
  else if (i === CRAWLER) now = `${probe.u < 1 ? '飞往' : '扫描'} ${AG[crawl.target].k} · 抓到 bug ${crawl.bugs}`;
  else now = a.cur ? `${a.cur.id} ${a.cur.name} · ${Math.round(a.prog * 100)}%` : a.inbox.length ? `排队 ${a.inbox.length}` : '待命';
  const links = i > 0 && i < NCL ? BUN.filter(b => b.a === i || b.b === i).map(b => AG[b.a === i ? b.b : b.a].k).join(' · ') : '';
  tip.style.setProperty('--c', a.col);
  tip.innerHTML = `<span><b>${a.k}</b><strong>${a.zh}</strong> · ${a.tag}</span><span>${a.role}</span><span>当前：${now}</span>` +
    (i < 13 ? `<span>今日完成 ${a.outs} · token ${fmtTok(a.tok)}</span>` : '') + (links ? `<span class="h">连着：${links}</span>` : '') +
    `<span class="h">${focus === i ? '再点一次取消聚焦' : '点击聚焦这团神经元'}</span>`;
  tip.hidden = false;
  const [sx, sy] = screenOf(i === CRAWLER ? probe.p : CL[i]);
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = sx + 18, y = sy - th / 2;
  if (x + tw > W - 12) x = sx - tw - 18;
  tip.style.left = clamp(x, 8, W - tw - 8) + 'px'; tip.style.top = clamp(y, 8, H - th - 8) + 'px';
}
let drag = null;
cv.addEventListener('pointerdown', e => { drag = {x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false}; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  const r = host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) { drag.moved = true; cv.classList.add('drag'); }
    if (drag.moved && glOK) { cam.yaw -= dx * .005; cam.pitch += dy * .004; cam.userT = 6; needsT = .5; tip.hidden = true; hover = -1; }
    return;
  }
  const i = pickAt(x, y);
  hover = i; cv.classList.toggle('hov', i >= 0);
  if (i >= 0) showTip(i); else tip.hidden = true;
});
cv.addEventListener('pointerup', e => {
  const wasDrag = drag && drag.moved; drag = null; cv.classList.remove('drag');
  if (wasDrag) return;
  const r = host.getBoundingClientRect(), i = pickAt(e.clientX - r.left, e.clientY - r.top);
  focus = (i >= 0 && i < NCL && focus !== i) ? i : -1;
  needsT = 1.5;
  if (i >= 0) showTip(i);
});
cv.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; hover = -1; } });
cv.addEventListener('wheel', e => { if (!glOK) return; e.preventDefault(); cam.zoom = clamp(cam.zoom * Math.exp(e.deltaY * .0012), .55, 1.6); needsT = .8; }, {passive: false});

function syncButtons(){
  $$('[data-f="mode"]').forEach(b => b.textContent = MODES[modeI].zh);
}
function act(name){
  if (name === 'mode') { modeI = (modeI + 1) % MODES.length; cam && (cam.yaw = cam.pitch = 0); needsT = 3; }
  else if (name === 'full') {
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => { const b = $('[data-f="full"]'); b.textContent = '不支持'; setTimeout(() => b.textContent = '全屏', 1500); });
    } catch (e) { /* 部分窗口不允许全屏 */ }
  }
  syncButtons();
}
$$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
document.addEventListener('fullscreenchange', () => { const b = $('[data-f="full"]'); if (b) b.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; });
document.addEventListener('keydown', e => {
  if (host.hidden) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'v' || e.key === 'V') act('mode');
  else if (e.key === 'Escape' && focus >= 0) { focus = -1; needsT = 1.5; }
});

/* ================= 6. 接真实数据：星域 / 星星 / 计数 / 星环 ================= */
function refreshRows(){
  AG.forEach((a, i) => {
    const r = rows[i]; if (!r) return;
    r.el.style.setProperty('--c', a.col);
    const kEl = r.el.querySelector('.k'), zEl = r.el.querySelector('.z');
    if (kEl) kEl.textContent = a.k;
    if (zEl) zEl.textContent = `${a.zh} · ${a.role}`;
  });
}
function setModel(m){
  if (!m) return;
  Object.assign(MODEL, m);
  const sc = MODEL.scopes || [];
  for (let i = 0; i < SCOPE_SLOTS; i++) {
    const s = sc[i], a = AG[1 + i];
    if (s) {
      a.k = s.short; a.zh = s.scope;
      a.role = `${s.total} 颗星 · 明亮 ${s.active} · 变暗 ${s.faded}`;
      a.col = SCOPE_COLORS[i % 12];
      a.outs = s.recalls || 0;
      a.tok = (s.recalls || 0) * 120;
      TOKR[1 + i] = 12 + Math.min(160, (s.recalls || 0) * 6);
      INR[1 + i] = clamp(.5 + (s.valence == null ? 0 : s.valence) * .4, .3, .95);
    } else {
      a.k = 'IDLE'; a.zh = '空位'; a.role = '暂无记忆'; a.col = '#39424f';
      a.outs = 0; TOKR[1 + i] = 12; INR[1 + i] = .6;
    }
  }
  AG[0].role = `写入 · 巩固 · 召回 · 共 ${(MODEL.totals || {}).all || 0} 颗星`;
  AGC = AG.map(a => hex3(a.col));
  sumTOKR = TOKR.reduce((p, v) => p + v, 0);

  // 记忆类型变了，工作流跟着换
  const newTypes = (MODEL.types && MODEL.types.length ? MODEL.types : types).slice(0, 11);
  const rebuilt = buildWF(newTypes);
  WF.length = 0;
  rebuilt.forEach(w => WF.push(w));
  // 开场那几个占位任务也换成真实类型名
  tasks.forEach(t => { if (!t.star && WF[t.wf] && WF[t.wf].names[0]) t.name = WF[t.wf].names[0]; });

  // 星星池
  starPool.length = 0;
  (MODEL.stars || []).forEach(s => starPool.push({
    id: s.id, content: s.content, scope: s.scope, type: s.type, status: s.status,
    retention: Number(s.retention) || 0, clarity: Number(s.clarity) || 0,
    importance: Number(s.importance) || 0, valence: Number(s.valence) || 0,
    arousal: Number(s.arousal) || 0, pinned: !!s.pinned,
    scopeIndex: s.scopeIndex == null ? 0 : s.scopeIndex, wf: s.wf || 0
  }));

  // 计数
  total = MODEL.todayNew || 0;
  tokDay = MODEL.emotionEnergy || 0;
  if (MODEL.recallCount != null) passN = MODEL.recallCount;
  if (MODEL.archiveCount != null) failN = MODEL.archiveCount;
  if (MODEL.maintainCount != null) crawl.patrols = MODEL.maintainCount;
  if (MODEL.maintainScanned != null) crawl.read = MODEL.maintainScanned;

  // 72 段星环：每段 = 一颗星，6 格 = 保持/清晰/重要/情绪/置顶/复访
  const st = (MODEL.stars || []).slice(0, NSEG);
  for (let i = 0; i < NSEG; i++) {
    const s = st[i], d = slotDims[i];
    slotVals[i] = s ? clamp(Number(s.retention) || 0, .02, 1) : .02;
    d[0] = s ? clamp(Number(s.retention) || 0, 0, 1) : 0;
    d[1] = s ? clamp(Number(s.clarity) || 0, 0, 1) : 0;
    d[2] = s ? clamp(Number(s.importance) || 0, 0, 1) : 0;
    d[3] = s ? clamp((Math.abs(Number(s.valence) || 0) + Math.abs(Number(s.arousal) || 0)) / 2, 0, 1) : 0;
    d[4] = s ? (s.pinned ? 1 : .18) : 0;
    d[5] = s ? clamp(Number(s.review) || 0, 0, 1) : 0;
  }

  // 热力：每个星域最近 30 秒的召回强度，用真实召回频次打底
  const rel = (MODEL.scopes || []).map(s => (s.recalls || 0));
  const maxRel = Math.max(1, ...rel);
  heat.forEach((row, r) => {
    const v = clamp((rel[r] || 0) / maxRel, 0, 1);
    for (let c = 0; c < HEATN; c++) row[c] = clamp(row[c] * .55 + v * .45, .02, 1.1);
  });

  // 真实事件进日志
  (MODEL.events || []).slice(0, 6).forEach(ev => {
    const ai = ev.scopeIndex == null ? 0 : 1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, ev.scopeIndex));
    log(ai, ev.verb || '事件', ev.text || '', ev.kind || '');
  });

  refreshRows();
  $('#ltMeta').textContent = ltMetaText();
  renderList(); renderBottom(); renderHeat(); renderSpark(); drawRing();
  if (feedDirty) renderFeed();
  if (capDirty) renderCap();
  tapeDirty = true;
}

/* ---------- 开场 ---------- */
// 开场就让几个星域处在「想起一颗星」的中途，画面一打开就是在跑的状态
[1, 3, 5, 7, 9, 11, 4].forEach((ai, k) => {
  if (!WF.length) return;
  const wi = k % WF.length, w = WF[wi], t = newTask(wi);
  const st = Math.max(0, w.path.indexOf(ai)); t.stage = st;
  const a = AG[ai]; a.cur = t; a.prog = rnd(.1, .8); a.dur = rnd(5, 9) * a.sp;
});
AG[2].inbox.push(newTask(0)); AG[8].inbox.push(newTask(Math.min(1, WF.length - 1)));
if (starPool.length) {
  const s0 = starPool[0], s1 = starPool[1 % starPool.length], s2 = starPool[2 % starPool.length];
  log(0, '想起', `#${s0.id} ${starLabel(s0)} → ${AG[1 + Math.min(SCOPE_SLOTS - 1, s0.scopeIndex)].k}`);
  log(3, '接手', `#${s1.id} ${starLabel(s1)}`);
  log(7, '归档', `#${s2.id} ${CHECKS[0]} → 熄灯`, 'bad');
  log(10, '强化', `#${s0.id} ${starLabel(s0)} → 明亮`, 'ship');
} else {
  log(0, '想起', '还没有星星 —— 先在群里聊两句，记忆会自己长出来');
}
AG.forEach(a => a.hitT = 0);
new ResizeObserver(() => layout()).observe(host);
layout();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawRing(); drawTape(); layout(); });
drawRing(); drawTape(); renderList(); renderFeed(); renderCap(); renderBottom(); renderHeat(); renderSpark();
clockTick(); setInterval(clockTick, 1000);
syncButtons();
// 调试用：快进模拟若干秒（控制台里 document.getElementById('host-neural').__nr.ff(20)）
host.__nr = {ff(sec){ for (let t = 0; t < sec; t += .05) { simStep(.05); decay(.05); animT += .05; } needsT = 1; },
              setModel, model: MODEL, feed, tasks, stars: starPool, ag: AG};
requestAnimationFrame(frame);
}