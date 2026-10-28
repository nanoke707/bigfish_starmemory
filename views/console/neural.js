/* ============================================================
   咸鱼星空记忆 · THEME 03 · STARFIELD「恒星与黑洞」
   ------------------------------------------------------------
   视觉语言沿用 agent-display「03 · NEURAL 神经星环」
   （PolyForm Noncommercial 1.0.0 · Copyright (c) 2026 赛博老爸）：
   深空底色 + 青色辉光 + 等宽字 + 细发丝线 + 底部玻璃指标条。

   这一版把画面语义整个换掉了：
   · 正中那颗恒星 = bot 本体，名字取插件配置 general.bot_name
   · 四周的星星 = 一条条具体的记忆（少而真，慢慢攒）
   · 恒星旁边悬着一个黑洞（做法参考「06 · 视界熔炉」那款）
   · 星星越暗 = 越靠近黑洞 = 越接近消散；到跟前就被吸进去
   · 鼠标悬停一颗星 = 把它截停在原地，右栏直接显示这条记忆的细节
     点一下星星 = 打开调试台里的完整详情
   数据全部来自插件真实接口，后端零改动。
   ============================================================ */
var BSM_THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.147.0/";
var BSM_THREE_DEPS = [
  "build/three.min.js",
  "examples/js/shaders/CopyShader.js",
  "examples/js/shaders/LuminosityHighPassShader.js",
  "examples/js/postprocessing/EffectComposer.js",
  "examples/js/postprocessing/RenderPass.js",
  "examples/js/postprocessing/ShaderPass.js",
  "examples/js/postprocessing/UnrealBloomPass.js"
];
function BSM_loadScripts(list) {
  return list.reduce(function (p, rel) {
    return p.then(function () {
      return new Promise(function (res) {
        var s = document.createElement("script");
        s.src = BSM_THREE_CDN + rel;
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

function mountNeural(host, SR) {
  "use strict";

  /* ================= 0. 工具 ================= */
  var $ = function (s) { return SR.querySelector(s); };
  var $$ = function (s) { return SR.querySelectorAll(s); };
  var TAU = Math.PI * 2;
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var pad = function (n, w) { return String(n).padStart(w || 2, "0"); };
  var fmt = function (n) { return Math.round(n).toLocaleString("en-US"); };
  var fmtTok = function (n) {
    return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
  };
  var hms = function (d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var MONO = '"JetBrains Mono","Noto Sans SC","PingFang SC",ui-monospace,Menlo,monospace';
  var CJK = '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
  var THREE = window.THREE;

  var TYPE_ZH = {
    fact: "事实", event: "经历", preference: "偏好", promise: "约定", emotion: "情绪",
    skill: "技能", commitment: "约定", insight: "灵光", task: "待办", person: "人物",
    profile: "画像", other: "其他"
  };
  var STATUS_ZH = { active: "明亮", faded: "变暗", archived: "熄灭" };
  var STATUS_COL = { active: "#a6f1ff", faded: "#ffb547", archived: "#ff4d5e" };

  /* ================= 1. 数据 ================= */
  var MODEL = window.__BSM_MODEL__ || { scopes: [], stars: [], totals: {}, types: [] };
  var BOT_NAME = MODEL.botName || "大肥鱼";
  var SCOPES = MODEL.scopes || [];
  var SCOPE_COLORS = ["#a6f1ff", "#7ee0c8", "#ffd27a", "#ff9ecb", "#9fb4ff", "#c8a6ff", "#8ad8ff", "#ffb47a", "#9ff0a8", "#ff8f8f", "#b8c8ff"];
  var SCOPE_COLOR = {};
  SCOPES.forEach(function (s, i) { SCOPE_COLOR[s.scope] = SCOPE_COLORS[i % SCOPE_COLORS.length]; });

  var MAX_STARS = 56;                 // 屏幕上同时出现的记忆星上限（记忆是慢慢攒的，不需要多）
  var HOLE_R = 30;                    // 视界半径
  var HOLE_X = -430, HOLE_Y = -110, HOLE_Z = 120;   // 黑洞停在恒星左前方不远处

  /* ================= 2. DOM ================= */
  var cv = $("#gl"), board = $("#board"), fitIn = $("#fitIn"), ovl = $("#ovl");
  var elBotName = $("#botName"), elBotSub = $("#botSub"), elBotState = $("#botState");
  var elBright = $("#botBright"), elFaded = $("#botFaded"), elGone = $("#botGone"), elHole = $("#holeCount");
  var elCls = $("#cls"), elLtMeta = $("#ltMeta");
  var elMem = $("#mem"), elMemState = $("#memState");
  var elHeat = $("#heat"), elSpark = $("#spark");
  var elFeed = $("#feed"), elFeedMeta = $("#feedMeta");
  var elClock = $("#clock"), elCap = $("#cap"), elCapK = $("#capK"), elCapV = $("#capV"), elCapT = $("#capT");
  var elTip = $("#tip");
  var elB = {
    topo: $("#bTopo"), topoS: $("#bTopoS"), rate: $("#bRate"), rateS: $("#bRateS"),
    out: $("#bOut"), outS: $("#bOutS"), outBar: $("#bOutBar"), pass: $("#bPass"), passS: $("#bPassS"),
    tok: $("#bTok"), tokS: $("#bTokS"), fps: $("#bFps"), fpsS: $("#bFpsS")
  };

  /* ================= 3. 状态 ================= */
  var W = 1, H = 1, narrow = false, boardScale = .5;
  var simT = 0, animT = 0, paused = false;
  var fps = 0, fpsN = 0, fpsT = 0, lowT = 0, pr = 1, autoNote = "";
  var lastNow = performance.now();
  var modeI = 0;
  var MODES = [
    { zh: "环绕", yaw: .35, pitch: .30, dist: 820 },
    { zh: "俯视", yaw: .35, pitch: 1.02, dist: 900 },
    { zh: "近观", yaw: -.75, pitch: .16, dist: 520 }
  ];
  var cam = { yaw: .35, pitch: .30, dist: 820, tgt: new THREE.Vector3(0, 0, 0), userT: 0 };
  var rateBins = new Array(60).fill(0), rateCur = 0, rateAcc = 0;
  var feed = [], feedDirty = true;
  var mems = [];                       // 记忆星
  var memById = {};
  var absorbedIds = {};                // 已经被黑洞吸掉的记忆（刷新数据也不会诈尸）
  var held = null;                     // 被截停的那颗星
  var picked = null;
  var absorbed = 0;                    // 被黑洞吸进去的记忆数
  var stats = { bright: 0, faded: 0, archived: 0, gone: 0 };
  var lastRecall = { scope: "—", verb: "想起", text: "—", kind: "" };

  /* ================= 4. 3D 场景 ================= */
  var renderer = null, scene = null, camera = null, composer = null, bloomPass = null;
  var world = null, sky = null, botStar = null, holeGrp = null, holeDisk = null, holeRing = null, haloSpr = null;
  var SPRITE = null, GLOW = null;
  var glOK = false;
  var camPos = new THREE.Vector3(0, 60, 820);

  function makeRadial(inner, mid, outer) {
    var c = document.createElement("canvas");
    c.width = c.height = 128;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(mid[0], mid[1]);
    g.addColorStop(1, outer);
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  function buildScene() {
    try {
      renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setClearColor(0x03050a, 1);
      scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x03050a, 0.00085);
      camera = new THREE.PerspectiveCamera(46, 1, 1, 4000);
      world = new THREE.Group();
      scene.add(world);

      SPRITE = makeRadial("rgba(255,255,255,1)", [.16, "rgba(255,255,255,.92)"], "rgba(255,255,255,0)");
      GLOW = makeRadial("rgba(255,255,255,.85)", [.22, "rgba(255,255,255,.22)"], "rgba(255,255,255,0)");

      buildSky();
      buildBot();
      buildHole();

      if (window.THREE.EffectComposer && window.THREE.UnrealBloomPass) {
        composer = new THREE.EffectComposer(renderer);
        composer.addPass(new THREE.RenderPass(scene, camera));
        bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(512, 512), .72, .5, .26);
        composer.addPass(bloomPass);
      }
      glOK = true;
    } catch (e) {
      console.error("[StarMemory] 3D 场景创建失败:", e);
      var gf = $("#glFail");
      if (gf) gf.hidden = false;
    }
  }

  /* 背景星尘：远景 + 中景两层，制造纵深 */
  function buildSky() {
    var g = new THREE.Group();
    var layers = [
      { n: 1400, r: 1500, s: 5.0, o: .34, c: 0x8fb6d8 },
      { n: 900, r: 900, s: 7.5, o: .55, c: 0xcfe6ff }
    ];
    layers.forEach(function (L) {
      var pos = new Float32Array(L.n * 3), col = new Float32Array(L.n * 3);
      var c = new THREE.Color(L.c);
      for (var i = 0; i < L.n; i++) {
        var u = Math.random(), v = Math.random() * TAU;
        var rr = L.r * (0.75 + Math.random() * .45);
        var sp = Math.sqrt(1 - u * u);
        pos[i * 3] = Math.cos(v) * sp * rr;
        pos[i * 3 + 1] = (u - .5) * rr * .55;
        pos[i * 3 + 2] = Math.sin(v) * sp * rr;
        var b = .5 + Math.random() * .5;
        col[i * 3] = c.r * b; col[i * 3 + 1] = c.g * b; col[i * 3 + 2] = c.b * b;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      var pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: L.s, sizeAttenuation: true, vertexColors: true, transparent: true,
        opacity: L.o, depthWrite: false, blending: THREE.AdditiveBlending
      }));
      g.add(pts);
    });
    sky = g;
    scene.add(g);
  }

  /* 正中的恒星 = bot 本体 */
  function buildBot() {
    botStar = new THREE.Group();
    var core = new THREE.Mesh(
      new THREE.SphereGeometry(17, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    botStar.add(core);
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SPRITE, color: 0xa6f1ff, transparent: true, opacity: .95,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo.scale.set(190, 190, 1);
    botStar.add(halo);
    var halo2 = new THREE.Sprite(new THREE.SpriteMaterial({
      map: GLOW, color: 0x4fd8ff, transparent: true, opacity: .42,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo2.scale.set(430, 430, 1);
    botStar.add(halo2);
    // 光环：像恒星的光环系统，给中心一点结构感
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(46, 52, 96),
      new THREE.MeshBasicMaterial({
        color: 0x9fe9ff, transparent: true, opacity: .34, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    ring.rotation.x = Math.PI * .5;
    botStar.add(ring);
    botStar.userData.ring = ring;
    botStar.userData.halo = halo;
    botStar.userData.halo2 = halo2;
    world.add(botStar);
  }

  /* 黑洞：视界 + 光子环 + 吸积盘 */
  function buildHole() {
    holeGrp = new THREE.Group();
    holeGrp.position.set(HOLE_X, HOLE_Y, HOLE_Z);

    // 视界：一个纯黑球体，把后面的东西挡住
    var horizon = new THREE.Mesh(
      new THREE.SphereGeometry(HOLE_R, 40, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    holeGrp.add(horizon);

    // 光子环：极细的一圈高亮
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(HOLE_R * 1.02, HOLE_R * 1.42, 128),
      new THREE.MeshBasicMaterial({
        color: 0xffc98a, transparent: true, opacity: .95, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    holeGrp.add(ring);
    holeRing = ring;

    // 吸积盘：自定义着色器，径向条纹 + 角向流动
    var diskGeo = new THREE.RingGeometry(HOLE_R * 1.35, HOLE_R * 6.2, 160, 6);
    var diskMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHot: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: [
        "varying vec2 vUv; varying vec3 vP;",
        "void main(){ vUv = uv; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }"
      ].join("\n"),
      fragmentShader: [
        "precision highp float;",
        "uniform float uTime; uniform float uHot;",
        "varying vec2 vUv; varying vec3 vP;",
        "float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }",
        "void main(){",
        "  float r = length(vP.xy);",
        "  float a = atan(vP.y, vP.x);",
        "  float n = r * 0.055;",
        "  float w = sin(a * 7.0 - uTime * 1.1 + r * 0.09) * 0.5 + 0.5;",
        "  float streak = hash(vec2(floor(a * 9.0), floor(r * 0.22 + uTime * 0.35)));",
        "  float t = clamp((r - 40.0) / 150.0, 0.0, 1.0);",
        "  float band = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.45, 1.0, t));",
        "  float heat = 1.0 - t;",
        "  vec3 c = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.94, 0.72), pow(heat, 2.2));",
        "  c = mix(c, vec3(1.0, 1.0, 1.0), w * 0.35 + streak * 0.2);",
        "  float al = band * (0.32 + w * 0.45 + streak * 0.25) * (0.75 + uHot * 0.6);",
        "  gl_FragColor = vec4(c * al, al);",
        "}"
      ].join("\n")
    });
    holeDisk = new THREE.Mesh(diskGeo, diskMat);
    holeDisk.rotation.x = Math.PI * .5;
    holeDisk.rotation.z = .3;
    holeGrp.add(holeDisk);

    // 透镜光晕：中间透空的一圈
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: GLOW, color: 0xff9a4a, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo.scale.set(HOLE_R * 9, HOLE_R * 9, 1);
    holeGrp.add(halo);

    world.add(holeGrp);
  }

  /* ================= 5. 记忆星 ================= */
  function makeMemSprite(star) {
    var col = SCOPE_COLOR[star.scope] || "#a6f1ff";
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SPRITE, color: new THREE.Color(col), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    world.add(spr);
    // 截停时用的准星环
    var ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: RING_TEX(), color: new THREE.Color("#ffffff"), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    ring.scale.set(70, 70, 1);
    world.add(ring);
    return { spr: spr, ring: ring };
  }

  var _ringTex = null;
  function RING_TEX() {
    if (_ringTex) return _ringTex;
    var c = document.createElement("canvas");
    c.width = c.height = 128;
    var x = c.getContext("2d");
    x.strokeStyle = "rgba(255,255,255,.95)";
    x.lineWidth = 3;
    x.beginPath();
    x.arc(64, 64, 46, 0, TAU);
    x.stroke();
    x.lineWidth = 2;
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2 + Math.PI / 4;
      x.beginPath();
      x.moveTo(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 52);
      x.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62);
      x.stroke();
    }
    _ringTex = new THREE.CanvasTexture(c);
    return _ringTex;
  }

  function fadeTarget(status, retention) {
    if (status === "archived") return .97;
    if (status === "faded") return .52 + (1 - clamp(retention || 0, 0, 1)) * .30;
    return .02 + (1 - clamp(retention || 0, 0, 1)) * .16;
  }

  function buildMems(stars) {
    // 先清掉旧的
    mems.forEach(function (m) {
      world.remove(m.spr); world.remove(m.ring);
    });
    mems = []; memById = {};
    held = null; picked = null;

    // 选星：记忆是慢慢攒的，屏幕上不需要多。但三态都要有——
    // 亮的占大头，变暗的正在往黑洞走，熄灭的已经快没了。
    var all = (stars || []).filter(function (s) { return !absorbedIds[s.id]; });
    var by = { active: [], faded: [], archived: [] };
    all.forEach(function (s) { (by[s.status] || by.active).push(s); });
    var weight = { active: .70, faded: .20, archived: .10 };
    var list = [];
    ["active", "faded", "archived"].forEach(function (k) {
      var arr = by[k].slice().sort(function (a, b) {
        return (b.importance || 0) + (b.retention || 0) * .5 - ((a.importance || 0) + (a.retention || 0) * .5);
      });
      var quota = Math.round(MAX_STARS * weight[k]);
      list = list.concat(arr.slice(0, quota));
    });
    if (list.length < MAX_STARS) {
      var used = {};
      list.forEach(function (s) { used[s.id] = 1; });
      all.slice().forEach(function (s) {
        if (list.length >= MAX_STARS) return;
        if (!used[s.id]) { list.push(s); used[s.id] = 1; }
      });
    }
    list = list.slice(0, MAX_STARS);

    list.forEach(function (s, i) {
      var v = makeMemSprite(s);
      var m = {
        id: s.id, data: s,
        spr: v.spr, ring: v.ring,
        r: 250 + (i % 7) * 46 + rnd(-16, 16),
        phase: rnd(0, TAU),
        speed: rnd(.035, .085) * (rnd() > .5 ? 1 : -1),
        spinAcc: 0,
        tiltA: rnd(-.42, .42),
        tiltB: rnd(-.42, .42),
        fade: fadeTarget(s.status, s.retention),
        target: fadeTarget(s.status, s.retention),
        hold: false,
        dead: false,
        size: 9 + (s.importance || 0) * .22 + clamp(s.retention || 0, 0, 1) * 9
      };
      mems.push(m);
      memById[s.id] = m;
      placeMem(m, 0);
    });
    stats.bright = list.filter(function (s) { return s.status === "active"; }).length;
    stats.faded = list.filter(function (s) { return s.status === "faded"; }).length;
    stats.archived = list.filter(function (s) { return s.status === "archived"; }).length;
    stats.gone = absorbed;
  }

  function placeMem(m, dt) {
    var f = clamp(m.fade, 0, 1);
    var a = m.phase + m.spinAcc;
    var rr = m.r * (1 - .62 * f);
    var x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = 0;
    // 盘面倾角
    var ca = Math.cos(m.tiltA), sa = Math.sin(m.tiltA);
    var ny = y * ca - z * sa, nz = y * sa + z * ca; y = ny; z = nz;
    var cb = Math.cos(m.tiltB), sb = Math.sin(m.tiltB);
    var nx = x * cb - z * sb, nz2 = x * sb + z * cb; x = nx; z = nz2;
    // 黑洞引力：轨道中心往黑洞挪，半径同时收缩
    var cx = x * (1 - f) + HOLE_X * f;
    var cy = y * (1 - f) + HOLE_Y * f;
    var cz = z * (1 - f) + HOLE_Z * f;
    m.spr.position.set(cx, cy, cz);
    m.ring.position.set(cx, cy, cz);
    // 越暗越小越红
    var dim = 1 - f * .78;
    var warm = f * f;
    var base = new THREE.Color(SCOPE_COLOR[m.data.scope] || "#a6f1ff");
    var col = base.clone().lerp(new THREE.Color("#ff5a2a"), warm * .85);
    m.spr.material.color.copy(col);
    m.spr.material.opacity = dim;
    var sc = m.size * (1 - f * .42) * (m.hold ? 1.5 : 1);
    m.spr.scale.set(sc, sc, 1);
    m.ring.scale.set(sc * 3.4, sc * 3.4, 1);
    m.ring.material.opacity = m.hold ? .85 : 0;
    m.ring.material.color.copy(col).lerp(new THREE.Color("#ffffff"), .5);
  }

  function updateMems(dt) {
    for (var i = 0; i < mems.length; i++) {
      var m = mems[i];
      if (m.dead) continue;
      if (!m.hold) {
        m.spinAcc += dt * (.12 + 2.6 * m.fade * m.fade + .7 * m.fade);
        // 已经在变暗的记忆会一路往黑洞走，越走越快，最后被吸进去
        if (m.data.status === "faded") m.target = Math.min(1, m.target + dt * .012);
        m.fade += (m.target - m.fade) * Math.min(1, dt * .35);
        if (m.fade >= .985 && m.target > .9) {
          // 被黑洞吃掉了
          m.dead = true;
          world.remove(m.spr); world.remove(m.ring);
          absorbed++;
          absorbedIds[m.id] = 1;
          stats.gone = absorbed;
          logFeed("黑洞", "消散", m.data.content ? String(m.data.content).slice(0, 24) : m.data.id, "bad");
          if (held === m) { held = null; renderMem(); }
          continue;
        }
      }
      placeMem(m, dt);
    }
  }

  /* ================= 6. HUD ================= */
  /* 点恒星上的名字 → 去设置里改 bot 名字 */
  function bindBotName() {
    var el = elBotName;
    if (!el || el.__bsmBound) return;
    el.__bsmBound = true;
    el.style.cursor = "pointer";
    el.title = "点这里改 bot 的名字（会同步到设置页）";
    el.addEventListener("click", function () {
      if (host.__nr && host.__nr.openBotSettings) host.__nr.openBotSettings();
    });
  }

  function renderScopes() {    if (!elCls) return;
    var html = SCOPES.map(function (s, i) {
      var tot = s.total || 0;
      var act = s.active || 0;
      var pct = tot ? Math.round(act / tot * 100) : 0;
      var c = SCOPE_COLORS[i % SCOPE_COLORS.length];
      var st = s.faded ? (s.archived ? "正在消散" : "部分变暗") : "都还亮着";
      return '<div class="cl' + (s.faded ? " work" : "") + '" style="--c:' + c + '">' +
        '<span class="sw"></span>' +
        '<span class="k">' + esc(s.short || s.scope) + '</span>' +
        '<span class="z">' + esc(s.scope) + '</span>' +
        '<span class="pc">' + fmt(tot) + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="st">' + st + ' · 明亮 ' + pct + '%</span>' +
        '</div>';
    }).join("");
    if (elLtMeta) {
      elLtMeta.textContent = SCOPES.length + " 个星域 · " + fmt((MODEL.totals || {}).active || 0) + " 颗明亮";
    }
    elCls.innerHTML = html || '<div class="cl-empty">还没有星域</div>';
  }

  function renderBot() {
    if (elBotName) elBotName.textContent = BOT_NAME;
    if (elBotSub) {
      elBotSub.textContent = "记忆就是星 · " + fmt((MODEL.totals || {}).all || mems.length) + " 颗 · " +
        SCOPES.length + " 个星域 · 今天新写 " + (MODEL.todayNew || 0) + " 颗";
    }
    if (elBright) elBright.textContent = fmt(stats.bright);
    if (elFaded) elFaded.textContent = fmt(stats.faded);
    if (elGone) elGone.textContent = fmt(stats.gone);
    if (elHole) elHole.textContent = fmt(absorbed);
    if (elBotState) elBotState.textContent = mems.length + " 颗在场";
    var ob = $("#ovlBot");
    if (ob) ob.textContent = BOT_NAME;
    // 窄屏精简条
    var mo = $("#mOut"), ml = $("#mLive"), mt = $("#mTok"), mc = $("#mCap");
    if (mo) mo.textContent = MODEL.todayNew || 0;
    if (ml) ml.textContent = mems.length;
    if (mt) mt.textContent = fmtTok(MODEL.emotionEnergy || 0);
    if (mc) mc.textContent = "在场 " + mems.length + " 颗星 · 已消散 " + absorbed + " 颗";
  }

  function renderMem() {
    if (!elMem) return;
    var m = held;
    if (!m) {
      elMem.innerHTML = '<div class="mem-empty">把鼠标放到一颗星星上 → <b>截停</b>它<br>' +
        '这里会显示这条记忆的细节。<br>点一下星星，直接进调试台看完整档案。</div>';
      if (elMemState) elMemState.textContent = "悬停截停";
      return;
    }
    var s = m.data;
    var ret = Math.round((s.retention || 0) * 100);
    var clr = Math.round((s.clarity || 0) * 100);
    var imp = Math.round((s.importance || 0) * 100);
    var f = clamp(m.fade, 0, 1);
    var fate = f < .22 ? "还很稳" : (f < .62 ? "正在被黑洞吸走" : "快被吸进去了");
    var fateCol = f < .22 ? "#3ce69a" : (f < .62 ? "#ffb547" : "#ff4d5e");
    var col = SCOPE_COLOR[s.scope] || "#a6f1ff";
    elMem.innerHTML =
      '<div class="mem-k">' +
      '<span class="chip" style="--c:' + col + '">#' + esc(s.id) + '</span>' +
      '<span class="chip">' + esc(s.typeZh || TYPE_ZH[s.type] || "记忆") + '</span>' +
      '<span class="chip">' + esc(s.scopeShort || s.scope) + '</span>' +
      '<span class="chip" style="--c:' + STATUS_COL[s.status] + '">' + esc(STATUS_ZH[s.status] || s.status) + '</span>' +
      (s.pinned ? '<span class="chip" style="--c:#ffd27a">珍藏</span>' : '') +
      '</div>' +
      '<div class="mem-t">' + esc(s.content || "（空）") + '</div>' +
      '<div class="mem-bar"><i style="width:' + ret + '%;background:' + col + '"></i></div>' +
      '<dl>' +
      '<dt>保持率</dt><dd>' + ret + '%</dd>' +
      '<dt>清晰度</dt><dd>' + clr + '%</dd>' +
      '<dt>重要度</dt><dd>' + imp + '%</dd>' +
      '<dt>半衰期</dt><dd>' + (s.halfLife || 0) + ' 天</dd>' +
      '<dt>强化 / 检索</dt><dd>' + (s.reviewCount || 0) + ' / ' + (s.recallCount || 0) + ' 次</dd>' +
      '<dt>发生于</dt><dd>' + esc(s.eventTime || "时间不详") + '</dd>' +
      '<dt>距消散</dt><dd style="color:' + fateCol + '">' + fate + '</dd>' +
      '</dl>' +
      '<div class="mem-tip">已截停 · 点这颗星进调试台</div>';
    if (elMemState) elMemState.textContent = "截停中";
  }

  function logFeed(scope, verb, text, kind) {
    feed.unshift({ t: hms(new Date()), scope: scope, verb: verb, text: text, kind: kind || "" });
    if (feed.length > 40) feed.pop();
    feedDirty = true;
  }

  function renderFeed() {
    if (!elFeed) return;
    feedDirty = false;
    elFeed.innerHTML = feed.slice(0, 26).map(function (f) {
      return '<li class="' + f.kind + '"><time>' + f.t + '</time><b>' + esc(f.scope) + '</b>' +
        '<em>' + esc(f.verb) + '</em><span>' + esc(f.text) + '</span></li>';
    }).join("");
    if (elFeedMeta) elFeedMeta.textContent = feed.length + " 条 · 在飞 " + rateCur;
  }

  function renderCap() {
    if (!elCap) return;
    elCapK.textContent = lastRecall.scope;
    elCapV.textContent = lastRecall.verb;
    elCapT.textContent = lastRecall.text;
    elCap.className = "cap " + (lastRecall.kind || "");
  }

  function renderBottom() {
    var tot = MODEL.totals || {};
    if (elB.topo) elB.topo.innerHTML = fmt(tot.all || 0) + "<small>颗星</small>";
    if (elB.topoS) elB.topoS.textContent = SCOPES.length + " 星域 · 明亮 " + fmt(tot.active || 0);
    if (elB.rate) elB.rate.innerHTML = String(rateCur) + "<small>次/分</small>";
    if (elB.rateS) elB.rateS.textContent = "召回 " + fmt(MODEL.recallCount || 0) + " 次";
    if (elB.out) elB.out.textContent = String(MODEL.todayNew || 0);
    if (elB.outS) elB.outS.textContent = "今日新星 · 目标 " + (MODEL.dayTarget || 30);
    if (elB.outBar) elB.outBar.style.width = clamp((MODEL.todayNew || 0) / (MODEL.dayTarget || 30) * 100, 0, 100) + "%";
    if (elB.pass) elB.pass.textContent = Math.round((MODEL.avgRetention || 0) * 100) + "%";
    if (elB.passS) elB.passS.textContent = "归档 " + fmt(tot.archived || 0) + " · 变暗 " + fmt(tot.faded || 0);
    if (elB.tok) elB.tok.textContent = fmtTok(MODEL.emotionEnergy || 0);
    if (elB.tokS) elB.tokS.textContent = "情绪残留 · 心绪 " + (MODEL.mood && MODEL.mood.valence != null ? MODEL.mood.valence.toFixed(2) : "—");
    if (elB.fps) elB.fps.textContent = fps + "fps";
    if (elB.fpsS) elB.fpsS.textContent = "在场 " + mems.length + " 颗" + autoNote;
  }

  /* 召回热力：每个星域一行，横轴是最近 30 秒 */
  var heatRows = [], heatAcc = 0;
  function drawHeat() {
    if (!elHeat) return;
    var ctx = elHeat.getContext("2d");
    var w = elHeat.width, h = elHeat.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    var rows = Math.min(SCOPES.length, 12);
    if (!rows) return;
    var cw = w / 12, ch = h / rows;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < 12; c++) {
        var v = heatRows[r] ? (heatRows[r][c] || 0) : 0;
        if (v <= 0.001) continue;
        var col = SCOPE_COLORS[r % SCOPE_COLORS.length];
        ctx.fillStyle = col;
        ctx.globalAlpha = clamp(v, .06, 1) * .55;
        ctx.fillRect(c * cw + 1, r * ch + 1, cw - 2, ch - 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSpark() {
    if (!elSpark) return;
    var ctx = elSpark.getContext("2d");
    var w = elSpark.width, h = elSpark.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    var mx = Math.max.apply(null, rateBins.concat([1]));
    ctx.beginPath();
    for (var i = 0; i < rateBins.length; i++) {
      var x = i / (rateBins.length - 1) * w;
      var y = h - (rateBins[i] / mx) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#a6f1ff";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /* ================= 7. 模拟：召回、消散、脉冲 ================= */
  function simulate(dt) {
    simT += dt;
    // 召回：每隔一会儿想起一颗还记得住的星
    if (Math.random() < dt * .55) {
      var alive = mems.filter(function (m) { return !m.dead && m.data.status === "active"; });
      if (alive.length) {
        var m = alive[(Math.random() * alive.length) | 0];
        var sc = SCOPES[m.data.scopeIndex] || {};
        lastRecall = {
          scope: sc.short || "—",
          verb: "想起",
          text: String(m.data.content || "").slice(0, 30),
          kind: ""
        };
        logFeed(sc.short || "—", "想起", String(m.data.content || "").slice(0, 26));
        rateCur++;
        m.flash = 1;
      }
    }
    // 变暗的星偶尔被强化一次（回到明亮）
    if (Math.random() < dt * .22) {
      var fad = mems.filter(function (m) { return !m.dead && m.data.status === "faded"; });
      if (fad.length) {
        var f2 = fad[(Math.random() * fad.length) | 0];
        f2.target = Math.max(.05, f2.target - .18);
        f2.flash = 1;
      }
    }
    rateAcc += dt;
    if (rateAcc >= 1) { rateBins.push(rateCur); rateBins.shift(); rateCur = 0; rateAcc = 0; }
    heatAcc += dt;
    if (heatAcc >= 2.5) {
      heatAcc = 0;
      for (var r = 0; r < 12; r++) {
        if (!heatRows[r]) heatRows[r] = new Array(12).fill(0);
        heatRows[r].unshift(0);
        heatRows[r].pop();
      }
    }
    // 把召回记到对应星域的热力格上
    if (Math.random() < dt * 1.2) {
      var idx = (Math.random() * Math.min(SCOPES.length, 12)) | 0;
      if (heatRows[idx]) heatRows[idx][0] = clamp((heatRows[idx][0] || 0) + .55, 0, 1);
    }
  }

  /* ================= 8. 交互 ================= */
  var v3 = null;
  function screenOf(p) {
    if (!v3) v3 = new THREE.Vector3();
    v3.copy(p).project(camera);
    return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H];
  }

  function pickMem(x, y) {
    if (!glOK) return null;
    var best = null, bd = 30 * 30;
    for (var i = 0; i < mems.length; i++) {
      var m = mems[i];
      if (m.dead) continue;
      var s = screenOf(m.spr.position);
      var d = (s[0] - x) * (s[0] - x) + (s[1] - y) * (s[1] - y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  function setHeld(m) {
    if (held === m) return;
    if (held) held.hold = false;
    held = m;
    if (held) held.hold = true;
    renderMem();
  }

  function showTip(m) {
    if (!elTip) return;
    var s = m.data;
    var col = SCOPE_COLOR[s.scope] || "#a6f1ff";
    elTip.style.setProperty("--c", col);
    elTip.innerHTML = '<span><b>#' + esc(s.id) + '</b><strong>' + esc(s.typeZh || TYPE_ZH[s.type] || "记忆") + '</strong> · ' +
      esc(s.scopeShort || s.scope) + '</span><span>' + esc(String(s.content || "").slice(0, 40)) + '</span>' +
      '<span class="h">已截停 · 点这颗星进调试台</span>';
    elTip.hidden = false;
    var sc = screenOf(m.spr.position);
    var tw = elTip.offsetWidth, th = elTip.offsetHeight;
    var x = sc[0] + 18, y = sc[1] - th / 2;
    if (x + tw > W - 12) x = sc[0] - tw - 18;
    elTip.style.left = clamp(x, 8, W - tw - 8) + "px";
    elTip.style.top = clamp(y, 8, H - th - 8) + "px";
  }

  var drag = null;
  if (cv) {
    cv.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { }
    });
    cv.addEventListener("pointermove", function (e) {
      var r = host.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag) {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) {
          drag.moved = true;
          cv.classList.add("drag");
        }
        if (drag.moved && glOK) {
          cam.yaw -= dx * .006;
          cam.pitch = clamp(cam.pitch + dy * .005, -.25, 1.25);
          cam.userT = 6;
          elTip.hidden = true;
        }
        return;
      }
      var m = pickMem(x, y);
      picked = m;
      cv.classList.toggle("hov", !!m);
      if (m) {
        setHeld(m);
        showTip(m);
      } else {
        setHeld(null);
        elTip.hidden = true;
      }
    });
    cv.addEventListener("pointerup", function (e) {
      var wasDrag = drag && drag.moved;
      drag = null;
      cv.classList.remove("drag");
      if (wasDrag) return;
      var r = host.getBoundingClientRect();
      var m = pickMem(e.clientX - r.left, e.clientY - r.top);
      if (m) {
        setHeld(m);
        if (host.__nr && host.__nr.openDetail) host.__nr.openDetail(m.id);
      }
    });
    cv.addEventListener("pointerleave", function () {
      if (!drag) { elTip.hidden = true; setHeld(null); picked = null; }
    });
    cv.addEventListener("wheel", function (e) {
      if (!glOK) return;
      e.preventDefault();
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * .0012), 260, 1600);
      cam.userT = 6;
    }, { passive: false });
  }

  function syncButtons() {
    $$('[data-f="mode"]').forEach(function (b) { b.textContent = MODES[modeI].zh; });
    var fb = $('[data-f="full"]');
    if (fb) fb.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  }

  function act(name) {
    if (name === "mode") {
      modeI = (modeI + 1) % MODES.length;
      cam.userT = 4;
      syncButtons();
    } else if (name === "full") {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (host.requestFullscreen) host.requestFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    }
  }
  // 注意：Shadow DOM 里的事件不会冒泡成带属性的 target，必须逐个元素绑定
  $$('[data-act]').forEach(function (b) {
    b.addEventListener("click", function () { act(b.getAttribute("data-act")); });
  });
  document.addEventListener("fullscreenchange", syncButtons);

  /* ================= 9. 尺寸 / 主循环 ================= */
  function layout() {
    if (host.hidden || host.clientWidth < 2) return;
    var r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    narrow = W < 760 || W / H < 1.05;
    var nr = $("#nr");
    if (nr) nr.classList.toggle("narrow", narrow);
    var fr = fitIn.getBoundingClientRect();
    boardScale = Math.min(fr.width / 1920, fr.height / 1080);
    var BW = fr.width / boardScale, BH = fr.height / boardScale;
    board.style.width = BW + "px";
    board.style.height = BH + "px";
    board.style.setProperty("--s", boardScale);
    sizeCv(elHeat, "heatX");
    sizeCv(elSpark, "sparkX");
    if (!glOK) return;
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); }
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }

  function sizeCv(el, key) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.max(1, Math.round(r.width * dpr));
    el.height = Math.max(1, Math.round(r.height * dpr));
  }

  function camWant() {
    var m = MODES[modeI];
    if (cam.userT <= 0) {
      cam.yaw += (m.yaw - cam.yaw) * .02;
      cam.pitch += (m.pitch - cam.pitch) * .02;
      cam.dist += (m.dist - cam.dist) * .02;
    }
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    camPos.set(
      cam.tgt.x + Math.cos(cam.yaw) * cp * cam.dist,
      cam.tgt.y + sp * cam.dist,
      cam.tgt.z + Math.sin(cam.yaw) * cp * cam.dist
    );
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (host.hidden || document.hidden) { lastNow = now; return; }
    var real = (now - lastNow) / 1000, dt = Math.min(.1, real);
    lastNow = now;
    if (!paused) { simT += dt; animT += dt; simulate(dt); }
    if (elClock) elClock.textContent = hms(new Date());

    if (glOK) {
      camWant();
      camera.position.copy(camPos);
      camera.lookAt(cam.tgt);
      updateMems(dt);
      // 恒星脉动
      if (botStar) {
        var p = 1 + Math.sin(animT * 1.15) * .06;
        botStar.userData.halo.scale.set(190 * p, 190 * p, 1);
        botStar.userData.halo2.scale.set(430 * (1 + Math.sin(animT * .7) * .05), 430 * (1 + Math.sin(animT * .7) * .05), 1);
        botStar.userData.ring.rotation.z = animT * .12;
        botStar.rotation.y = animT * .06;
      }
      // 黑洞：盘转 + 环呼吸
      if (holeDisk) {
        holeDisk.material.uniforms.uTime.value = animT;
        holeDisk.rotation.z = animT * .25;
        holeGrp.rotation.y = animT * .08;
      }
      if (holeRing) {
        var rp = 1 + Math.sin(animT * 1.6) * .03;
        holeRing.scale.set(rp, rp, 1);
      }
      // 恒星的 3D 标签 + 黑洞标签
      if (ovl) {
        var s = screenOf(botStar.position);
        ovl.style.setProperty("--bx", s[0] + "px");
        ovl.style.setProperty("--by", s[1] + "px");
        var h = screenOf(holeGrp.position);
        ovl.style.setProperty("--hx", h[0] + "px");
        ovl.style.setProperty("--hy", h[1] + "px");
      }
      fpsN++; fpsT += Math.min(real, 2);
      if (fpsT >= 1) {
        fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0;
        if (!paused && fps < 30) lowT++; else lowT = 0;
        if (lowT >= 3) {
          lowT = 0;
          if (pr > .75) { pr = .75; autoNote = " · 已降清晰度"; layout(); }
        }
      }
      if (composer) composer.render(); else renderer.render(scene, camera);
    }

    uiAcc += dt;
    if (uiAcc >= .25) {
      uiAcc = 0;
      renderBot(); renderBottom(); renderScopes();
      if (feedDirty) renderFeed();
      drawHeat(); drawSpark();
    }
  }

  var uiAcc = 0;

  /* ================= 10. 对外接口 ================= */
  var api = {
    setModel: function (m) {      MODEL = m || MODEL;
      BOT_NAME = MODEL.botName || BOT_NAME || "大肥鱼";
      SCOPES = MODEL.scopes || [];
      SCOPE_COLOR = {};
      SCOPES.forEach(function (s, i) { SCOPE_COLOR[s.scope] = SCOPE_COLORS[i % SCOPE_COLORS.length]; });
      if (elBotName) elBotName.textContent = BOT_NAME;
      if (elCap) renderCap();
      buildMems(MODEL.stars || []);
      renderBot(); renderScopes(); renderMem(); renderBottom();
    },
    feed: feed,
    tasks: mems,
    stars: mems,
    ag: SCOPES,
    // 给自动化探针用：记忆星在屏幕上的位置（真·鼠标事件才能测出悬停截停）
    starScreen: function () {
      return mems.filter(function (m) { return !m.dead; }).map(function (m) {
        var s = screenOf(m.spr.position);
        return { id: m.id, x: s[0], y: s[1], fade: m.fade, status: m.data.status, scope: m.data.scope };
      });
    },
    // 恒星 / 黑洞在屏幕上的位置 + 相机状态
    marks: function () {
      if (!glOK) return null;
      var b = screenOf(botStar.position), h = screenOf(holeGrp.position);
      return {
        bot: { x: b[0], y: b[1] },
        hole: { x: h[0], y: h[1] },
        cam: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist },
        diskProgram: !!(holeDisk && holeDisk.material && holeDisk.material.program),
        mems: mems.length, absorbed: absorbed
      };
    },
    // 直接把 3D 场景渲进一张离屏贴图读像素：确认黑洞吸积盘 / 记忆星真的画出来了
    probe3d: function () {
      if (!glOK) return null;
      var RW = 320, RH = 180;
      var rt = new THREE.WebGLRenderTarget(RW, RH);
      var old = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      var buf = new Uint8Array(RW * RH * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, buf);
      renderer.setRenderTarget(old);
      rt.dispose();
      var orange = 0, cyan = 0, bright = 0, sum = 0, maxL = 0, maxAt = null;
      for (var i = 0; i < RW * RH; i++) {
        var r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
        var L = r + g + b;
        sum += L;
        if (L > 120) bright++;
        if (L > maxL) { maxL = L; maxAt = [i % RW, Math.floor(i / RW)]; }
        if (r > 90 && r > b * 1.5 && g > b) orange++;
        if (g > 80 && b > 80 && r < g * .85) cyan++;
      }
      // 黑洞在画面上的相对位置（0..1），照着它取样
      var hx = 1 - holeGrp.position.x / 1200, hy = .5 + holeGrp.position.y / 1200;
      var bx = .5, by = .5;
      var sample = function (fx, fy) {
        var x = Math.round(clamp(fx, 0, .99) * RW), y = Math.round(clamp(fy, 0, .99) * RH);
        var k = (y * RW + x) * 4;
        return [buf[k], buf[k + 1], buf[k + 2]];
      };
      return {
        size: [RW, RH],
        nonBlackPx: bright,
        orangePx: orange,
        cyanPx: cyan,
        avgLum: Math.round(sum / (RW * RH)),
        maxAt: maxAt,
        botSample: sample(bx, by),
        holeSample: sample(hx, hy),
        starCount: mems.length
      };
    },
    ff: function () { if (document.fullscreenElement) document.exitFullscreen(); else if (host.requestFullscreen) host.requestFullscreen(); }
  };
  // 用 getter 保证外部拿到的永远是最新的一份
  Object.defineProperty(api, "model", { get: function () { return MODEL; } });
  Object.defineProperty(api, "feed", { get: function () { return feed; } });
  Object.defineProperty(api, "tasks", { get: function () { return mems; } });
  Object.defineProperty(api, "stars", { get: function () { return mems; } });
  Object.defineProperty(api, "ag", { get: function () { return SCOPES; } });
  host.__nr = api;

  /* ================= 11. 启动 ================= */
  buildScene();
  layout();
  syncButtons();
  bindBotName();
  renderBot(); renderScopes(); renderMem(); renderBottom();
  if (MODEL.stars && MODEL.stars.length) buildMems(MODEL.stars);
  // 事件流
  (MODEL.events || []).slice(0, 8).forEach(function (ev) {
    logFeed((SCOPES[ev.scopeIndex] || {}).short || "—", ev.verb, ev.text, ev.kind);
  });
  requestAnimationFrame(frame);
  window.addEventListener("resize", layout);
  if (window.ResizeObserver) { try { new ResizeObserver(layout).observe(host); } catch (_) { } }
  setInterval(layout, 1500);
}
