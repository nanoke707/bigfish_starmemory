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
const HOLE = {r: .052};                              // 视界半径：按视口短边比例画 → 与分辨率无关
const HOLE_ANCHOR = {x: .80, y: .74};                 // 视界的「家」在屏幕的哪个位置（0~1，左上为原点）：右下角，避开「配置」按钮
const HOLE_TWIST = 1.25;                              // 记忆星被吸入时的旋进角（弧度）：绕着视界转进去，走弧线不是直线
const HOLE_DEPTH = 1.15;                             // 视界在深度上离星团有多远（相对相机到星团的距离）
const HOLE_PARALLAX = .6;                             // 视差系数：镜头一动，视界跟着位移多少（1 = 完全跟随；调小是为了不让它飞出画面）
const AFG = 80;                                      // 着色器里 af[] 的组数上限
const LINK_SEG = 10;                                  // 关联连线每一段的细分
const SC = {n: 1, mem: [], col: [], pull: new Float32Array(AFG), bunBase: 2, held: -1, holdAng: 0, absorbed: 0, gone: [], suckMap: {}};
let GBG = 1;                                         // 背景灰质所在的组号
let HOLE_L = null;                                   // 视界在 spin 局部坐标里的位置（每帧按真实 3D 位置重算）
let HOLE_W = null;                                   // 视界在世界坐标里的位置（随镜头位移而位移）

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
let sceneT = 0;                                  // 轨道时钟：一直推进（只有被悬停的那颗星单独停住）
let camT = 0, spinZ = 0;                         // 镜头与整体自转时钟：悬停时停住
let camInit = false;                              // 镜头是否已经落在基准机位上

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
let trGeo, coreSpr, brainLines, brainPts, sigGeo, sigMat, streaks, dust;
let ringTex, tapeTex, ringCtx, tapeCtx;
const AF = new Float32Array(AFG * 2);                   // 每组 (活跃度, 聚焦系数)：0 恒星，1..M 记忆星，M+1 背景，之后是突触束
const focT = new Float32Array(AFG).fill(1);
for (let i = 0; i < AFG; i++) { AF[i * 2] = .1; AF[i * 2 + 1] = 1; }
const SEC_A = TAU / NCL;
const secAng = k => Math.PI / 2 - k * SEC_A;            // 扇区中心角：CHIEF 在正上方，顺时针排
const CL = [];
const BUN = [], BMAP = {};
const chanAng = CH.map((_, j) => Math.PI / 2 - (j + .5) * TAU / 6 - .12);
let chanPos = [], scans = [];
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
attribute vec3 gc; attribute float pull; attribute float osp; attribute float oph; attribute vec3 axs;
uniform vec2 af[80]; uniform float uMono; uniform float uFade; uniform float uGain; uniform vec3 uHole;
uniform float uOrbit; uniform float uHold; uniform float uHoldAng; uniform float uTwist;
varying vec3 vCol; varying float vA;
void main(){
  vec3 p = position;
  p = mix(p, gc, pull * .5);
  // 绕着恒星公转：每颗星有自己的轨道平面 axs，所以是三百六十度地绕；
  // 被悬停的那颗用冻结角 uHoldAng 钉住，其余照转；被吸得越狠转得越慢
  float ang = (abs(grp - uHold) < .5 && osp > 0.0) ? uHoldAng : (uOrbit * osp + oph) * (1.0 - pull);
  vec3 k = normalize(axs);
  float ca = cos(ang), sa = sin(ang);
  float kd = dot(k, p);
  vec3 kc = cross(k, p);
  p = p * ca + kc * sa + k * kd * (1.0 - ca);
  // 被视界卷走：绕着视界旋进的螺旋（半径一点点收紧）——走弧线不是直线，也不会一下子消失
  if (pull > 0.0) {
    vec3 rel = p - uHole;
    float ph = uTwist * pull;
    float cs = cos(ph), sn = sin(ph);
    vec3 rot = vec3(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs, rel.z);
    p = uHole + rot * (1.0 - pull);
  }
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
attribute vec3 gc; attribute float pull; attribute float osp; attribute float oph; attribute vec3 axs;
uniform vec2 af[80]; uniform float uMono; uniform float uTime; uniform float uPx; uniform float uFade; uniform float uGain;
uniform vec3 uHole; uniform float uHold; uniform float uHoldT; uniform float uOrbit; uniform float uHoldAng; uniform float uTwist;
varying vec3 vCol; varying float vA;
void main(){
  vec3 p = position;
  p = mix(p, gc, pull * .5);
  // 三维公转（每颗星自己的轨道平面）
  float ang = (abs(grp - uHold) < .5 && osp > 0.0) ? uHoldAng : (uOrbit * osp + oph) * (1.0 - pull);
  vec3 k = normalize(axs);
  float ca = cos(ang), sa = sin(ang);
  float kd = dot(k, p);
  vec3 kc = cross(k, p);
  p = p * ca + kc * sa + k * kd * (1.0 - ca);
  // 被视界卷走：绕着视界旋进的螺旋（半径一点点收紧）——走弧线不是直线，也不会一下子消失
  if (pull > 0.0) {
    vec3 rel = p - uHole;
    float ph = uTwist * pull;
    float cs = cos(ph), sn = sin(ph);
    vec3 rot = vec3(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs, rel.z);
    p = uHole + rot * (1.0 - pull);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 q = af[int(grp + 0.5)];
  float a = clamp(q.x, 0.0, 1.5);
  // 被悬停的那颗星：闪烁停住，钉在原地
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
  if (SC.links) { spin.remove(SC.links); SC.links.geometry.dispose(); SC.links.material.dispose(); SC.links = null; }
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
  SC.oph = new Float32Array(AFG);
  SC.oax = [];
  for (let c = 0; c < SC.n; c++) {
    SC.oph[c] = 0;
    // 每颗星有自己的轨道平面：倾角 10°~55°，方位随机 → 星星从四面八方绕着恒星转（三百六十度）
    const tilt = c === 0 ? 0 : (.18 + R() * .78), az = R() * TAU;
    SC.oax[c] = new V(Math.cos(az) * Math.sin(tilt), Math.sin(az) * Math.sin(tilt), Math.cos(tilt)).normalize();
  }
  for (let c = 1; c < SC.n; c++) {
    const C = CL[c], rr = Math.hypot(C.x, C.y);
    SC.osp[c] = .22 / (rr + .55);            // 差速自转：靠里转得快，靠外转得慢（整体不快）
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
  const seen = new Set(), LP = [], LC = [], LG = [], LS = [], LPG = [], LGC = [], LOSP = [], LAX = [], LOP = [];
  const axOf = g => { const a = (SC.oax && SC.oax[g]) || SC.oax[0]; return a ? [a.x, a.y, a.z] : [0, 0, 1]; };
  function seg(x1, y1, z1, x2, y2, z2, c1, c2, g, s, pg0, pg1, o0, o1){
    LP.push(x1, y1, z1, x2, y2, z2); LC.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
    LG.push(g, g); LS.push(s, s); LPG.push(pg0, pg1);
    LOSP.push(o0 || 0, o1 || 0);
    LAX.push(...axOf(pg0), ...axOf(pg1));
    LOP.push((SC.oph && SC.oph[pg0]) || 0, (SC.oph && SC.oph[pg1]) || 0);
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
      if (ng[i] === 0 || ng[j] === 0) continue;      // 恒星周围不连杂线
      if (seen.has(id)) continue; seen.add(id);
      const same = ng[i] === ng[j] && ng[i] < SC.n;
      seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), same ? ng[i] : GBG, same ? .55 : .32, ng[i], ng[j]);
      syn++;
    }
  }
  /* 远程细丝：稀疏一点，别糊成蜘蛛网 */
  for (let k = 0; k < 2400; k++) {
    const i = (R() * N) | 0, j = (R() * N) | 0;
    if (ng[i] === 0 || ng[j] === 0) continue;
    const d = Math.hypot(px[i] - px[j], py[i] - py[j], pz[i] - pz[j]);
    if (d < .22 || d > .6) continue;
    seg(px[i], py[i], pz[i], px[j], py[j], pz[j], ncol(i), ncol(j), GBG, .12, ng[i], ng[j]); syn++;
  }
  /* 用户要求：恒星周围不再有放射状的杂乱连线。
     记忆之间的关联改由「同星域成链 + 同标签补一笔」的连线表达（见 buildLinks）。 */
  SYN = syn;

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3));
  lg.setAttribute('col', new THREE.Float32BufferAttribute(LC, 3));
  lg.setAttribute('grp', new THREE.Float32BufferAttribute(LG, 1));
  lg.setAttribute('shade', new THREE.Float32BufferAttribute(LS, 1));
  lg.setAttribute('gc', new THREE.Float32BufferAttribute(LGC, 3));
  SC.lpg = LPG; SC.losp = LOSP;            // 连线端点：属于哪颗星 / 角速度
  lg.setAttribute('osp', new THREE.Float32BufferAttribute(LOSP, 1));
  lg.setAttribute('oph', new THREE.Float32BufferAttribute(LOP, 1));
  lg.setAttribute('axs', new THREE.Float32BufferAttribute(LAX, 3));
  SC.pullL = new Float32Array(LP.length / 3);
  lg.setAttribute('pull', new THREE.BufferAttribute(SC.pullL, 1).setUsage(THREE.DynamicDrawUsage));
  const uni = {af: {value: AF}, uMono: {value: 0}, uFade: {value: 8}, uTime: {value: 0}, uPx: {value: 800}, uGain: {value: 1},
               uHole: {value: HOLE_L || (HOLE_L = new THREE.Vector3())}, uHold: {value: -1}, uHoldT: {value: 0},
               uOrbit: {value: 0}, uHoldAng: {value: 0}, uTwist: {value: HOLE_TWIST},
               map: {value: SPRITE}};
  SC.uni = uni;
  SC.lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({uniforms: uni, vertexShader: BRAIN_VS_L, fragmentShader: BRAIN_FS_L, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
  spin.add(SC.lines);

  const pg = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), col = new Float32Array(N * 3), grp = new Float32Array(N), sz = new Float32Array(N), ph = new Float32Array(N), gcP = new Float32Array(N * 3), ospP = new Float32Array(N), ophP = new Float32Array(N), axsP = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i];
    const c = ncol(i); col.set(c, i * 3); grp[i] = ng[i]; sz[i] = ns[i]; ph[i] = R();
    const cc = CL[ng[i]] || CL[0]; gcP[i * 3] = cc.x; gcP[i * 3 + 1] = cc.y; gcP[i * 3 + 2] = cc.z;
    ospP[i] = SC.osp[ng[i]] || 0;
    ophP[i] = SC.oph[ng[i]] || 0;
    const ax = (SC.oax && SC.oax[ng[i]]) || SC.oax[0];
    axsP[i * 3] = ax.x; axsP[i * 3 + 1] = ax.y; axsP[i * 3 + 2] = ax.z;
  }
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('col', new THREE.BufferAttribute(col, 3));
  pg.setAttribute('grp', new THREE.BufferAttribute(grp, 1)); pg.setAttribute('sz', new THREE.BufferAttribute(sz, 1)); pg.setAttribute('ph', new THREE.BufferAttribute(ph, 1));
  pg.setAttribute('gc', new THREE.BufferAttribute(gcP, 3));
  pg.setAttribute('osp', new THREE.BufferAttribute(ospP, 1));
  pg.setAttribute('oph', new THREE.BufferAttribute(ophP, 1));
  pg.setAttribute('axs', new THREE.BufferAttribute(axsP, 3));
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

  /* 有关联的记忆之间连线：同星域串成链，共用标签的再补一笔 */
  buildLinks();

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
  applyPull();
}
/* 把每颗记忆星当前的吸入进度写进顶点属性（重建后必须复原，不然会跳回原位） */
function applyPull(){
  if (!SC.pullP || !SC.mem) return;
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1]; if (!m) continue;
    const v = clamp(m.suck || 0, 0, 1);
    SC.pull[g] = v;
    const mm = MEM[g] || [];
    for (const i of mm) SC.pullP[i] = v;
    const li = SC.pullIdxL[g] || [];
    for (const k of li) SC.pullL[k] = v;
  }
  if (SC.pts) SC.pts.geometry.attributes.pull.needsUpdate = true;
  if (SC.lines) SC.lines.geometry.attributes.pull.needsUpdate = true;
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
  // 吸积：物质沿对数螺旋一圈圈被卷进视界（越靠里转得越快）
  float lsp = ang * 2.0 - log(max(r, 0.05)) * 1.45 - uTime * 0.55;
  float sp1 = 0.5 + 0.5 * sin(lsp);
  float sp2 = 0.5 + 0.5 * sin(lsp * 2.0 + 1.7);
  float spiral = sp1 * 0.62 + sp2 * 0.38;
  float acc = band * (s1 * 0.42 + s2 * 0.26 + spiral * 0.44) * 0.11 * (0.6 + uEnergy);
  // 引力透镜：视界外一圈被弯折的光弧
  float lens = exp(-sq((r - 1.42) / 0.10)) * (0.35 + 0.9 * spiral) * 0.085 * (0.5 + uEnergy);
  float inf = exp(-sq((r - 2.15) / 1.05)) * spiral * 0.055 * (0.45 + uEnergy * 0.9);
  float ring = exp(-sq((r - 1.0) / 0.02)) * (0.45 + 0.95 * beam) * (0.85 + uEnergy * 0.6);
  float ring2 = exp(-sq((r - 1.05) / 0.07)) * 0.22 * (0.4 + beam);
  float halo = exp(-sq((r - 1.62) / 0.045)) * 0.05;
  float pr = 1.0 + uPulse * 3.6;
  float shock = uPulse > 0.0 ? exp(-sq((r - pr) / (0.05 + uPulse * 0.12))) * (1.0 - uPulse) * 0.55 : 0.0;
  vec3 col = tint * (glow * (0.6 + 0.6 * beam) + acc + lens + inf + ring + ring2 + halo + shock);
  float disc = 1.0 - smoothstep(0.985, 1.0, r);
  vec3 dcol = vec3(0.004, 0.005, 0.008) + tint * 0.014 * smoothstep(0.55, 1.0, r) * beam;
  gl_FragColor = vec4(col * (1.0 - disc) + dcol * disc, disc) * uAlpha;
}`;
/* ---------- 吸积：黑洞四周被一点点卷进去的物质（屏幕空间，和视界严丝合缝） ---------- */
const ACCP_VS = `
attribute float aSeed; attribute float aArm; attribute float aSpd; attribute float aR0;
attribute float aIn; attribute float aSz; attribute float aLay; attribute float aTip;
uniform vec2 uCtr; uniform vec2 uRes; uniform float uR; uniform float uTime;
uniform float uGain; uniform float uSpd; uniform float uHeat; uniform float uPS;
varying vec3 vCol; varying float vA;
void main(){
  float s = fract(aSeed + uTime * aIn);                  // 一生：0 从远处来 → 1 被视界吞掉
  float st = max(s - 0.055, 0.0);                        // 尾巴比头落后一点（拖在后面）
  float rH = mix(aR0, 1.02, pow(s, 1.3));                // 一路被吸向视界，越近掉得越快
  float rT = mix(aR0, 1.02, pow(st, 1.3));
  float k = 2.15;
  // 旋臂：角度由「自己的相位 + 所在半径」决定 → 一条条旋进气流的螺线；
  // 差速只作用在这一项里（否则时间一长旋臂就被绞成均匀的环），另加一点整体转动
  float aH = aArm + uTime * uSpd * 0.22 + s * uSpd * aSpd * (k / max(rH, 0.25)) * 0.7;
  float aT = aArm + uTime * uSpd * 0.22 + st * uSpd * aSpd * (k / max(rT, 0.25)) * 0.7;
  vec2 oH = vec2(cos(aH), sin(aH)) * rH * uR;
  vec2 oT = vec2(cos(aT), sin(aT)) * rT * uR;
  vec2 o = mix(oH, oT, aTip);
  vec2 p = uCtr + o;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  float fade = smoothstep(0.0, 0.07, s) * (1.0 - smoothstep(0.86, 1.0, s));
  float heat = 1.0 - clamp((rH - 1.0) / 2.6, 0.0, 1.0);
  vec3 cold = vec3(0.30, 0.56, 1.0);
  vec3 hot = vec3(1.0, 0.80, 0.52);
  vCol = mix(cold, hot, heat * heat);
  vA = fade * uGain * (0.22 + 0.78 * heat) * (1.0 - aTip * 0.70) * (0.40 + 0.60 * aLay);
  gl_PointSize = max(1.0, aSz * uPS * (0.55 + 0.65 * heat));
}`;
const ACCP_FS = `
uniform sampler2D map; varying vec3 vCol; varying float vA;
void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vCol, t.a * vA); }`;
const ACCL_FS = `
varying vec3 vCol; varying float vA;
void main(){ gl_FragColor = vec4(vCol, vA); }`;

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
/* 视界是屏幕空间的四边形：中心 = 它在 3D 里的位置投影到屏幕（随镜头位移而位移），半径随距离缩放 */
function syncHole(rw, rh){
  if (!SC.holeUni) return;
  const u = SC.holeUni;
  const nx = SC.holeNDC ? SC.holeNDC.x : (HOLE_ANCHOR.x * 2 - 1);
  const ny = SC.holeNDC ? SC.holeNDC.y : (1 - HOLE_ANCHOR.y * 2);
  const dRef = Math.max(1, fitD) * HOLE_DEPTH;
  const R = HOLE.r * Math.min(rw, rh) * (SC.holeDist ? dRef / SC.holeDist : 1);
  u.uRes.value.set(rw, rh);
  u.uCtr.value.set((nx * .5 + .5) * rw, (1 - (ny * .5 + .5)) * rh);
  u.uR.value = R;
  u.uHalf.value = R * 6;
  u.uTime.value = animT;
  u.uEnergy.value = clamp(.35 + SC.absorbed * .05 + boost * .35, 0, 1.4);
  u.uWarm.value = clamp(.22 + SC.absorbed * .04, 0, 1);
  u.uPulse.value = SC.holePulse || 0;
  if (SC.accUni) {
    SC.accUni.uGain.value = clamp(.62 + SC.absorbed * .03 + boost * .25, 0, 1.6);
    SC.accUni.uPS.value = clamp(rh / 900, .6, 2.2);
  }
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
  SC.holePos = new THREE.Vector3(0, 0, 0);      // 视界在世界坐标里的位置（每帧按屏幕锚点重算）
  SC.holePulse = 0;
}
/* 吸积：黑洞四周一点点被卷进去的物质（屏幕空间，和视界严丝合缝）
   —— 比视界先画（renderOrder < 900），否则会把视界暗盘糊掉 */
function buildAccretion(){
  if (!SC.holeUni) return;
  const N = 900;
  const mk = n => {
    const g = new THREE.BufferGeometry();
    return {g, pos: new Float32Array(n * 3), seed: new Float32Array(n), arm: new Float32Array(n), spd: new Float32Array(n),
            r0: new Float32Array(n), inr: new Float32Array(n), sz: new Float32Array(n), lay: new Float32Array(n), tip: new Float32Array(n)};
  };
  const fill = a => {
    a.g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
    a.g.setAttribute('aSeed', new THREE.BufferAttribute(a.seed, 1));
    a.g.setAttribute('aArm', new THREE.BufferAttribute(a.arm, 1));
    a.g.setAttribute('aSpd', new THREE.BufferAttribute(a.spd, 1));
    a.g.setAttribute('aR0', new THREE.BufferAttribute(a.r0, 1));
    a.g.setAttribute('aIn', new THREE.BufferAttribute(a.inr, 1));
    a.g.setAttribute('aSz', new THREE.BufferAttribute(a.sz, 1));
    a.g.setAttribute('aLay', new THREE.BufferAttribute(a.lay, 1));
    a.g.setAttribute('aTip', new THREE.BufferAttribute(a.tip, 1));
  };
  const pts = mk(N), lns = mk(N * 2);
  const ARMS = 4, ASTEP = TAU / ARMS;
  for (let i = 0; i < N; i++) {
    // 每颗物质都属于一条旋臂：同臂的角度几乎一致，臂内的相位不同 → 拉出一条条旋进的气流
    const arm = (i % ARMS) + (Math.random() - .5) * .22;
    const sd = Math.random(), am = arm * ASTEP, sp = .85 + Math.random() * .3,
          rr = 1.55 + Math.random() * 1.5, ii = .05 + Math.random() * .11,
          ss = .9 + Math.random() * 2.6, ly = Math.random();
    pts.seed[i] = sd; pts.arm[i] = am; pts.spd[i] = sp; pts.r0[i] = rr;
    pts.inr[i] = ii; pts.sz[i] = ss; pts.lay[i] = ly; pts.tip[i] = 0;
    // 拖尾：同一颗粒子的头（aTip=0）和尾（aTip=1），拉出一条甩在后面的流线
    const j = i * 2;
    lns.seed[j] = sd; lns.arm[j] = am; lns.spd[j] = sp; lns.r0[j] = rr;
    lns.inr[j] = ii; lns.sz[j] = ss; lns.lay[j] = ly; lns.tip[j] = 0;
    lns.seed[j + 1] = sd; lns.arm[j + 1] = am; lns.spd[j + 1] = sp; lns.r0[j + 1] = rr;
    lns.inr[j + 1] = ii; lns.sz[j + 1] = ss; lns.lay[j + 1] = ly; lns.tip[j + 1] = 1;
  }
  fill(pts); fill(lns);
  // 视界的 uCtr/uRes/uR 直接共用 → 吸积盘永远严丝合缝地贴着视界
  SC.accUni = {uCtr: SC.holeUni.uCtr, uRes: SC.holeUni.uRes, uR: SC.holeUni.uR, uTime: SC.holeUni.uTime,
               uGain: {value: .7}, uSpd: {value: .95}, uHeat: {value: .3}, uPS: {value: 1}};
  const pm = new THREE.ShaderMaterial({uniforms: Object.assign({map: {value: SPRITE}}, SC.accUni),
    vertexShader: ACCP_VS, fragmentShader: ACCP_FS, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending});
  SC.accPts = new THREE.Points(pts.g, pm);
  SC.accPts.frustumCulled = false; SC.accPts.renderOrder = 850; scene.add(SC.accPts);
  const lm = new THREE.ShaderMaterial({uniforms: SC.accUni, vertexShader: ACCP_VS, fragmentShader: ACCL_FS,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending});
  SC.accLine = new THREE.LineSegments(lns.g, lm);
  SC.accLine.frustumCulled = false; SC.accLine.renderOrder = 840; scene.add(SC.accLine);
}
/* 视界不再是一张钉在屏幕上的贴纸，而是一个真的 3D 物体 —— 镜头一动，它跟着位移：
     ① 用「不含用户 yaw/pitch 的基准机位」摆一个世界点 P0（自动环绕带着它走，它稳在角落）；
     ② 用真实镜头把 P0 投影出来，和屏幕锚点按视差系数混合 → 得到它此刻的屏幕位置；
     ③ 再反投影回 3D（保持同样的距离）→ 视界的真实世界位置，记忆星就是卷向这里。
   这样「黑洞随镜头位移而位移」，同时视界、吸积盘、记忆星的螺旋三者永远对齐。 */
const _hb = {pos: null, tgt: null, f: null, r: null, u: null, dir: null};
let _hv3 = null;
function syncHoleWorld(){
  if (!glOK) return;
  if (!_hv3) _hv3 = new THREE.Vector3();
  if (!HOLE_W) HOLE_W = new THREE.Vector3();
  if (!HOLE_L) HOLE_L = new THREE.Vector3();
  if (!_hb.pos) { _hb.pos = new THREE.Vector3(); _hb.tgt = new THREE.Vector3(); _hb.f = new THREE.Vector3();
                  _hb.r = new THREE.Vector3(); _hb.u = new THREE.Vector3(); _hb.dir = new THREE.Vector3(); }
  const b = camBase(camT);
  const az = b.az, el = b.el;
  _hb.pos.set(b.r * Math.sin(az) * Math.cos(el) + b.tx, b.r * Math.sin(el) + b.ty, b.r * Math.cos(az) * Math.cos(el));
  _hb.tgt.set(b.tx, b.ty, 0);
  // 基准机位下、屏幕锚点那条视线上的世界点 P0
  const t = Math.tan(camera.fov * Math.PI / 360);
  _hb.f.copy(_hb.tgt).sub(_hb.pos).normalize();
  _hb.r.set(-_hb.f.z, 0, _hb.f.x).normalize();          // cross(forward, up) → 画面右向
  _hb.u.crossVectors(_hb.r, _hb.f);
  const nx = HOLE_ANCHOR.x * 2 - 1, ny = 1 - HOLE_ANCHOR.y * 2;
  _hb.dir.copy(_hb.f).addScaledVector(_hb.r, nx * t * camera.aspect).addScaledVector(_hb.u, ny * t).normalize();
  _hb.dir.multiplyScalar(Math.max(1, fitD) * HOLE_DEPTH).add(_hb.pos);
  // 真实镜头投影 P0 → 与锚点按视差系数混合
  camera.updateMatrixWorld();
  const dist = _hb.dir.distanceTo(camera.position);
  _hb.dir.project(camera);
  if (!SC.holeProj) SC.holeProj = {x: 0, y: 0, z: 0};
  SC.holeProj.x = _hb.dir.x; SC.holeProj.y = _hb.dir.y; SC.holeProj.z = _hb.dir.z;
  const mx = nx + (_hb.dir.x - nx) * HOLE_PARALLAX;
  const my = ny + (_hb.dir.y - ny) * HOLE_PARALLAX;
  if (!SC.holeNDC) SC.holeNDC = {x: nx, y: ny};
  SC.holeNDC.x = mx; SC.holeNDC.y = my;
  SC.holeDist = dist;
  // 反投影回 3D（同样的距离）→ 视界的世界位置
  _hv3.set(mx, my, .5).unproject(camera);
  _hv3.sub(camera.position).normalize().multiplyScalar(dist).add(camera.position);
  HOLE_W.copy(_hv3);
  if (SC.holePos) SC.holePos.copy(HOLE_W);
  // 世界 → spin 局部（spin 只绕 z 轴转 θ）
  const th = spinZ * .035, cs = Math.cos(th), sn = Math.sin(th);
  HOLE_L.set(HOLE_W.x * cs + HOLE_W.y * sn, -HOLE_W.x * sn + HOLE_W.y * cs, HOLE_W.z);
}

const RW = 4096, RH = 112, TW = 4096, TH = 32;
const uOf = th => { let u = 1 - th / TAU; return ((u % 1) + 1) % 1; };

function buildHud(){
  hud = new THREE.Group(); world.add(hud);
  /* 用户要求：星团外围那一整圈会转的圆环（条码环 / 扫描弧 / 文字带 / 虚线轨 / 刻度 / 弧线）整体删掉，
     画面只留中心恒星的辉光和纯 3D 星场。 */
  coreSpr = new THREE.Sprite(new THREE.SpriteMaterial({map: SPRITE, color: 0xcfe0ff, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false}));
  coreSpr.scale.setScalar(2.5); world.add(coreSpr);
  // 巡检扫描圈：套在被扫到的那颗星上（不是外围圆环）
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
  buildAccretion();
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
    // 没有突触束：脉冲从恒星直接飞向那颗记忆星（用实时位置，星星在公转也追得上）
    signals.push({kind, path: (u, o) => {
      const A = starPos(a, _l1), B = starPos(b, _l2);
      o.set(A.x + (B.x - A.x) * u, A.y + (B.y - A.y) * u, A.z + (B.z - A.z) * u);
    }, u: 0, dur: 1.2, col, cb, tr: 9, gap: .022, head: .085, bun: -1, to: b});
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
  // 通道环已经删掉：射线改成从那颗星自己向外射出去
  const p = starPos(ai, _l1), A = new THREE.Vector3(p.x, p.y, p.z), F = A.clone().multiplyScalar(2.3);
  signals.push({kind: 'ray', path: (u, o) => { o.lerpVectors(A, F, u); },
    u: 0, dur: 1.9, col: hex3(CH[ch].col), cb: null, tr: 14, gap: .018, head: .1, bun: -1, to: -1, mid: .5, onMid: () => { chanFlash[ch] = 1; }});
  meteorBurst(ai, ch);
}
function scanAt(k){
  if (!glOK) return;
  const s = scans.find(q => q.t > 1.2) || scans[0];
  s.t = 0; s.m.visible = true;
  const q = starPos(k, _sp); s.m.position.set(q.x, q.y, q.z);
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
  // 突触束已删：改成沿着「有关联的记忆」之间的连线跑
  if (!BUN.length) return;
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
  // 外围圆环已删：命中只留下一次轻微的闪光记账
  const s0 = ((Math.round(th / (TAU / NSEG)) % NSEG) + NSEG) % NSEG;
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

/* ---------- 记忆之间的关联连线 ---------- */
function buildLinks(){
  SC.linkPairs = [];
  const byScope = new Map();
  SC.mem.forEach((m, i) => {
    const k = m.scope || ('#' + i);
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(i + 1);
  });
  byScope.forEach(list => {
    list.sort((a, b) => (SC.mem[a - 1].scopeIndex || 0) - (SC.mem[b - 1].scopeIndex || 0));
    for (let i = 0; i + 1 < list.length; i++) SC.linkPairs.push([list[i], list[i + 1]]);
  });
  const tagMap = new Map();
  SC.mem.forEach((m, i) => {
    (m.tags || []).forEach(t => {
      const k = String(t);
      if (!tagMap.has(k)) tagMap.set(k, []);
      tagMap.get(k).push(i + 1);
    });
  });
  let extra = 0;
  tagMap.forEach(list => {
    if (list.length < 2 || list.length > 6) return;
    for (let i = 0; i + 1 < list.length && extra < 10; i++) { SC.linkPairs.push([list[i], list[i + 1]]); extra++; }
  });
  const n = SC.linkPairs.length * LINK_SEG * 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  SC.links = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false}));
  spin.add(SC.links);
}
/* 某颗记忆星此刻在 spin 局部坐标里的位置（与着色器公式逐字一致：先公转，再绕着视界旋进去） */
const _sp = {x: 0, y: 0, z: 0}, _l1 = {x: 0, y: 0, z: 0}, _l2 = {x: 0, y: 0, z: 0};
function starPos(g, o){
  const c = CL[g] || CL[0];
  const m = g > 0 ? SC.mem[g - 1] : null;
  const pull = m ? clamp(m.suck, 0, 1) : 0;
  let x = c.x, y = c.y, z = c.z;
  const ax = SC.oax && SC.oax[g];
  if (ax) {
    const osp = SC.osp[g] || 0, oph = SC.oph ? (SC.oph[g] || 0) : 0;
    const ang = (g === SC.held && osp > 0) ? SC.holdAng : (sceneT * osp + oph) * (1 - pull);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const kd = ax.x * x + ax.y * y + ax.z * z;
    const cx = ax.y * z - ax.z * y, cy = ax.z * x - ax.x * z, cz = ax.x * y - ax.y * x;
    const nx = x * ca + cx * sa + ax.x * kd * (1 - ca);
    const ny = y * ca + cy * sa + ax.y * kd * (1 - ca);
    const nz = z * ca + cz * sa + ax.z * kd * (1 - ca);
    x = nx; y = ny; z = nz;
  }
  // 被视界卷走：绕着视界旋进的螺旋（和着色器里的写法一字不差）
  if (pull > 0 && HOLE_L) {
    const rx = x - HOLE_L.x, ry = y - HOLE_L.y, rz = z - HOLE_L.z;
    const ph = HOLE_TWIST * pull, cs = Math.cos(ph), sn = Math.sin(ph);
    const ox = rx * cs - ry * sn, oy = rx * sn + ry * cs;
    x = HOLE_L.x + ox * (1 - pull); y = HOLE_L.y + oy * (1 - pull); z = HOLE_L.z + rz * (1 - pull);
  }
  o.x = x; o.y = y; o.z = z;
  return o;
}
/* 放开悬停：把这颗星的轨道相位重新对齐，让它从「钉住的地方」接着转，不跳位 */
function reanchorPhase(g){
  if (!(g > 0) || g >= SC.n || !SC.oph) return;
  const sp = SC.osp[g] || 0, m = SC.mem[g - 1];
  const pull = m ? clamp(m.suck, 0, 1) : 0, k = 1 - pull;
  const base = k > 1e-3 ? SC.holdAng / k : SC.holdAng;
  const ph = base - sceneT * sp;
  SC.oph[g] = ph;
  // 点云：这颗星自己的核心与光晕
  const pa = SC.pts && SC.pts.geometry.attributes.oph;
  if (pa && MEM && MEM[g]) {
    const arr = pa.array;
    for (const i of MEM[g]) if (i < arr.length) arr[i] = ph;
    pa.needsUpdate = true;
  }
  // 连线：端点属于这颗星、且确实在公转的，一起换相位
  const la = SC.lines && SC.lines.geometry.attributes.oph;
  if (la && SC.lpg && SC.losp) {
    const arr = la.array;
    for (let i = 0; i < arr.length; i++) if (SC.lpg[i] === g && SC.losp[i] > 0) arr[i] = ph;
    la.needsUpdate = true;
  }
}
function updateLinks(){
  if (!SC.links || !SC.linkPairs) return;
  const pos = SC.links.geometry.attributes.position.array;
  const col = SC.links.geometry.attributes.color.array;
  let o = 0, co = 0;
  for (const pr of SC.linkPairs) {
    const a = starPos(pr[0], _l1), b = starPos(pr[1], _l2);
    const c1 = SC.col[pr[0]] || [1, 1, 1], c2 = SC.col[pr[1]] || [1, 1, 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
    const ml = Math.hypot(mx, my) || .001;
    const cx = mx + mx / ml * .07, cy = my + my / ml * .07, cz = mz + .02;
    let lx = a.x, ly = a.y, lz = a.z;
    for (let k = 1; k <= LINK_SEG; k++) {
      const u = k / LINK_SEG, v = 1 - u;
      const x = v * v * a.x + 2 * v * u * cx + u * u * b.x;
      const y = v * v * a.y + 2 * v * u * cy + u * u * b.y;
      const z = v * v * a.z + 2 * v * u * cz + u * u * b.z;
      const t0 = (k - 1) / LINK_SEG;
      pos[o++] = lx; pos[o++] = ly; pos[o++] = lz;
      col[co++] = (c1[0] + (c2[0] - c1[0]) * t0) * .55; col[co++] = (c1[1] + (c2[1] - c1[1]) * t0) * .55; col[co++] = (c1[2] + (c2[2] - c1[2]) * t0) * .55;
      pos[o++] = x; pos[o++] = y; pos[o++] = z;
      col[co++] = (c1[0] + (c2[0] - c1[0]) * u) * .55; col[co++] = (c1[1] + (c2[1] - c1[1]) * u) * .55; col[co++] = (c1[2] + (c2[2] - c1[2]) * u) * .55;
      lx = x; ly = y; lz = z;
    }
  }
  SC.links.geometry.attributes.position.needsUpdate = true;
  SC.links.geometry.attributes.color.needsUpdate = true;
}

/* ---------- 镜头 ---------- */
const MODES = [{id: 'orbit', zh: '环绕'}, {id: 'front', zh: '正视'}, {id: 'tilt', zh: '斜看'}, {id: 'close', zh: '贴近'}];
let modeI = 0;
const cam = glOK ? {pos: new THREE.Vector3(0, .4, 14), tgt: new THREE.Vector3(), want: new THREE.Vector3(), wantT: new THREE.Vector3(), yaw: 0, pitch: 0, zoom: 1, userT: 0} : null;
let fitD = 10, W = 1, H = 1, narrow = false, bs = .5, sizeGain = 1;
/* 基准机位（不含用户拖出来的 yaw/pitch）：自动环绕用它，视界的「家」也用它 */
function camBase(t){
  const D = fitD * cam.zoom;
  let az = 0, el = 0, r = D, tx = 0, ty = 0;
  switch (MODES[modeI].id) {
    case 'orbit': az = .42 * Math.sin(t * .07); el = .2 + .12 * Math.sin(t * .051); break;
    case 'front': az = .03 * Math.sin(t * .13); el = .025 * Math.cos(t * .11); break;
    case 'tilt':  az = .8 + .06 * Math.sin(t * .09); el = .28 + .05 * Math.sin(t * .07); r = D; tx = -.15; ty = .14; break;
    case 'close': az = 1.02 + .12 * Math.sin(t * .05); el = -.16 + .07 * Math.sin(t * .07); r = D * .45; tx = 1.1; ty = .35; break;
  }
  return {az, el, r, tx, ty};
}
function camWant(t){
  const b = camBase(t);
  const az = b.az + cam.yaw, el = clamp(b.el + cam.pitch, -1.25, 1.25);
  cam.want.set(b.r * Math.sin(az) * Math.cos(el) + b.tx, b.r * Math.sin(el) + b.ty, b.r * Math.cos(az) * Math.cos(el));
  cam.wantT.set(b.tx, b.ty, 0);
}

/* ================= 4. DOM（干净版：只剩悬停浮层和配置按钮） ================= */
const nr = $('#nr');
SC.ovl = $('#ovl');
const tip = $('#tip');


/* ================= 5. 主循环 ================= */
let fps = 60, fpsN = 0, fpsT = 0, lowT = 0, autoNote = '';
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
  // 引力：变暗/归档的记忆开始被视界卷走 —— 慢速推进，全程看得见它绕着视界转进去
  let pullDirty = false;
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1]; if (!m) continue;
    if (m.status === 'faded' || m.status === 'archived') {
      m.target = Math.min(1, m.target + dt * (m.status === 'archived' ? .006 : .008));
      m.fade += (m.target - m.fade) * Math.min(1, dt * .35);
      m.suck = Math.min(1, (m.suck || 0) + dt * (m.status === 'archived' ? 1 / 46 : 1 / 68));
      SC.suckMap[m.id] = m.suck;
    }
    if (m.suck >= .999) {
      m.dead = true; SC.absorbed++; SC.gone[m.id] = 1; SC.holePulse = 1;
      log(0, '消散', `#${m.id} ${starLabel(m)} → 黑洞`, 'bad');
      SC.mem.splice(g - 1, 1); SC.col.splice(g, 1);
      buildBrain(); pullDirty = true; g--;
      continue;
    }
    if (Math.abs(m.suck - (SC.pull[g] || 0)) > .002) {
      SC.pull[g] = m.suck; pullDirty = true;
      const mm = MEM[g] || [];
      for (const i of mm) SC.pullP[i] = m.suck;
      const li = SC.pullIdxL[g] || [];
      for (const v of li) SC.pullL[v] = m.suck;
    }
  }
  if (pullDirty && SC.pts && SC.lines) { SC.pts.geometry.attributes.pull.needsUpdate = true; SC.lines.geometry.attributes.pull.needsUpdate = true; }
  const u = (SC.lines || brainLines).material.uniforms;
  u.uMono.value = mono; u.uTime.value = animT; u.uFade.value = camera.position.length() - 1.7;
  u.uGain.value += ((bloomOn && composer ? .62 : 1) * sizeGain - u.uGain.value) * (1 - Math.exp(-dt * 4));   // 开辉光时线条收一点，避免中心糊成一团
  // 探针拖尾
  probe.trail.unshift(probe.p.clone()); if (probe.trail.length > 16) probe.trail.pop();
  writeSignals();
  // 整体自转（悬停时停住，见 frame）
  spin.rotation.z = spinZ * .035;                      // 约 3 分钟转一圈
  const SA = TAU / NSEG;
  for (let s = 0; s < NSEG; s++) segFlash[s] *= Math.exp(-dt * 3.2);
  if (coreSpr) coreSpr.material.opacity = .1 + AF[0] * .14 + boost * .05;
  scans.forEach(s => { if (!s.m.visible) return; s.t += dt; const k = s.t / 1.2; if (k >= 1) { s.m.visible = false; return; } s.m.scale.setScalar(.07 + .38 * k); s.m.material.opacity = (1 - k) * .9; s.m.lookAt(camera.position); });
  streaks.material.uniforms.uTime.value = animT; streaks.material.uniforms.uBoost.value = boost;
  dust.rotation.y = animT * .004; dust.rotation.x = animT * .002;
  // 轨道时钟 + 每颗记忆星的位置 / 亮度
  if (SC.uni) SC.uni.uOrbit.value = sceneT;
  // 视界的世界位置（随镜头位移而位移）→ 记忆星卷向这里
  syncHoleWorld();
  for (let g = 1; g < SC.n; g++) {
    const m = SC.mem[g - 1], spr = SC.memSpr && SC.memSpr[g - 1];
    if (!m || !spr) continue;
    const p = starPos(g, _sp);
    spr.position.set(p.x, p.y, p.z);
    const br = clamp(AF[g * 2], 0, 1.2);
    const col = SC.col[g] || [1, 1, 1];
    spr.material.color.setRGB(col[0], col[1], col[2]);
    spr.material.opacity = clamp((1 - m.fade * .5 - (m.suck || 0) * .5) * (.25 + br * .9), 0, 1);
    spr.scale.setScalar((.052 + (m.importance || 0) * .045) * (.8 + br * .55) * (1 + (m.suck || 0) * .6));
  }
  updateLinks();
  // 黑洞：事件视界（移植「视界熔炉」）
  SC.holePulse = Math.max(0, (SC.holePulse || 0) - dt * .55);
  syncHole(W * pr, H * pr);
  // 浮层：恒星的名字和黑洞的位置跟着 3D 走
  if (SC.ovl) {
    const [bx, by] = screenOf(CL[0]);
    const nx = SC.holeNDC ? SC.holeNDC.x : (HOLE_ANCHOR.x * 2 - 1);
    const ny = SC.holeNDC ? SC.holeNDC.y : (1 - HOLE_ANCHOR.y * 2);
    SC.ovl.style.setProperty('--bx', bx.toFixed(1) + 'px');
    SC.ovl.style.setProperty('--by', by.toFixed(1) + 'px');
    SC.ovl.style.setProperty('--hx', ((nx * .5 + .5) * W).toFixed(1) + 'px');
    SC.ovl.style.setProperty('--hy', ((1 - (ny * .5 + .5)) * H).toFixed(1) + 'px');
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
    const prev = SC.held;
    SC.held = heldNow;
    if (prev >= 0 && prev < SC.n) reanchorPhase(prev);   // 放开：从钉住的地方接着转，不跳位
    if (heldNow >= 0 && heldNow < SC.n) {
      // 把被悬停这颗星此刻的轨道角记下来：它就此钉住，其余星星照常绕恒星转
      const m = SC.mem[heldNow - 1];
      SC.holdAng = (sceneT * (SC.osp[heldNow] || 0) + (SC.oph ? SC.oph[heldNow] : 0)) * (1 - (m ? clamp(m.suck || 0, 0, 1) : 0));
      if (SC.uni) SC.uni.uHoldAng.value = SC.holdAng;
    }
    if (SC.uni) { SC.uni.uHold.value = heldNow; SC.uni.uHoldT.value = animT; }
  }
  if (!paused) { simStep(dt); decay(dt); animT += dt; }
  sceneT += dt;                                           // 轨道时钟一直走：只有被悬停的那颗星停住
  if (heldNow < 0) { camT += dt; spinZ += dt; }           // 悬停时镜头与整体自转停住
  uiAcc += dt;
  if (!glOK) return;
  if (cam.userT > 0) cam.userT -= dt; else { cam.yaw *= Math.exp(-dt * .7); cam.pitch *= Math.exp(-dt * .7); }
  camWant(camT);
  if (!camInit) { cam.pos.copy(cam.want); cam.tgt.copy(cam.wantT); camInit = true; }   // 开场直接落在基准机位（别让视界从画外滑进来）
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
  if (nr) nr.classList.toggle('narrow', narrow);
  if (!glOK) return;
  renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
  if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); }
  camera.aspect = W / H;
  // 整屏星场：取景半径 = 记忆星团 + 远处那颗黑洞
  const t = Math.tan(camera.fov * Math.PI / 360), Rr = 2.15;
  fitD = Rr * H / (Math.min(H, W * .95) * t);
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  if (SC.lines) SC.lines.material.uniforms.uPx.value = H * pr / (2 * t);
  sizeGain = clamp(Rr * H / (fitD * t) / 900, .32, 1);
  needsT = .6;
}

