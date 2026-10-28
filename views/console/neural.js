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
/* ===== 3D 场景层：0 = 恒星(bot 本体)，1..M = 一条条记忆，M+1 = 黑洞 ===== */
const MAXMEM = 22;                                   // 屏幕上同时存在的记忆星（记忆慢慢攒，不用多）
const HOLE = {x: -1.36, y: -.78, z: .18, r: .165};      // 黑洞停在恒星左前方不远处
const AFG = 80;                                      // 着色器里 af[] 的组数上限
const SC = {n: 1, mem: [], col: [], pull: new Float32Array(AFG), bunBase: 2, held: -1, absorbed: 0, gone: []};
let GBG = 1;                                         // 背景灰质所在的组号

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
/* 星域（AG）和场景里的记忆星（组号）之间的桥 */
const scopeBusy = si => { const a = AG[1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, si || 0))]; return !!(a && a.cur); };
const grpOfScope = si => {
  const a = AG[1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, si || 0))];
  const l = a && a.grps ? a.grps : [];
  return l.length ? l[(Math.random() * l.length) | 0] : 0;
};
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
let boost = 0, lastHand = null, bunHot = new Float32Array(AFG);
let sceneT = 0;                                  // 星海时钟：截停时停住

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
  sendSignal(0, grpOfScope(b.i), b.col, () => b.inbox.push(t), 'dispatch');
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
    sendSignal(0, grpOfScope(b.i), BAD, () => b.inbox.push(t), 'bad');
    return;
  }
  if (a.i === PROOF) passN++;
  if (t.stage < path.length - 1) {
    t.stage++;
    const b = AG[path[t.stage]];
    log(a.i, '交接', `${t.id} ${t.name} → ${b.k}`);
    sendSignal(0, grpOfScope(b.i), a.col, () => b.inbox.push(t), 'hand');
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
  sendRay(grpOfScope(a.i), faded ? 2 : w.ch);
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
  const kg = grpOfScope(k);
  probe.a.copy(probe.p);
  const C = CL[kg] || CL[0], out = new THREE.Vector3(C.x, C.y, 0).normalize();
  probe.b.set(C.x + out.x * .1, C.y + out.y * .1, C.z + .12);
  const mid = probe.a.clone().add(probe.b).multiplyScalar(.5), m = Math.hypot(mid.x, mid.y) || .01;
  probe.c.set(mid.x / m * 1.72, mid.y / m * 1.72, mid.z + rnd(-.3, .5));
  probe.u = 0; probe.dur = clamp(probe.a.distanceTo(probe.b) / 1.5, .9, 2.4);
}
function probeArrive(){
  probe.dwell = rnd(1.6, 3.0);
  crawl.patrols++; crawl.read += 1 + ((Math.random() * 6) | 0);
  scanAt(grpOfScope(crawl.target));
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
    if (s.u >= 1 && !s.done) { s.done = true; if (s.to >= 0) { if (s.to < SC.n) AF[s.to * 2] = Math.min(1.5, AF[s.to * 2] + .9); else if (AG[s.to]) AG[s.to].flash = 1; } if (s.cb) s.cb(); }
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
const AF = new Float32Array(AFG * 2);                   // 每组 (活跃度, 聚焦系数)：0 恒星，1..M 记忆星，M+1 背景，之后是突触束
const focT = new Float32Array(AFG).fill(1);
for (let i = 0; i < AFG; i++) { AF[i * 2] = .1; AF[i * 2 + 1] = 1; }
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
attribute vec3 gc; attribute float pull; attribute float osp;
uniform vec2 af[80]; uniform float uMono; uniform float uFade; uniform float uGain; uniform vec3 uHole;
uniform float uOrbit;
varying vec3 vCol; varying float vA;
void main(){
  // 记忆越暗 = 被黑洞吸得越近：先向自己的中心收拢，再被拖向视界
  vec3 p = position;
  p = mix(p, gc, pull * .5);
  p = mix(p, uHole, pull * pull * .95);
  // 绕着 bot 的星云公转：被吸得越狠，转得越慢（最后停住，直接坠向视界）
  float ang = uOrbit * osp * (1.0 - pull);
  float ca = cos(ang), sa = sin(ang);
  p = vec3(p.x * ca - p.y * sa, p.x * sa + p.y * ca, p.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
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
attribute vec3 gc; attribute float pull; attribute float osp;
uniform vec2 af[80]; uniform float uMono; uniform float uTime; uniform float uPx; uniform float uFade; uniform float uGain;
uniform vec3 uHole; uniform float uHold; uniform float uHoldT; uniform float uOrbit;
varying vec3 vCol; varying float vA;
void main(){
  vec3 p = position;
  p = mix(p, gc, pull * .5);
  p = mix(p, uHole, pull * pull * .95);
  // 绕着 bot 的星云公转
  float ang = uOrbit * osp * (1.0 - pull);
  float ca = cos(ang), sa = sin(ang);
  p = vec3(p.x * ca - p.y * sa, p.x * sa + p.y * ca, p.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 q = af[int(grp + 0.5)];
  float a = clamp(q.x, 0.0, 1.5);
  // 被截停的那颗星：闪烁停住，钉在原地
  float tt = (abs(grp - uHold) < .5) ? uHoldT : uTime;
  float tw = 0.62 + 0.38 * sin(tt * (0.9 + ph * 2.2) + ph * 40.0);
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

function disposeBrain(){
  if (SC.memSpr) { SC.memSpr.forEach(s => { if (!s) return; spin.remove(s); s.material.dispose(); }); SC.memSpr = []; }
  if (SC.lines) { spin.remove(SC.lines); SC.lines.geometry.dispose(); SC.lines.material.dispose(); SC.lines = null; }
  if (SC.pts) { spin.remove(SC.pts); SC.pts.geometry.dispose(); SC.pts.material.dispose(); SC.pts = null; }
  if (SC.sigP) { spin.remove(SC.sigP); SC.sigP.geometry.dispose(); SC.sigP.material.dispose(); SC.sigP = null; }
  if (SC.trailL) { spin.remove(SC.trailL); SC.trailL.geometry.dispose(); SC.trailL.material.dispose(); SC.trailL = null; }
}
/* 记忆的亮度目标：状态决定上限，保持率决定具体值 */
function fadeTarget(st, ret){
  if (st === 'archived') return .93;
  if (st === 'faded') return .48 + (1 - clamp(ret, 0, 1)) * .34;
  return .03 + (1 - clamp(ret, 0, 1)) * .15;
}
function buildBrain(){
  SPRITE = SPRITE || spriteTexture();
  const V = THREE.Vector3;
  disposeBrain();
  /* ---- 场景簇：0 = 恒星（bot 本体），1..M = 一条条具体记忆 ---- */
  const M = SC.mem.length;
  SC.n = M + 1;
  GBG = SC.n;                       // 背景灰质
  SC.bunBase = SC.n + 1;            // 突触束的组号起点
  CL.length = 0; BUN.length = 0; for (const k in BMAP) delete BMAP[k];
  CL.push(new V(0, 0, 0));                       // 恒星：正中
  for (let i = 0; i < M; i++) {                 // 记忆：螺旋星系排布，越靠外越暗
    const t = (i + .5) / Math.max(1, M);
    const ang = i * 2.399963 + .7, r = .42 + .96 * Math.pow(t, .62);
    CL.push(new V(Math.cos(ang) * r, Math.sin(ang) * r * .74, Math.sin(i * 1.9) * .05));
  }
  const px = [], py = [], pz = [], ng = [], nc = [], ns = [];
  const members = Array.from({length: SC.n}, () => []);
  function addN(x, y, z, g, c, s){
    const r = Math.hypot(x, y, z), lim = 1.8;
    if (r > lim) { const k = (lim - R() * .12) / r; x *= k; y *= k; z *= k; }
    const i = px.length; px.push(x); py.push(y); pz.push(z); ng.push(g); nc.push(c); ns.push(s);
    if (g < SC.n) members[g].push(i);
    return i;
  }
  /* 恒星：一颗实心核 + 一圈日冕 */
  for (let k = 0; k < 5; k++) addN(rg() * .02, rg() * .02, rg() * .02, 0, 0, .085);
  for (let k = 0; k < 230; k++) addN(rg() * .065, rg() * .065, rg() * .065, 0, 0, .015 + R() * .012);
  for (let k = 0; k < 300; k++) { const d = randUnit(), u = .1 + Math.pow(R(), .55) * .16; addN(d.x * u, d.y * u, d.z * u, 0, 0, .008 + R() * .009); }
  /* 记忆 = 一颗星：核心 + 一点点光晕，主要形象交给带星芒的 sprite */
  SC.osp = new Float32Array(AFG);
  for (let c = 1; c < SC.n; c++) {
    const C = CL[c], rr = Math.hypot(C.x, C.y);
    SC.osp[c] = .34 / (rr + .55);            // 差速自转：靠里转得快，靠外转得慢
    addN(C.x, C.y, C.z, c, c, .052);
    for (let k = 0; k < 7; k++) addN(C.x + rg() * .016, C.y + rg() * .016, C.z + rg() * .016, c, c, .012 + R() * .009);
  }
  /* 背景灰质：铺满整个球，让星云连成一片 */
  for (let k = 0; k < 4200; k++) {
    let x, y, z; do { x = R() * 2 - 1; y = R() * 2 - 1; z = R() * 2 - 1; } while (x * x + y * y + z * z > 1);
    const dd = Math.hypot(x, y, z) || 1, rr = Math.pow(dd, 1.35) / dd;
    x *= 1.78 * rr; y *= 1.78 * rr; z *= 1.45 * rr;
    let best = 0, bd = 1e9;
    for (let c = 0; c < SC.n; c++) { const d = (x - CL[c].x) ** 2 + (y - CL[c].y) ** 2 + (z - CL[c].z) ** 2; if (d < bd) { bd = d; best = c; } }
    addN(x, y, z, GBG, best, .009 + R() * .011);
  }
  const N = px.length; NEU = N;
  NX = Float32Array.from(px); NY = Float32Array.from(py); NZ = Float32Array.from(pz); MEM = members;
  const ncol = i => { const c = SC.col[nc[i]] || [1, 1, 1], k = ng[i] === GBG ? .72 : 1; return [c[0] * k, c[1] * k, c[2] * k]; };

  /* 局部连接：空间网格找最近邻 */
  const CELL = .16, grid = new Map(), key = (a, b, c) => a + ',' + b + ',' + c;
  for (let i = 0; i < N; i++) { const k = key(Math.floor(px[i] / CELL), Math.floor(py[i] / CELL), Math.floor(pz[i] / CELL)); let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(i); }
  const seen = new Set(), LP = [], LC = [], LG = [], LS = [], LPG = [], LGC = [], LOSP = [];
  function seg(x1, y1, z1, x2, y2, z2, c1, c2, g, s, pg0, pg1, o0, o1){
    LP.push(x1, y1, z1, x2, y2, z2); LC.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
    LG.push(g, g); LS.push(s, s); LPG.push(pg0, pg1);
    LOSP.push(o0 || 0, o1 || 0);
    const a = CL[pg0] || CL[0], b = CL[pg1] || CL[0];
    LGC.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  let syn = 0;
  for (let i = 0; i < N; i++) {
    const gx = Math.floor(px[i] / CELL), gy = Math.floor(py[i] / CELL), gz = Math.floor(pz[i] / CELL);
    const K = 3, maxD = ng[i] === GBG ? .28 : .22, cand = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const arr = grid.get(key(gx + a, gy + b, gz + c)); if (!arr) continue;
      for (const j of arr) { if (j === i) continue; const d = (px[i] - px[j]) ** 2 + (py[i] - py[j]) ** 2 + (pz[i] - pz[j]) ** 2; if (d < maxD * maxD) cand.push([d, j]); }
    }
    cand.sort((p, q) => p[0] - q[0]);
    for (let k = 0; k < Math.min(K, cand.length); k++) {
      const j = cand[k][1], lo = Math.min(i, j), hi = Math.max(i, j), id = lo * N + hi;
      if (seen.has(id)) continue; seen.add(id);
      const same = ng[i] === ng[j] && ng[i] < SC.n;
      seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), same ? ng[i] : GBG, same ? .55 : .32, ng[i], ng[j]);
      syn++;
    }
  }
  /* 远程细丝：让网更密、更乱一点 */
  for (let k = 0; k < 12000; k++) {
    const i = (R() * N) | 0, j = (R() * N) | 0;
    const d = Math.hypot(px[i] - px[j], py[i] - py[j], pz[i] - pz[j]);
    if (d < .22 || d > .6) continue;
    seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), GBG, .15, ng[i], ng[j]); syn++;
  }
  /* 突触束：恒星 → 每一条记忆。召回时脉冲就沿着这条束飞过去 */
  for (let c = 1; c < SC.n; c++) {
    const g = SC.bunBase + (c - 1); if (g >= AFG) break;
    const strands = [], ns2 = 4;
    for (let s = 0; s < ns2; s++) {
      const i0 = members[0][(R() * members[0].length) | 0], i1 = members[c][(R() * members[c].length) | 0];
      const p0 = new V(px[i0], py[i0], pz[i0]), p1 = new V(px[i1], py[i1], pz[i1]);
      const mid = p0.clone().add(p1).multiplyScalar(.5);
      const m = Math.hypot(mid.x, mid.y) || .01, push = .13 + R() * .17;
      const cpt = new V(mid.x / m * push, mid.y / m * push, mid.z + (R() - .5) * .2);
      strands.push({p0, c: cpt, p1, len: p0.distanceTo(cpt) + cpt.distanceTo(p1)});
      const ca = SC.col[0] || [1, 1, 1], cb = SC.col[c] || [1, 1, 1], SEG = 14;
      const osp = SC.osp[c] || 0;
      let lx = p0.x, ly = p0.y, lz = p0.z;
      for (let k = 1; k <= SEG; k++) {
        const u = k / SEG, v = 1 - u;
        const x = v * v * p0.x + 2 * v * u * cpt.x + u * u * p1.x, y = v * v * p0.y + 2 * v * u * cpt.y + u * u * p1.y, z = v * v * p0.z + 2 * v * u * cpt.z + u * u * p1.z;
        const u0 = (k - 1) / SEG;
        seg(lx, ly, lz, x, y, z, [ca[0] + (cb[0] - ca[0]) * u0, ca[1] + (cb[1] - ca[1]) * u0, ca[2] + (cb[2] - ca[2]) * u0],
            [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u], g, .16, c, c, osp * u0, osp * u);
        lx = x; ly = y; lz = z;
      }
      syn++;
    }
    const b = {a: 0, b: c, g, strands}; BUN.push(b); BMAP['0-' + c] = b;
  }
  SYN = syn;

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3));
  lg.setAttribute('col', new THREE.Float32BufferAttribute(LC, 3));
  lg.setAttribute('grp', new THREE.Float32BufferAttribute(LG, 1));
  lg.setAttribute('shade', new THREE.Float32BufferAttribute(LS, 1));
  lg.setAttribute('gc', new THREE.Float32BufferAttribute(LGC, 3));
  lg.setAttribute('osp', new THREE.Float32BufferAttribute(LOSP, 1));
  SC.pullL = new Float32Array(LP.length / 3);
  lg.setAttribute('pull', new THREE.BufferAttribute(SC.pullL, 1).setUsage(THREE.DynamicDrawUsage));
  const uni = {af: {value: AF}, uMono: {value: 0}, uFade: {value: 8}, uTime: {value: 0}, uPx: {value: 800}, uGain: {value: 1},
               uHole: {value: new THREE.Vector3(HOLE.x, HOLE.y, HOLE.z)}, uHold: {value: -1}, uHoldT: {value: 0},
               uOrbit: {value: 0},
               map: {value: SPRITE}};
  SC.uni = uni;
  SC.lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({uniforms: uni, vertexShader: BRAIN_VS_L, fragmentShader: BRAIN_FS_L, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  spin.add(SC.lines);

  const pg = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), col = new Float32Array(N * 3), grp = new Float32Array(N), sz = new Float32Array(N), ph = new Float32Array(N), gcP = new Float32Array(N * 3), ospP = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i];
    const c = ncol(i); col.set(c, i * 3); grp[i] = ng[i]; sz[i] = ns[i]; ph[i] = R();
    const cc = CL[ng[i]] || CL[0]; gcP[i * 3] = cc.x; gcP[i * 3 + 1] = cc.y; gcP[i * 3 + 2] = cc.z;
    ospP[i] = SC.osp[ng[i]] || 0;
  }
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('col', new THREE.BufferAttribute(col, 3));
  pg.setAttribute('grp', new THREE.BufferAttribute(grp, 1)); pg.setAttribute('sz', new THREE.BufferAttribute(sz, 1)); pg.setAttribute('ph', new THREE.BufferAttribute(ph, 1));
  pg.setAttribute('gc', new THREE.BufferAttribute(gcP, 3));
  pg.setAttribute('osp', new THREE.BufferAttribute(ospP, 1));
  SC.pullP = new Float32Array(N);
  pg.setAttribute('pull', new THREE.BufferAttribute(SC.pullP, 1).setUsage(THREE.DynamicDrawUsage));
  SC.pts = new THREE.Points(pg, new THREE.ShaderMaterial({uniforms: uni, vertexShader: BRAIN_VS_P, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  spin.add(SC.pts);

  /* 信号脉冲：一个点缓冲，头亮尾暗 */
  const SIGN = 4000;
  sigGeo = new THREE.BufferGeometry();
  sigGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SIGN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('col', new THREE.Float32BufferAttribute(new Float32Array(SIGN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('sz', new THREE.Float32BufferAttribute(new Float32Array(SIGN), 1).setUsage(THREE.DynamicDrawUsage));
  sigGeo.setAttribute('al', new THREE.Float32BufferAttribute(new Float32Array(SIGN), 1).setUsage(THREE.DynamicDrawUsage));
  sigMat = new THREE.ShaderMaterial({uniforms: {map: {value: SPRITE}, uPx: uni.uPx}, vertexShader: SIG_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const sp = new THREE.Points(sigGeo, sigMat); sp.frustumCulled = false; spin.add(sp); SC.sigP = sp;
  trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6000 * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(6000 * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setDrawRange(0, 0);
  const tl = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
  tl.frustumCulled = false; spin.add(tl); SC.trailL = tl;

  /* 每组在线里占的顶点：被黑洞吸走时按组刷 pull */
  SC.pullIdxL = Array.from({length: AFG}, () => []);
  for (let v = 0; v < LPG.length; v++) { const g = LPG[v]; if (g < AFG) SC.pullIdxL[g].push(v); }

  /* 每条记忆 = 一颗带星芒的星 */
  SC.memSpr = [];
  for (let c = 1; c < SC.n; c++) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({map: starTex(), color: 0xffffff, transparent: true,
      opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false}));
    spr.scale.setScalar(.09);
    spr.position.copy(CL[c]);
    spin.add(spr);
    SC.memSpr.push(spr);
  }

  probe.p = new V(CL[0].x, CL[0].y, CL[0].z + .12); probe.a = probe.p.clone(); probe.b = probe.p.clone(); probe.c = probe.p.clone();
}

/* ---------- 黑洞：事件视界（移植 agent-display「06 · 视界熔炉」） ---------- */
const HOLE_VS = `
attribute vec2 aQ;
uniform vec2 uRes; uniform vec2 uCtr; uniform float uHalf;
varying vec2 vP;
void main(){ vP = uCtr + aQ * uHalf; gl_Position = vec4(vP.x / uRes.x * 2.0 - 1.0, 1.0 - vP.y / uRes.y * 2.0, 0.0, 1.0); }`;
const HOLE_FS = `
precision highp float;
uniform vec2 uCtr; uniform float uR, uTime, uEnergy, uPulse, uWarm, uAlpha; varying vec2 vP;
float sq(float x){ return x * x; }
void main(){
  vec2 q = vP - uCtr; q.y = -q.y;
  float r = length(q) / uR; float ang = atan(q.y, q.x);
  vec3 tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.80, 0.62), uWarm);
  float beam = 0.5 + 0.5 * cos(ang - 2.3);
  float glow = exp(-max(r - 1.0, 0.0) * 2.5) * 0.17 * (0.75 + uEnergy * 0.7);
  float s1 = 0.5 + 0.5 * sin(ang * 9.0 + r * 13.0 - uTime * 1.2);
  float s2 = 0.5 + 0.5 * sin(ang * 17.0 - r * 21.0 + uTime * 0.8 + 1.7);
  float band = exp(-sq((r - 1.28) / 0.34));
  float acc = band * (s1 * 0.6 + s2 * 0.4) * 0.11 * (0.6 + uEnergy);
  float ring = exp(-sq((r - 1.0) / 0.02)) * (0.45 + 0.95 * beam) * (0.85 + uEnergy * 0.6);
  float ring2 = exp(-sq((r - 1.05) / 0.07)) * 0.22 * (0.4 + beam);
  float halo = exp(-sq((r - 1.62) / 0.045)) * 0.05;
  float pr = 1.0 + uPulse * 3.6;
  float shock = uPulse > 0.0 ? exp(-sq((r - pr) / (0.05 + uPulse * 0.12))) * (1.0 - uPulse) * 0.55 : 0.0;
  vec3 col = tint * (glow * (0.6 + 0.6 * beam) + acc + ring + ring2 + halo + shock);
  float disc = 1.0 - smoothstep(0.985, 1.0, r);
  vec3 dcol = vec3(0.004, 0.005, 0.008) + tint * 0.035 * smoothstep(0.55, 1.0, r) * beam;
  gl_FragColor = vec4(col * (1.0 - disc) + dcol * disc, disc) * uAlpha;
}`;
/* 星：核心 + 四角衍射星芒 */
let STAR_TEX = null;
function starTex(){
  if (STAR_TEX) return STAR_TEX;
  const S = 160, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), cx = S / 2;
  const gr = g.createRadialGradient(cx, cx, 0, cx, cx, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(.05, 'rgba(255,255,255,.92)');
  gr.addColorStop(.15, 'rgba(205,238,255,.42)');
  gr.addColorStop(.42, 'rgba(140,190,255,.12)');
  gr.addColorStop(1, 'rgba(90,140,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const spike = (a, len, w, al) => {
    g.save(); g.translate(cx, cx); g.rotate(a);
    const lg = g.createLinearGradient(-len, 0, len, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(.5, 'rgba(255,255,255,' + al + ')');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.beginPath(); g.moveTo(-len, 0); g.lineTo(0, -w); g.lineTo(len, 0); g.lineTo(0, w); g.closePath(); g.fill();
    g.restore();
  };
  spike(0, S * .49, 1.9, .5);
  spike(Math.PI / 2, S * .49, 1.9, .5);
  spike(Math.PI / 4, S * .25, 1.3, .26);
  spike(-Math.PI / 4, S * .25, 1.3, .26);
  STAR_TEX = new THREE.CanvasTexture(c);
  return STAR_TEX;
}
/* 黑洞是屏幕空间的：把它的中心/半径换算到当前渲染分辨率上 */
function syncHole(rw, rh){
  if (!SC.holeUni) return;
  const u = SC.holeUni, hp = SC.holePos || CL[0];
  const [hx, hy] = screenOf(hp);
  const t = Math.tan(camera.fov * Math.PI / 360);
  const pxPer = rh / (2 * t * Math.max(.01, fitD));
  const R = HOLE.r * pxPer;
  u.uRes.value.set(rw, rh);
  u.uCtr.value.set(hx * rw / Math.max(1, W), hy * rh / Math.max(1, H));
  u.uR.value = R;
  u.uHalf.value = R * 6;
  u.uTime.value = animT;
  u.uEnergy.value = clamp(.35 + SC.absorbed * .05 + boost * .35, 0, 1.4);
  u.uWarm.value = clamp(.22 + SC.absorbed * .04, 0, 1);
  u.uPulse.value = SC.holePulse || 0;
}
function buildHole(){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('aQ', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  SC.holeUni = {uRes: {value: new THREE.Vector2(1, 1)}, uCtr: {value: new THREE.Vector2(0, 0)}, uHalf: {value: 1}, uR: {value: 1},
                uTime: {value: 0}, uEnergy: {value: .5}, uPulse: {value: 0}, uWarm: {value: .35}, uAlpha: {value: 1}};
  const m = new THREE.ShaderMaterial({uniforms: SC.holeUni, vertexShader: HOLE_VS, fragmentShader: HOLE_FS,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation});
  SC.hole = new THREE.Mesh(g, m);
  SC.hole.frustumCulled = false;
  SC.hole.renderOrder = 900;
  scene.add(SC.hole);
  SC.holePos = new THREE.Vector3(HOLE.x, HOLE.y, HOLE.z);
  SC.holePulse = 0;
}

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
  // 外围那圈「肥鱼 / 遗忘站 / 空位」标签环按用户要求整圈删除
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
  buildHole();
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
const busy = g => g === 0 || !!(SC.mem[g - 1] && scopeBusy(SC.mem[g - 1].scopeIndex));
const whiten = (c, k) => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];
function pGet(){ for (let n = 0; n < PMAX; n++) { const i = (pFree + n) % PMAX; if (!parts[i].on) { pFree = (i + 1) % PMAX; parts[i].on = true; parts[i].u = 0; return parts[i]; } } return null; }
function busyList(){ const l = []; for (let i = 0; i < SC.n; i++) if (busy(i)) l.push(i); return l; }
function spawnChatter(){
  // 挑一条两端至少有一个在忙的突触束，从忙的那头往外送
  let b = null;
  for (let t = 0; t < 6; t++) { const q = BUN[(Math.random() * BUN.length) | 0]; if (busy(q.a) || busy(q.b)) { b = q; break; } }
  if (!b) b = BUN[(Math.random() * BUN.length) | 0];
  const s = b.strands[(Math.random() * b.strands.length) | 0], fwd = busy(b.a) && (!busy(b.b) || Math.random() < .5);
  const p = pGet(); if (!p) return;
  const A = fwd ? s.p0 : s.p1, B = fwd ? s.p1 : s.p0;
  p.m = 1; p.ax = A.x; p.ay = A.y; p.az = A.z; p.cx = s.c.x; p.cy = s.c.y; p.cz = s.c.z; p.bx = B.x; p.by = B.y; p.bz = B.z;
  p.dur = clamp(s.len / rnd(1.9, 3.4), .35, 1.2); p.col = whiten(SC.col[fwd ? b.a : b.b] || [1, 1, 1], .22); p.sz = rnd(.05, .075); p.al = rnd(.7, 1); p.tr = 6; p.gap = .04;
}
function spawnSpark(l){
  const c = l.length ? l[(Math.random() * l.length) | 0] : 0, mem = MEM[c];
  const i0 = mem[(Math.random() * mem.length) | 0], i1 = mem[(Math.random() * mem.length) | 0];
  const p = pGet(); if (!p) return;
  p.m = 0; p.ax = NX[i0]; p.ay = NY[i0]; p.az = NZ[i0]; p.bx = NX[i1]; p.by = NY[i1]; p.bz = NZ[i1];
  p.dur = rnd(.25, .6); p.col = whiten(SC.col[c] || [1, 1, 1], .35); p.sz = rnd(.04, .06); p.al = rnd(.6, 1); p.tr = 3; p.gap = .06;
}
function spawnMeteor(c, ang){
  const p = pGet(); if (!p) return;
  const C = CL[c], th = ang != null ? ang + rnd(-.28, .28) : (c === 0 ? Math.random() * TAU : Math.atan2(C.y, C.x) + rnd(-.6, .6));
  const ox = C.x + rnd(-.18, .18), oy = C.y + rnd(-.18, .18), oz = C.z + rnd(-.15, .15);
  const ez = rnd(-.35, .35), L = rnd(4.6, 7.2), dx = Math.cos(th) * Math.cos(ez), dy = Math.sin(th) * Math.cos(ez), dz = Math.sin(ez), bend = rnd(-.5, .5);
  p.m = 2; p.ax = ox; p.ay = oy; p.az = oz; p.bx = ox + dx * L; p.by = oy + dy * L; p.bz = oz + dz * L;
  p.cx = ox + dx * L * .5 - dy * bend; p.cy = oy + dy * L * .5 + dx * bend; p.cz = oz + dz * L * .5;
  p.dur = rnd(1.3, 2.3); p.col = whiten(SC.col[c] || [1, 1, 1], .12); p.sz = rnd(.08, .11); p.al = 1; p.tr = 12; p.gap = .018; p.lr = 0; p.hit = false;
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
SC.ovl = $('#ovl');
const clsEl = $('#cls'), feedEl = $('#feed'), tip = $('#tip');
const rows = AG.map((a, i) => {
  if (i === 0 || i === CRAWLER) return null;          // 恒星在正中，列表不放；维护探针走巡检
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
    const r = rows[i]; if (!r) return;              // 恒星不在列表里
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
  if (!p) return;
  if (lastHand && lastHand.t > 0) {
    const y1 = rowY[lastHand.a], y2 = rowY[lastHand.b], bulge = 18 + Math.abs(y2 - y1) * .09;
    p.setAttribute('d', `M2 ${y1} C ${2 + bulge} ${y1}, ${2 + bulge} ${y2}, 2 ${y2}`);
    p.setAttribute('stroke', lastHand.col); p.setAttribute('opacity', String(clamp(lastHand.t, 0, 1)));
  } else p.setAttribute('opacity', '0');
}
/* 记忆详情：悬停截停的那颗星 */
function renderMem(){
  const el = $('#mem'), st = $('#memState');
  if (!el) return;
  const g = SC.held >= 0 ? SC.held : (hover >= 0 ? hover : -1);
  const m = g > 0 ? SC.mem[g - 1] : null;
  if (!m) {
    if (st) st.textContent = '悬停截停';
    el.innerHTML = '<div class="mem-empty">把鼠标放到一颗星星上 → <b>截停它</b><br>这里会显示这条记忆的细节。<br>点一下星星，直接进调试台看完整档案。</div>';
    return;
  }
  if (st) st.textContent = '截停中 · #' + m.id;
  const sc = SC.col[g] || [1, 1, 1];
  const col = `rgb(${Math.round(sc[0] * 255)},${Math.round(sc[1] * 255)},${Math.round(sc[2] * 255)})`;
  const chip = (t, c) => `<span class="chip" style="--c:${c}">${t}</span>`;
  const keep = Math.round(m.retention * 100);
  const left = m.fade > .8 ? '快要消散' : m.fade > .3 ? '正在消散' : '还很稳';
  el.innerHTML =
    '<div class="mem-k">' + chip('#' + m.id, col) + chip(TYPE_ZH[m.type] || m.type || '记忆', '#a9b4c3') +
    chip(m.status === 'active' ? '明亮' : m.status === 'faded' ? '变暗' : '熄灭', m.status === 'active' ? '#3ce69a' : m.status === 'faded' ? '#ffb547' : '#9aa6ff') +
    chip(m.scope || '', '#6b7685') + '</div>' +
    '<div class="mem-t">' + (m.content || '（无正文）') + '</div>' +
    '<div class="mem-bar"><i style="width:' + keep + '%;background:' + col + '"></i></div>' +
    '<dl><dt>保持率</dt><dd>' + keep + '%</dd><dt>清晰度</dt><dd>' + Math.round(m.clarity * 100) + '%</dd>' +
    '<dt>重要度</dt><dd>' + Math.round(m.importance * 100) + '%</dd><dt>半衰期</dt><dd>' + (m.halfLife == null ? '—' : m.halfLife + ' 天') + '</dd>' +
    '<dt>强化 / 检索</dt><dd>' + (m.recallCount || 0) + ' / ' + (m.reviewCount || 0) + ' 次</dd>' +
    '<dt>发生于</dt><dd>' + (m.eventTime || '时间不详') + '</dd><dt>距消散</dt><dd>' + left + '</dd></dl>' +
    '<div class="mem-tip">已截停 · 点这颗星进调试台</div>';
}
/* 恒星卡：bot 本体 */
function renderBot(){
  const T = MODEL.totals || {}, nm = MODEL.botName || 'BOT';
  const bn = $('#botName'); if (bn) { bn.textContent = nm; }
  const bs = $('#botSub'); if (bs) bs.textContent = `记忆就是星 · ${fmt(T.all || 0)} 颗 · ${MODEL.scopeCount || 0} 个星域 · 今天新写 ${fmt(MODEL.todayNew || 0)} 颗`;
  const bb = $('#botBright'); if (bb) bb.textContent = fmt(T.active || 0);
  const bf = $('#botFaded'); if (bf) bf.textContent = fmt(T.faded || 0);
  const bg = $('#botGone'); if (bg) bg.textContent = fmt(SC.absorbed);
  const hc = $('#holeCount'); if (hc) hc.textContent = fmt(SC.absorbed);
  const ob = $('#ovlBot'); if (ob) ob.textContent = nm;
}
/* 点恒星上的名字 → 去调试台设置页改 bot 名字 */
function bindBotName(){
  const el = $('#botName');
  if (!el || el.__bsmBound) return;
  el.__bsmBound = true;
  el.title = '点这里改 bot 的名字';
  el.addEventListener('click', () => { if (host.__nr && host.__nr.openBotSettings) host.__nr.openBotSettings(); });
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
  const cwP = $('#cwP'); if (cwP) cwP.textContent = fmt(crawl.patrols);
  const cwR = $('#cwR'); if (cwR) cwR.textContent = fmt(crawl.read);
  const cwB = $('#cwB'); if (cwB) cwB.textContent = crawl.bugs;
  const cwF = $('#cwF'); if (cwF) cwF.textContent = failN;
  const ta = AG[crawl.target], cwNow = $('#cwNow');
  if (cwNow) cwNow.innerHTML = `<b>${probe.u < 1 ? '飞往' : '正在看'}</b>${ta.k} ${ta.zh}${ta.cur ? ' · ' + ta.cur.id + ' ' + ta.cur.name : ' · 待命'}`;
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
  // 恒星：呼吸 + 召回时的一下亮
  AF[0] += ((.5 + .12 * Math.sin(animT * 2.2) + boost * .16) - AF[0]) * (1 - Math.exp(-dt * 6));
  // 每条记忆：亮度 = 保持率 + 状态；越暗 = 越靠近黑洞
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1]; if (!m) continue;
    const a = AG[1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, m.scopeIndex || 0))];
    let t = .1 + m.retention * .44 + (a && a.cur ? .3 : 0) + (a && a.flash ? a.flash * .55 : 0);
    t *= (1 - m.fade * .62);
    AF[g * 2] += (t - AF[g * 2]) * (1 - Math.exp(-dt * 6));
  }
  AF[GBG * 2] = .16 + boost * .12;
  for (const b of BUN) { const g = b.g, cur = AF[g * 2] * Math.exp(-dt * 1.6); AF[g * 2] = Math.max(cur, bunHot[g] * .85); bunHot[g] = 0; }
  // 聚焦：被截停的那颗星最亮，其余压暗
  for (let g = 0; g < AFG; g++) {
    let tgt = 1;
    if (focus >= 0) {
      if (g < SC.n) tgt = g === focus ? 1 : .18;
      else if (g === GBG) tgt = .3;
      else { const b = BUN[g - SC.bunBase]; tgt = b && (b.a === focus || b.b === focus) ? 1.4 : .08; }
    }
    AF[g * 2 + 1] += (tgt - AF[g * 2 + 1]) * (1 - Math.exp(-dt * 4));
  }
  // 引力：fade 越大越被黑洞拖过去；被吞掉就消失
  let pullDirty = false;
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1]; if (!m) continue;
    if (m.status === 'faded' || m.status === 'archived') m.target = Math.min(1, m.target + dt * (m.status === 'archived' ? .008 : .011));
    m.fade += (m.target - m.fade) * Math.min(1, dt * .35);
    if (m.fade >= .985 && m.target > .9) {
      m.dead = true; SC.absorbed++; SC.gone[m.id] = 1; SC.holePulse = 1;
      log(0, '消散', `#${m.id} ${starLabel(m)} → 黑洞`, 'bad');
      SC.mem.splice(g - 1, 1); SC.col.splice(g, 1);
      buildBrain(); pullDirty = true; g--;
      continue;
    }
    if (Math.abs(m.fade - (SC.pull[g] || 0)) > .002) {
      SC.pull[g] = m.fade; pullDirty = true;
      const mm = MEM[g] || [];
      for (const i of mm) SC.pullP[i] = m.fade;
      const li = SC.pullIdxL[g] || [];
      for (const v of li) SC.pullL[v] = m.fade;
    }
  }
  if (pullDirty && SC.pts && SC.lines) { SC.pts.geometry.attributes.pull.needsUpdate = true; SC.lines.geometry.attributes.pull.needsUpdate = true; }
  const u = (SC.lines || brainLines).material.uniforms;
  u.uMono.value = mono; u.uTime.value = animT; u.uFade.value = camera.position.length() - 1.7;
  u.uGain.value += ((bloomOn && composer ? .62 : 1) * sizeGain - u.uGain.value) * (1 - Math.exp(-dt * 4));   // 开辉光时线条收一点，避免中心糊成一团
  // 探针拖尾
  probe.trail.unshift(probe.p.clone()); if (probe.trail.length > 16) probe.trail.pop();
  writeSignals();
  // HUD 转动
  spin.rotation.z = sceneT * .035;                     // 约 3 分钟转一圈
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
  // 轨道时钟 + 每颗记忆星的位置 / 亮度
  if (SC.uni) SC.uni.uOrbit.value = sceneT;
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1], spr = SC.memSpr && SC.memSpr[g - 1];
    if (!m || !spr) continue;
    const c = CL[g], ang = sceneT * (SC.osp[g] || 0) * (1 - m.fade);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    spr.position.set(c.x * ca - c.y * sa, c.x * sa + c.y * ca, c.z);
    const br = clamp(AF[g * 2], 0, 1.2);
    const col = SC.col[g] || [1, 1, 1];
    spr.material.color.setRGB(col[0], col[1], col[2]);
    spr.material.opacity = clamp((1 - m.fade * .92) * (.22 + br * .9), 0, 1);
    spr.scale.setScalar((.052 + (m.importance || 0) * .045) * (.8 + br * .55) * (1 + m.fade * .6));
  }
  // 黑洞：事件视界（移植「视界熔炉」）
  SC.holePulse = Math.max(0, (SC.holePulse || 0) - dt * .55);
  syncHole(W * pr, H * pr);
  // 浮层：恒星的名字和黑洞的位置跟着 3D 走
  if (SC.ovl) {
    const hp = SC.holePos || CL[0];
    const [bx, by] = screenOf(CL[0]), [hx, hy] = screenOf(hp);
    SC.ovl.style.setProperty('--bx', bx.toFixed(1) + 'px');
    SC.ovl.style.setProperty('--by', by.toFixed(1) + 'px');
    SC.ovl.style.setProperty('--hx', hx.toFixed(1) + 'px');
    SC.ovl.style.setProperty('--hy', hy.toFixed(1) + 'px');
  }
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
  // 悬停 = 截停：先定下这一轮截住了谁
  const heldNow = (hover >= 0 && hover < SC.n) ? hover : -1;
  if (heldNow !== SC.held) {
    SC.held = heldNow;
    if (SC.uni) { SC.uni.uHold.value = heldNow; SC.uni.uHoldT.value = animT; }
  }
  if (!paused) { simStep(dt); decay(dt); animT += dt; }
  if (heldNow < 0) sceneT += dt;                          // 截停时星海不转，镜头也不飘
  uiAcc += dt; tapeAcc += dt;
  if (uiAcc >= .25) {
    uiAcc = 0;
    renderList(); renderBottom(); renderHeat(); renderSpark(); renderMem(); renderBot();
    if (feedDirty) renderFeed();
    if (capDirty) renderCap();
    if (tapeDirty && tapeAcc > 1) { tapeAcc = 0; drawTape(); }
  }
  if (!glOK) return;
  if (cam.userT > 0) cam.userT -= dt; else { cam.yaw *= Math.exp(-dt * .7); cam.pitch *= Math.exp(-dt * .7); }
  camWant(sceneT);
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
  rowY = rows.map(r => r ? r.el.offsetTop + r.el.offsetHeight / 2 : 0);
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
  if (SC.lines) SC.lines.material.uniforms.uPx.value = H * pr / (2 * t);
  // 星环在屏幕上越小，线条叠得越密，按尺寸减淡，免得小屏糊成一团白
  sizeGain = clamp(Rr * H / (fitD * t) / 900, .32, 1);
  needsT = .6;
}

/* ---------- 交互 ---------- */
const v3 = glOK ? new THREE.Vector3() : null;
function screenOf(p){ v3.copy(p).applyMatrix4(spin.matrixWorld).project(camera); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H]; }
function pickAt(x, y){
  if (!glOK) return -1;
  let best = -1, bd = 46 * 46;
  const test = (i, p) => { const [sx, sy] = screenOf(p); const d = (sx - x) ** 2 + (sy - y) ** 2; if (d < bd) { bd = d; best = i; } };
  for (let i = 0; i < SC.n; i++) test(i, CL[i]);
  return best;
}
function showTip(i){
  if (i <= 0) {
    const nm = (MODEL.botName || 'BOT');
    tip.style.setProperty('--c', '#a6f1ff');
    tip.innerHTML = `<span><b>${nm}</b><strong>记忆恒星</strong> · BOT</span><span>${fmt((MODEL.totals || {}).all || 0)} 颗记忆都挂在它身上</span><span class="h">点它可以去设置里改名字</span>`;
  } else {
    const m = SC.mem[i - 1];
    if (!m) { tip.hidden = true; return; }
    const c = SC.col[i] || [1, 1, 1];
    const col = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    const st = m.status === 'active' ? '明亮' : m.status === 'faded' ? '正在消散' : '快要熄灭';
    tip.style.setProperty('--c', col);
    tip.innerHTML = `<span><b>#${m.id}</b><strong>${TYPE_ZH[m.type] || m.type || '记忆'}</strong> · ${m.scope || ''}</span>` +
      `<span>${starLabel(m)}</span>` +
      `<span>保持率 ${Math.round(m.retention * 100)}% · 重要度 ${Math.round(m.importance * 100)}% · ${st}</span>` +
      `<span class="h">${focus === i ? '已钉住 · 再点一次取消' : '已截停 · 点一下进调试台看完整档案'}</span>`;
  }
  tip.hidden = false;
  const [sx, sy] = screenOf(CL[i]);
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
  focus = (i >= 0 && i < SC.n && focus !== i) ? i : -1;
  needsT = 1.5;
  if (i > 0 && SC.mem[i - 1] && host.__nr && host.__nr.openDetail) host.__nr.openDetail(SC.mem[i - 1].id);
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
    // 没有记忆的星域不占位（恒星已经单独一张卡了）
    const empty = i >= 1 && i < 1 + SCOPE_SLOTS && a.k === 'IDLE';
    r.el.style.display = empty ? 'none' : '';
    if (empty) return;
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

  // ---- 场景层：挑出要上屏的记忆星（亮的多、暗的少、熄灭的最少）----
  const alive = (MODEL.stars || []).filter(x => !SC.gone[x.id]);
  const rank = x => ({active: 0, faded: 1, archived: 2}[x.status] ?? 0);
  const sorted = alive.slice().sort((a, b) => rank(a) - rank(b) ||
    ((b.importance || 0) + (b.retention || 0)) - ((a.importance || 0) + (a.retention || 0)));
  const quota = {active: Math.round(MAXMEM * .64), faded: Math.round(MAXMEM * .24), archived: MAXMEM};
  const used = {active: 0, faded: 0, archived: 0}, sel = [];
  for (const x of sorted) {
    const k = rank(x) === 0 ? 'active' : rank(x) === 1 ? 'faded' : 'archived';
    if (used[k] >= quota[k]) continue;
    used[k]++; sel.push(x);
    if (sel.length >= MAXMEM) break;
  }
  SC.mem = sel.map(x => {
    const ret = Number(x.retention) || 0;
    return {
      id: x.id, content: x.content, scope: x.scope, scopeIndex: x.scopeIndex == null ? 0 : x.scopeIndex,
      type: x.type, status: x.status, retention: ret, clarity: Number(x.clarity) || 0,
      importance: Number(x.importance) || 0, valence: Number(x.valence) || 0, arousal: Number(x.arousal) || 0,
      pinned: !!x.pinned, halfLife: x.halfLife, recallCount: x.recallCount, reviewCount: x.reviewCount,
      reactivateCount: x.reactivateCount, daysSince: x.daysSince, eventTime: x.eventTime,
      anchor: x.anchor, tags: x.tags,
      fade: fadeTarget(x.status, ret), target: fadeTarget(x.status, ret)
    };
  });
  SC.col = [hex3('#eaf6ff')];
  SC.mem.forEach(m => {
    const c = hex3(SCOPE_COLORS[m.scopeIndex % SCOPE_COLORS.length]);
    const t = m.fade * .8;                       // 越靠近黑洞越偏橙红
    SC.col.push([c[0] * (1 - t) + 1 * t, c[1] * (1 - t) + .36 * t, c[2] * (1 - t) + .10 * t]);
  });
  AG.forEach(a => { a.grps = []; });
  SC.mem.forEach((m, i) => {
    const a = AG[1 + Math.min(SCOPE_SLOTS - 1, Math.max(0, m.scopeIndex || 0))];
    if (a) a.grps.push(i + 1);
  });
  if (glOK) buildBrain();

  refreshRows();
  $('#ltMeta').textContent = ltMetaText();
  renderList(); renderBottom(); renderHeat(); renderSpark(); renderMem(); renderBot();
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
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawTape(); layout(); });
drawTape(); renderList(); renderFeed(); renderCap(); renderBottom(); renderHeat(); renderSpark(); renderMem(); renderBot(); bindBotName();
clockTick(); setInterval(clockTick, 1000);
syncButtons();
// 调试用：快进模拟若干秒（控制台里 document.getElementById('host-neural').__nr.ff(20)）
host.__nr = {ff(sec){ for (let t = 0; t < sec; t += .05) { simStep(.05); decay(.05); animT += .05; } needsT = 1; },
              setModel, model: MODEL, feed, tasks, stars: starPool, ag: AG,
              /* 给自动化探针用 */
              starScreen(){ return SC.mem.map((m, i) => { const g = i + 1, c = CL[g];
                              const ang = sceneT * (SC.osp[g] || 0) * (1 - m.fade), ca = Math.cos(ang), sa = Math.sin(ang);
                              const p = screenOf(new THREE.Vector3(c.x * ca - c.y * sa, c.x * sa + c.y * ca, c.z));
                              return {id: m.id, x: p[0], y: p[1], fade: m.fade, status: m.status, scope: m.scope}; }); },
              marks(){ if (!glOK) return null; const b = screenOf(CL[0]), h = screenOf(SC.holePos || CL[0]);
                       return {bot: {x: b[0], y: b[1]}, hole: {x: h[0], y: h[1]}, groups: SC.n, mems: SC.mem.length, absorbed: SC.absorbed,
                               holeWorld: [HOLE.x, HOLE.y, HOLE.z], cam: {yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom},
                                holeDbg: SC.holeUni ? {inScene: !!SC.hole.parent, vis: SC.hole.visible,
                                  ctr: [SC.holeUni.uCtr.value.x, SC.holeUni.uCtr.value.y], r: SC.holeUni.uR.value,
                                  half: SC.holeUni.uHalf.value, res: [SC.holeUni.uRes.value.x, SC.holeUni.uRes.value.y],
                                  alpha: SC.holeUni.uAlpha.value} : null}; },
              probe3d(){ if (!glOK) return null; const RW = 320, RH = 180, rt = new THREE.WebGLRenderTarget(RW, RH);
                        const old = renderer.getRenderTarget(); renderer.setRenderTarget(rt);
                        syncHole(RW, RH); renderer.render(scene, camera);
                        const buf = new Uint8Array(RW * RH * 4); renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, buf);
                        renderer.setRenderTarget(old); rt.dispose();
                        let orange = 0, cyan = 0, bright = 0, sum = 0;
                        for (let i = 0; i < RW * RH; i++) { const r = buf[i*4], g = buf[i*4+1], b = buf[i*4+2], L = r+g+b; sum += L;
                          if (L > 120) bright++; if (r > 90 && r > b * 1.5 && g > b) orange++; if (g > 80 && b > 80 && r < g * .85) cyan++; }
                        // 黑洞暗盘：视界内部应该几乎全黑
                        const [hx, hy] = screenOf(SC.holePos || CL[0]);
                        const cx = Math.round(hx * RW / Math.max(1, W)), cy = Math.round((1 - hy / Math.max(1, H)) * RH);
                        let discDark = 0, discTotal = 0, ringLum = 0, ringTotal = 0;
                        for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) {
                          if (x < 0 || y < 0 || x >= RW || y >= RH) continue;
                          const o = (y * RW + x) * 4, L = buf[o] + buf[o+1] + buf[o+2]; discTotal++; if (L < 12) discDark++;
                        }
                        for (let y = cy - 22; y <= cy - 12; y++) for (let x = cx - 22; x <= cx + 12; x++) {
                          if (x < 0 || y < 0 || x >= RW || y >= RH) continue;
                          const o = (y * RW + x) * 4; ringTotal++; ringLum += buf[o] + buf[o+1] + buf[o+2];
                        }
                        return {size: [RW, RH], nonBlackPx: bright, orangePx: orange, cyanPx: cyan, avgLum: Math.round(sum / (RW * RH)), mems: SC.mem.length,
                                holeDisc: {x: cx, y: cy, darkPx: discDark, totalPx: discTotal, ringLum: ringTotal ? Math.round(ringLum / ringTotal) : -1}}; }};
requestAnimationFrame(frame);
}