/* ---------- 交互 ---------- */
const v3 = glOK ? new THREE.Vector3() : null;
function screenOf(p){ v3.copy(p).applyMatrix4(spin.matrixWorld).project(camera); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H]; }
/* 一颗星在屏幕上的「亮核」半径（像素）：只认最亮的那一小团，
   光晕的外圈不算命中 —— 否则鼠标离着半格远也会亮起来 */
function starScreenRadius(i){
  if (i <= 0) return 22;                                   // 恒星的核心那团亮光
  const m = SC.mem[i - 1]; if (!m) return 8;
  const br = clamp(AF[2 * i] || 0, 0, 1.2);
  const sc = (0.052 + (m.importance || 0) * 0.045) * (0.8 + br * 0.55) * (1 + (m.suck || 0) * 0.6);
  const t = Math.tan(camera.fov * Math.PI / 360);
  const px = H / (2 * t * Math.max(.01, fitD));             // 每个世界单位多少像素
  return clamp(sc * px * 0.30, 6, 15);
}
function pickAt(x, y, keep){
  if (!glOK) return -1;
  let hit = -1, hitD = 1e9, near = -1, nd = 8 * 8;
  for (let i = 0; i < SC.n; i++) {
    const p = starPos(i, _sp), s = screenOf(p);
    const d = Math.hypot(s[0] - x, s[1] - y), r = starScreenRadius(i);
    if (i === keep && d <= r * 1.15) return i;               // 已经悬停的那颗：只留两三个像素的余量
    if (d <= r && d < hitD) { hitD = d; hit = i; }           // 指针落在亮核上
    if (d < nd) { nd = d; near = i; }                       // 差一点点时的兜底
  }
  return hit >= 0 ? hit : near;
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
  const [sx, sy] = screenOf(starPos(i, _sp));
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const rr = starScreenRadius(i);
  let x = sx + rr + 12, y = sy - th / 2;
  if (x + tw > W - 12) x = sx - rr - tw - 12;
  tip.style.left = clamp(x, 8, W - tw - 8) + 'px'; tip.style.top = clamp(y, 8, H - th - 8) + 'px';
}
let drag = null;
const mouse = {x: -1, y: -1};
cv.addEventListener('pointerdown', e => { drag = {x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false}; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  const r = host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) { drag.moved = true; cv.classList.add('drag'); }
    if (drag.moved && glOK) { cam.yaw -= dx * .005; cam.pitch += dy * .004; cam.userT = 6; needsT = .5; tip.hidden = true; hover = -1; }
    return;
  }
  mouse.x = x; mouse.y = y;
  const i = pickAt(x, y, hover);
  hover = i; cv.classList.toggle('hov', i >= 0);
  if (i >= 0) showTip(i); else tip.hidden = true;
});
cv.addEventListener('pointerleave', () => { mouse.x = -1; mouse.y = -1; });
cv.addEventListener('pointerup', e => {
  const wasDrag = drag && drag.moved; drag = null; cv.classList.remove('drag');
  if (wasDrag) return;
  const r = host.getBoundingClientRect(), i = pickAt(e.clientX - r.left, e.clientY - r.top);
  mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
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
      fade: fadeTarget(x.status, ret), target: fadeTarget(x.status, ret),
      suck: clamp(Number(SC.suckMap[x.id]) || 0, 0, 1)      // 吸入进度：跨刷新保留，别让被卷走的星跳回原位
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
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); });
syncButtons();
// 调试用：快进模拟若干秒（控制台里 document.getElementById('host-neural').__nr.ff(20)）
host.__nr = {ff(sec){ for (let t = 0; t < sec; t += .05) { simStep(.05); decay(.05); animT += .05; } needsT = 1; },
              /* 只推进「被视界卷走」的进度，不动别的（给自动化探针用） */
              pull(sec){ for (let t = 0; t < sec; t += .05) {
                           for (let g = 1; g < SC.n; g++) { const m = SC.mem[g - 1]; if (!m) continue;
                             if (m.status !== 'faded' && m.status !== 'archived') continue;
                             m.target = Math.min(1, m.target + .05 * (m.status === 'archived' ? .006 : .008));
                             m.fade += (m.target - m.fade) * Math.min(1, .05 * .35);
                             m.suck = Math.min(1, (m.suck || 0) + .05 * (m.status === 'archived' ? 1 / 46 : 1 / 68));
                             SC.suckMap[m.id] = m.suck; } }
                         applyPull(); needsT = 1; },
              /* 把镜头推到基准机位（自动化探针用：无头环境帧率低，等不到它自己收敛） */
              cam(sec){ for (let t = 0; t < (sec || 3); t += .05) { camT += .05; spinZ += .05; camWant(camT);
                           const k = 1 - Math.exp(-.05 * 1.5); cam.pos.lerp(cam.want, k); cam.tgt.lerp(cam.wantT, k); }
                         camera.position.copy(cam.pos); camera.lookAt(cam.tgt); camera.updateMatrixWorld();
                         syncHoleWorld(); syncHole(W * pr, H * pr); needsT = 1; },
              /* 把镜头偏一个角度（自动化探针/截图用）：视界会跟着位移 */
              yaw(v){ cam.yaw = v || 0; cam.pitch = 0; cam.userT = 9999; camWant(camT);
                      cam.pos.copy(cam.want); cam.tgt.copy(cam.wantT);
                      camera.position.copy(cam.pos); camera.lookAt(cam.tgt); camera.updateMatrixWorld();
                      syncHoleWorld(); syncHole(W * pr, H * pr); needsT = 1; },
              /* 吸积盘的现状（给自动化探针用） */
              acc(){ if (!SC.accUni) return {has: false};
                     return {has: true, pts: SC.accPts ? SC.accPts.geometry.attributes.aSeed.count : 0,
                             segs: SC.accLine ? SC.accLine.geometry.attributes.aSeed.count : 0,
                             ctr: [SC.accUni.uCtr.value.x, SC.accUni.uCtr.value.y], r: SC.accUni.uR.value,
                             gain: SC.accUni.uGain.value, order: SC.accPts ? SC.accPts.renderOrder : -1,
                             holeOrder: SC.hole ? SC.hole.renderOrder : -1, inScene: !!SC.accPts && !!SC.accPts.parent,
                             ndc: SC.holeNDC ? [SC.holeNDC.x, SC.holeNDC.y] : null,
                             proj: SC.holeProj ? [SC.holeProj.x, SC.holeProj.y] : null,
                             dist: SC.holeDist,
                             camPos: [camera.position.x, camera.position.y, camera.position.z],
                             world: HOLE_W ? [HOLE_W.x, HOLE_W.y, HOLE_W.z] : null}; },
              setModel, model: MODEL, feed, tasks, stars: starPool, ag: AG,
              /* 给自动化探针用 */
              starScreen(){ return SC.mem.map((m, i) => { const g = i + 1, q = starPos(g, _sp);
                              const p = screenOf(new THREE.Vector3(q.x, q.y, q.z));
                              return {id: m.id, x: p[0], y: p[1], fade: m.fade, suck: m.suck || 0, status: m.status, scope: m.scope}; }); },
              pickAt(x, y){ return pickAt(x, y, hover); },
              hoverState(){ return {hover: hover, held: SC.held, holdAng: SC.holdAng, sceneT: sceneT, n: SC.n,
                                    oph1: SC.oph ? SC.oph[1] : null, osp1: SC.osp ? SC.osp[1] : null,
                                    spinZ: spinZ, camT: camT, camPos: [cam.pos.x, cam.pos.y, cam.pos.z],
                                    camWant: [cam.want.x, cam.want.y, cam.want.z], fitD: fitD,
                                    fade1: SC.mem[0] ? SC.mem[0].fade : null, suck1: SC.mem[0] ? (SC.mem[0].suck || 0) : null}; },
              marks(){ if (!glOK) return null; const b = screenOf(CL[0]);
                       const nx = SC.holeNDC ? SC.holeNDC.x : (HOLE_ANCHOR.x * 2 - 1);
                       const ny = SC.holeNDC ? SC.holeNDC.y : (1 - HOLE_ANCHOR.y * 2);
                       const hx = (nx * .5 + .5) * W, hy = (1 - (ny * .5 + .5)) * H;
                       return {bot: {x: b[0], y: b[1]}, hole: {x: hx, y: hy}, groups: SC.n, mems: SC.mem.length, absorbed: SC.absorbed,
                               holeWorld: SC.holePos ? [SC.holePos.x, SC.holePos.y, SC.holePos.z] : [0, 0, 0], cam: {yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom},
                                holeDbg: SC.holeUni ? {inScene: !!SC.hole.parent, vis: SC.hole.visible,
                                  ctr: [SC.holeUni.uCtr.value.x, SC.holeUni.uCtr.value.y], r: SC.holeUni.uR.value,
                                  half: SC.holeUni.uHalf.value, res: [SC.holeUni.uRes.value.x, SC.holeUni.uRes.value.y],
                                  alpha: SC.holeUni.uAlpha.value} : null,
                                links: SC.linkPairs ? SC.linkPairs.length : 0,
                                linkGroups: SC.linkPairs ? SC.linkPairs.map(q => q[0] + '-' + q[1]).slice(0, 10) : []};},
              probe3d(){ if (!glOK) return null; const RW = 320, RH = 180, rt = new THREE.WebGLRenderTarget(RW, RH);
                        const old = renderer.getRenderTarget(); renderer.setRenderTarget(rt);
                        syncHole(RW, RH); renderer.render(scene, camera);
                        const buf = new Uint8Array(RW * RH * 4); renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, buf);
                        renderer.setRenderTarget(old); rt.dispose();
                        let orange = 0, cyan = 0, bright = 0, sum = 0;
                        for (let i = 0; i < RW * RH; i++) { const r = buf[i*4], g = buf[i*4+1], b = buf[i*4+2], L = r+g+b; sum += L;
                          if (L > 120) bright++; if (r > 90 && r > b * 1.5 && g > b) orange++; if (g > 80 && b > 80 && r < g * .85) cyan++; }
                        // 黑洞暗盘：视界内部应该几乎全黑（视界在屏幕上的位置随镜头而动）
                        const nx = SC.holeNDC ? SC.holeNDC.x : (HOLE_ANCHOR.x * 2 - 1);
                        const ny = SC.holeNDC ? SC.holeNDC.y : (1 - HOLE_ANCHOR.y * 2);
                        const cx = Math.round((nx * .5 + .5) * RW), cy = Math.round((ny * .5 + .5) * RH);
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