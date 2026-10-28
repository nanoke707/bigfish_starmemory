/* ============================================================
   咸鱼星空记忆 · 观测台 3D 场景
   两款场景：
     neural —— NEURAL 神经星环：星团节点 + 突触脉冲 + 环形能量块 HUD
     nebula —— NEBULA 星核星云：丝带星核 + 三圈星云轨道 + 巡检蛛逐字审读
   three.js 从 CDN 按序加载；全部失败时返回 null，由 app.js 切 2D 降级视图。
   ============================================================ */
(function (global) {
  "use strict";

  var THREE_SOURCES = [
    "https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js",
    "https://unpkg.com/three@0.147.0/build/three.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.147.0/three.min.js"
  ];

  var threePromise = null;

  function loadThree() {
    if (global.THREE) return Promise.resolve(global.THREE);
    if (threePromise) return threePromise;
    threePromise = new Promise(function (resolve) {
      var i = 0;
      function next() {
        if (i >= THREE_SOURCES.length) { resolve(null); return; }
        var url = THREE_SOURCES[i++];
        var s = document.createElement("script");
        s.src = url;
        s.async = false;
        s.onload = function () { global.THREE ? resolve(global.THREE) : next(); };
        s.onerror = function () { next(); };
        document.head.appendChild(s);
      }
      next();
    });
    return threePromise;
  }

  /* ---------------- 小工具 ---------------- */

  function hash01(str, salt) {
    var h = 2166136261;
    var s = String(str) + "|" + (salt || 0);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return (h % 100000) / 100000;
  }

  function makeGlowTexture(THREE, inner, outer, size) {
    size = size || 128;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, inner);
    grd.addColorStop(0.28, outer);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function makeNebulaTexture(THREE, color) {
    var size = 256;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    g.clearRect(0, 0, size, size);
    var blobs = 14;
    for (var i = 0; i < blobs; i++) {
      var a = hash01("blob", i) * Math.PI * 2;
      var r = hash01("rad", i) * size * 0.28;
      var x = size / 2 + Math.cos(a) * r;
      var y = size / 2 + Math.sin(a) * r;
      var rad = size * (0.12 + hash01("sz", i) * 0.26);
      var grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, color + "aa");
      grd.addColorStop(0.45, color + "3a");
      grd.addColorStop(1, color + "00");
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    // 细丝
    g.globalCompositeOperation = "lighter";
    g.strokeStyle = color + "22";
    for (var j = 0; j < 10; j++) {
      g.beginPath();
      var ang = hash01("ang", j) * Math.PI * 2;
      var sx = size / 2 + (hash01("sx", j) - 0.5) * size * 0.4;
      var sy = size / 2 + (hash01("sy", j) - 0.5) * size * 0.4;
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(ang) * size * 0.4, sy + Math.sin(ang) * size * 0.4);
      g.stroke();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function makeTextTexture(THREE, text, color, scale) {
    scale = scale || 2;
    var fontPx = 26 * scale;
    var pad = 10 * scale;
    var c = document.createElement("canvas");
    var g = c.getContext("2d");
    g.font = "600 " + fontPx + "px 'JetBrains Mono', Consolas, monospace";
    var w = Math.ceil(g.measureText(text).width) + pad * 2;
    c.width = w;
    c.height = fontPx + pad * 2;
    g = c.getContext("2d");
    g.font = "600 " + fontPx + "px 'JetBrains Mono', Consolas, monospace";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 14;
    g.fillText(text, pad, c.height / 2);
    g.shadowBlur = 0;
    g.fillText(text, pad, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return { texture: tex, aspect: c.width / c.height };
  }

  function statusColor(status, pinned, THREE) {
    if (pinned) return new THREE.Color("#ffd76a");
    if (status === "active") return new THREE.Color("#6fe3ff");
    if (status === "faded") return new THREE.Color("#a78bfa");
    return new THREE.Color("#4d5f80");
  }

  var SCOPE_COLORS = ["#6fe3ff", "#ffd76a", "#a78bfa", "#6ee7a8", "#ff9ec4", "#8fd4ff", "#ffb35c", "#c8f06a"];

  /* ---------------- 基类：渲染器 / 相机 / 交互 ---------------- */

  function BaseScene(THREE, canvas, opts) {
    this.THREE = THREE;
    this.canvas = canvas;
    this.opts = opts || {};
    this.model = { stars: [], scopes: [], totals: {}, params: {} };
    this.pickables = [];
    this.clock = new THREE.Clock();
    this.running = false;
    this.hoverId = null;
    this.selectedId = null;
    this.fps = 0;
    this._frames = 0;
    this._fpsT = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x03060e, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x03060e, 0.018);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
    this.camera.position.set(0, 7.5, 30);
    this.camera.lookAt(0, 0, 0);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);

    this._bindInput();
    this.resize();
  }

  BaseScene.prototype._bindInput = function () {
    var self = this;
    var dragging = false;
    var lastX = 0, lastY = 0;

    this.canvas.addEventListener("pointerdown", function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      self.canvas.setPointerCapture && self.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", function (e) {
      var rect = self.canvas.getBoundingClientRect();
      self.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      self.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      self.onDrag(dx, dy);
    });
    this.canvas.addEventListener("pointerup", function (e) {
      dragging = false;
      if (Math.abs(e.clientX - lastX) < 4) self._click();
    });
    this.canvas.addEventListener("pointerleave", function () {
      self.pointer.set(-10, -10);
      dragging = false;
    });
    this.canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      self.onZoom(e.deltaY);
    }, { passive: false });
  };

  BaseScene.prototype.onDrag = function () {};
  BaseScene.prototype.onZoom = function (dy) {
    var cam = this.camera.position;
    var len = Math.sqrt(cam.x * cam.x + cam.y * cam.y + cam.z * cam.z);
    var next = Math.max(12, Math.min(80, len + dy * 0.02));
    cam.multiplyScalar(next / len);
  };

  BaseScene.prototype._click = function () {
    var hit = this._pick();
    if (hit && this.opts.onSelect) this.opts.onSelect(hit);
  };

  BaseScene.prototype._pick = function () {
    if (!this.pickables.length) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    var hits = this.raycaster.intersectObjects(this.pickables, false);
    return hits.length ? hits[0].object.userData.starId : null;
  };

  BaseScene.prototype.resize = function () {
    var w = this.canvas.clientWidth || this.canvas.parentNode.clientWidth || 800;
    var h = this.canvas.clientHeight || this.canvas.parentNode.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  BaseScene.prototype.setData = function (model) {
    this.model = model || this.model;
    this.build();
  };

  BaseScene.prototype.selectStar = function (id) {
    this.selectedId = id;
    this.onSelectChange();
  };

  BaseScene.prototype.onSelectChange = function () {};

  BaseScene.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    var self = this;
    var loop = function () {
      if (!self.running) return;
      self._raf = global.requestAnimationFrame(loop);
      var dt = Math.min(0.05, self.clock.getDelta());
      self._frames++;
      self._fpsT += dt;
      if (self._fpsT >= 0.5) {
        self.fps = Math.round(self._frames / self._fpsT);
        self._frames = 0;
        self._fpsT = 0;
        if (self.opts.onFps) self.opts.onFps(self.fps);
      }
      self.tick(dt);
      self.renderer.render(self.scene, self.camera);
    };
    this._raf = global.requestAnimationFrame(loop);
  };

  BaseScene.prototype.stop = function () {
    this.running = false;
    if (this._raf) global.cancelAnimationFrame(this._raf);
  };

  BaseScene.prototype.tick = function () {};

  BaseScene.prototype.dispose = function () {
    this.stop();
    this.scene.traverse(function (obj) {
      if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
      if (obj.material) {
        var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(function (m) {
          if (m.map && m.map.dispose) m.map.dispose();
          if (m.dispose) m.dispose();
        });
      }
    });
    this.root.clear();
    if (this.renderer.dispose) this.renderer.dispose();
  };

  /* ---------------- 场景一：神经星环 ---------------- */

  function NeuralScene(THREE, canvas, opts) {
    BaseScene.call(this, THREE, canvas, opts);
    this.ringRadius = 15.5;
    this.spin = 0.14;
    this.nodes = [];
    this.pulses = [];
    this.build();
  }
  NeuralScene.prototype = Object.create(BaseScene.prototype);
  NeuralScene.prototype.constructor = NeuralScene;

  NeuralScene.prototype.build = function () {
    var THREE = this.THREE;
    this.root.clear();
    this.pickables = [];
    this.nodes = [];
    this.pulses = [];

    var model = this.model;
    var stars = (model.stars || []).slice();
    var scopes = model.scopes || [];

    this.scene.fog.color.set(0x03060e);
    this.renderer.setClearColor(0x03060e, 1);

    /* --- 背景星尘 --- */
    var bgCount = 900;
    var bgPos = new Float32Array(bgCount * 3);
    for (var i = 0; i < bgCount; i++) {
      var r = 40 + hash01("bg", i) * 90;
      var th = hash01("bgt", i) * Math.PI * 2;
      var ph = Math.acos(2 * hash01("bgp", i) - 1);
      bgPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      bgPos[i * 3 + 1] = r * Math.cos(ph) * 0.5;
      bgPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    var bgGeo = new THREE.BufferGeometry();
    bgGeo.setAttribute("position", new THREE.BufferAttribute(bgPos, 3));
    this.root.add(new THREE.Points(bgGeo, new THREE.PointsMaterial({
      color: 0x6f8fc8, size: 0.32, sizeAttenuation: true,
      transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending
    })));

    /* --- 中心星核 --- */
    this.coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE, "rgba(150,225,255,0.95)", "rgba(60,120,255,0.28)"),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85
    }));
    this.coreGlow.scale.set(16, 16, 1);
    this.root.add(this.coreGlow);

    var ico = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.6, 1),
      new THREE.MeshBasicMaterial({ color: 0x2f6fd0, wireframe: true, transparent: true, opacity: 0.42 })
    );
    this.coreWire = ico;
    this.root.add(ico);

    /* --- 星团节点（按 scope 聚簇） --- */
    var glowTex = makeGlowTexture(THREE, "rgba(255,255,255,1)", "rgba(255,255,255,0.32)");
    var byScope = {};
    stars.forEach(function (s) { (byScope[s.scope] = byScope[s.scope] || []).push(s); });
    var scopeKeys = Object.keys(byScope);
    var self = this;

    scopeKeys.forEach(function (scope, si) {
      var list = byScope[scope];
      var color = new THREE.Color(SCOPE_COLORS[si % SCOPE_COLORS.length]);
      // 每个 scope 一个簇心，均匀分布在球壳上
      var theta = (si / Math.max(1, scopeKeys.length)) * Math.PI * 2;
      var phi = Math.acos(1 - 2 * ((si + 0.5) / Math.max(1, scopeKeys.length)));
      var center = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * 9.2,
        Math.cos(phi) * 6.4,
        Math.sin(phi) * Math.sin(theta) * 9.2
      );

      list.forEach(function (s, i) {
        var spr = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex,
          color: statusColor(s.status, s.pinned, THREE),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0.35 + 0.65 * (s.retention || 0)
        }));
        var jitter = 1.9 + hash01(s.id, 1) * 1.1;
        var ang = hash01(s.id, 2) * Math.PI * 2;
        var vAng = (hash01(s.id, 3) - 0.5) * Math.PI;
        spr.position.set(
          center.x + Math.cos(ang) * jitter * Math.cos(vAng),
          center.y + Math.sin(vAng) * jitter * 1.3,
          center.z + Math.sin(ang) * jitter * Math.cos(vAng)
        );
        var base = 0.7 + (s.importance || 0.4) * 2.4;
        spr.scale.set(base, base, 1);
        spr.userData.starId = s.id;
        spr.userData.baseScale = base;
        self.root.add(spr);
        self.pickables.push(spr);
        self.nodes.push({ sprite: spr, star: s, color: color, phase: hash01(s.id, 4) * 6.28 });
      });
    });

    /* --- 突触连线（同 scope 内就近相连） --- */
    var linePts = [];
    scopeKeys.forEach(function (scope) {
      var list = byScope[scope];
      for (var i = 0; i < list.length - 1; i++) {
        linePts.push(list[i].id, list[i + 1].id);
      }
    });
    var posById = {};
    this.nodes.forEach(function (n) { posById[n.star.id] = n.sprite.position; });

    var segs = [];
    linePts.forEach(function (id) {
      var p = posById[id];
      if (!p) return;
      segs.push(p.clone());
    });
    if (segs.length > 1) {
      var lgeo = new THREE.BufferGeometry().setFromPoints(segs);
      this.root.add(new THREE.Line(lgeo, new THREE.LineBasicMaterial({
        color: 0x3f6fb5, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending
      })));
    }

    /* --- 脉冲（沿连线来回） --- */
    var pulseMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE, "rgba(255,255,255,1)", "rgba(140,220,255,0.4)"),
      color: 0x9be8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true
    });
    var byId = {};
    this.nodes.forEach(function (n) { byId[n.star.id] = n; });
    var maxPulses = 34;
    for (var pi = 0; pi < maxPulses; pi++) {
      var a = this.nodes[(pi * 7) % Math.max(1, this.nodes.length)];
      var b = this.nodes[(pi * 7 + 3) % Math.max(1, this.nodes.length)];
      if (!a || !b || a === b) continue;
      var ps = new THREE.Sprite(pulseMat.clone());
      ps.scale.set(0.5, 0.5, 1);
      ps.userData = { a: a.sprite.position, b: b.sprite.position, t: hash01("p", pi), speed: 0.12 + hash01("ps", pi) * 0.2 };
      this.root.add(ps);
      this.pulses.push(ps);
    }

    /* --- HUD 星环：72 块 × 6 能量格 --- */
    this.buildRing(stars, scopeKeys, byScope);

    /* --- 星环外圈 --- */
    var ringGeo = new THREE.TorusGeometry(this.ringRadius, 0.06, 8, 220);
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0x2f5fa8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = Math.PI / 2;
    this.root.add(this.ring);
  };

  NeuralScene.prototype.buildRing = function (stars, scopeKeys, byScope) {
    var THREE = this.THREE;
    if (this.ringGroup) this.root.remove(this.ringGroup);
    this.ringGroup = new THREE.Group();
    this.ringGroup.rotation.x = -0.42;
    this.root.add(this.ringGroup);

    var BLOCKS = 72;
    var CELLS = 6;
    var R = this.ringRadius;
    var top = stars.slice().sort(function (a, b) {
      return (b.retention || 0) - (a.retention || 0);
    }).slice(0, BLOCKS);

    var blockGeo = new THREE.BoxGeometry(0.9, 0.16, 0.5);
    var blockMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false
    });
    var blocks = new THREE.InstancedMesh(blockGeo, blockMat, BLOCKS);
    blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    var cellGeo = new THREE.BoxGeometry(0.16, 0.16, 0.34);
    var cellMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false
    });
    var cells = new THREE.InstancedMesh(cellGeo, cellMat, BLOCKS * CELLS);
    cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    var dummy = new THREE.Object3D();
    var col = new THREE.Color();
    var scopeIndex = {};
    scopeKeys.forEach(function (s, i) { scopeIndex[s] = i; });

    for (var i = 0; i < BLOCKS; i++) {
      var ang = (i / BLOCKS) * Math.PI * 2;
      var x = Math.cos(ang) * R;
      var z = Math.sin(ang) * R;
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, -ang, 0);
      dummy.updateMatrix();
      blocks.setMatrixAt(i, dummy.matrix);

      var star = top[i];
      var scopeCol = new THREE.Color(SCOPE_COLORS[(scopeIndex[star ? star.scope : ""] || 0) % SCOPE_COLORS.length]);
      blocks.setColorAt(i, scopeCol);

      // 6 个能量格：保持率 / 清晰度 / 重要度 / 情绪浓烈 / 强化 / 召回
      var dims = star ? [
        star.retention || 0,
        star.clarity === "clear" ? 1 : star.clarity === "vague" ? 0.55 : star.clarity === "faint" ? 0.25 : 0.05,
        star.importance || 0,
        Math.min(1, Math.abs(star.valence || 0) + (star.arousal || 0) * 0.5),
        Math.min(1, (star.review_count || 0) / 8),
        Math.min(1, (star.recall_count || 0) / 30)
      ] : [0, 0, 0, 0, 0, 0];

      for (var c = 0; c < CELLS; c++) {
        var ci = i * CELLS + c;
        var v = dims[c] || 0;
        var h = 0.25 + v * 1.5;
        dummy.position.set(x, 0.22 + c * (h * 0.55), z);
        dummy.rotation.set(0, -ang, 0);
        dummy.scale.set(1, h, 1);
        dummy.updateMatrix();
        cells.setMatrixAt(ci, dummy.matrix);
        col.setHSL(0.52 - v * 0.42, 0.85, 0.35 + v * 0.3);
        cells.setColorAt(ci, col);
      }
    }
    blocks.instanceMatrix.needsUpdate = true;
    cells.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
    if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
    this.ringGroup.add(blocks);
    this.ringGroup.add(cells);
    this.ringBlocks = blocks;
    this.ringCells = cells;

    // 星域扇区标签
    var scopeTotals = {};
    (this.model.stars || []).forEach(function (s) {
      scopeTotals[s.scope] = (scopeTotals[s.scope] || 0) + 1;
    });
    var keys = Object.keys(scopeTotals);
    var self = this;
    keys.forEach(function (scope, si) {
      var ang = ((si + 0.5) / keys.length) * Math.PI * 2;
      var t = makeTextTexture(THREE, shortScope(scope), "#9fd8ff");
      var spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: t.texture, transparent: true, depthWrite: false, opacity: 0.85,
        blending: THREE.AdditiveBlending
      }));
      var h = 0.62;
      spr.scale.set(h * t.aspect, h, 1);
      spr.position.set(Math.cos(ang) * (R + 1.5), 0.6, Math.sin(ang) * (R + 1.5));
      self.ringGroup.add(spr);
    });
  };

  NeuralScene.prototype.onDrag = function (dx, dy) {
    this.root.rotation.y += dx * 0.004;
    this.root.rotation.x = Math.max(-0.6, Math.min(0.6, this.root.rotation.x + dy * 0.003));
  };

  NeuralScene.prototype.onSelectChange = function () {
    var self = this;
    this.nodes.forEach(function (n) {
      var sel = n.star.id === self.selectedId;
      var hover = n.star.id === self.hoverId;
      n.sprite.material.opacity = sel ? 1 : (hover ? 0.95 : 0.35 + 0.6 * (n.star.retention || 0));
      var b = n.sprite.userData.baseScale * (sel ? 1.55 : hover ? 1.25 : 1);
      n.sprite.scale.set(b, b, 1);
    });
  };

  NeuralScene.prototype.tick = function (dt) {
    var t = this.clock.getElapsedTime();
    this.spin += dt * 0.08;
    if (this.ringGroup) this.ringGroup.rotation.z = this.spin;
    if (this.coreWire) {
      this.coreWire.rotation.y += dt * 0.22;
      this.coreWire.rotation.x += dt * 0.09;
    }
    if (this.coreGlow) {
      var s = 15 + Math.sin(t * 1.1) * 1.6;
      this.coreGlow.scale.set(s, s, 1);
    }
    var self = this;
    this.nodes.forEach(function (n) {
      var base = n.sprite.userData.baseScale;
      var sel = n.star.id === self.selectedId;
      var k = base * (sel ? 1.55 : 1) * (1 + Math.sin(t * 1.6 + n.phase) * 0.07);
      n.sprite.scale.set(k, k, 1);
    });
    this.pulses.forEach(function (p) {
      var u = p.userData;
      u.t += dt * u.speed;
      if (u.t > 1) u.t -= 1;
      p.position.lerpVectors(u.a, u.b, u.t);
      var fade = Math.sin(u.t * Math.PI);
      p.material.opacity = 0.15 + fade * 0.75;
      var sc = 0.35 + fade * 0.5;
      p.scale.set(sc, sc, 1);
    });
    // 悬停拾取
    var hit = this._pick();
    if (hit !== this.hoverId) {
      this.hoverId = hit;
      this.onSelectChange();
      if (this.opts.onHover) this.opts.onHover(hit);
      this.canvas.style.cursor = hit ? "pointer" : "default";
    }
  };

  /* ---------------- 场景二：星核星云 ---------------- */

  function NebulaScene(THREE, canvas, opts) {
    BaseScene.call(this, THREE, canvas, opts);
    this.orbits = [];
    this.clouds = [];
    this.words = [];
    this.crawler = null;
    this.crawlerTarget = 0;
    this.crawlerT = 0;
    this.readIndex = 0;
    this.build();
  }
  NebulaScene.prototype = Object.create(BaseScene.prototype);
  NebulaScene.prototype.constructor = NebulaScene;

  NebulaScene.prototype.build = function () {
    var THREE = this.THREE;
    this.root.clear();
    this.pickables = [];
    this.clouds = [];
    this.words = [];
    this.orbits = [];

    this.scene.fog.color.set(0x060b16);
    this.renderer.setClearColor(0x060b16, 1);

    var model = this.model;
    var stars = model.stars || [];
    var scopes = model.scopes || [];

    /* --- 星云底纹 --- */
    var bgCount = 700;
    var bgPos = new Float32Array(bgCount * 3);
    for (var i = 0; i < bgCount; i++) {
      var r = 26 + hash01("nbg", i) * 70;
      var th = hash01("nbgt", i) * Math.PI * 2;
      bgPos[i * 3] = Math.cos(th) * r;
      bgPos[i * 3 + 1] = (hash01("nbgp", i) - 0.5) * 26;
      bgPos[i * 3 + 2] = Math.sin(th) * r;
    }
    var bgGeo = new THREE.BufferGeometry();
    bgGeo.setAttribute("position", new THREE.BufferAttribute(bgPos, 3));
    this.root.add(new THREE.Points(bgGeo, new THREE.PointsMaterial({
      color: 0xdfe9ff, size: 0.28, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending
    })));

    /* --- 中心丝带星核 --- */
    var curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 2.6, 0), new THREE.Vector3(1.5, 0.6, 0.6),
      new THREE.Vector3(0.4, -1.8, 1.4), new THREE.Vector3(-1.6, -0.6, 0.4),
      new THREE.Vector3(-0.6, 1.9, -1.1), new THREE.Vector3(0.9, 0.2, -0.9),
      new THREE.Vector3(0, 2.6, 0)
    ], true, "catmullrom", 0.5);
    var tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 180, 0.34, 12, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe0ee, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.coreRibbon = tube;
    this.root.add(tube);

    var coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE, "rgba(255,235,245,0.95)", "rgba(255,170,215,0.3)"),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9
    }));
    coreGlow.scale.set(13, 13, 1);
    this.root.add(coreGlow);
    this.nebulaCoreGlow = coreGlow;

    /* --- 三圈椭圆轨道 --- */
    var ringSpecs = [
      { r: 9.5, y: 2.6, tilt: 0.22, color: 0x7fc7ff },
      { r: 13.5, y: -1.2, tilt: -0.34, color: 0xffb0d4 },
      { r: 17.5, y: 3.4, tilt: 0.5, color: 0xcdb8ff }
    ];
    var self = this;
    ringSpecs.forEach(function (spec, i) {
      var pts = [];
      for (var a = 0; a <= 96; a++) {
        var ang = (a / 96) * Math.PI * 2;
        var x = Math.cos(ang) * spec.r;
        var z = Math.sin(ang) * spec.r * 0.78;
        var y = Math.sin(ang * 2) * 0.9;
        pts.push(new THREE.Vector3(x, y, z));
      }
      var geo = new THREE.BufferGeometry().setFromPoints(pts);
      var line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: spec.color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending
      }));
      line.position.y = spec.y;
      line.rotation.x = spec.tilt;
      self.root.add(line);
      self.orbits.push({ line: line, radius: spec.r, y: spec.y, tilt: spec.tilt, color: spec.color, phase: i * 2.1 });
    });

    /* --- 星云团（按 scope） --- */
    var byScope = {};
    stars.forEach(function (s) { (byScope[s.scope] = byScope[s.scope] || []).push(s); });
    var keys = Object.keys(byScope);
    var self = this;
    keys.forEach(function (scope, si) {
      var list = byScope[scope];
      var color = SCOPE_COLORS[si % SCOPE_COLORS.length];
      var tex = makeNebulaTexture(THREE, color);
      var orbit = self.orbits[si % self.orbits.length];
      var group = new THREE.Group();
      var puffCount = Math.min(9, 3 + Math.floor(list.length / 6));
      for (var p = 0; p < puffCount; p++) {
        var puff = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex, color: 0xffffff, transparent: true, opacity: 0.34,
          blending: THREE.AdditiveBlending, depthWrite: false, rotation: hash01("rot", p + si) * 6.28
        }));
        var sz = 6 + hash01("psz", p + si) * 6;
        puff.scale.set(sz, sz * (0.6 + hash01("pshape", p + si) * 0.5), 1);
        puff.position.set(
          (hash01("px", p + si) - 0.5) * 5,
          (hash01("py", p + si) - 0.5) * 3.4,
          (hash01("pz", p + si) - 0.5) * 5
        );
        group.add(puff);
      }
      // 记忆节点（可点选）
      var glowTex = makeGlowTexture(THREE, "rgba(255,255,255,1)", "rgba(255,255,255,0.3)");
      list.slice(0, 40).forEach(function (s, i) {
        var spr = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, color: statusColor(s.status, s.pinned, THREE),
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
          opacity: 0.4 + 0.55 * (s.retention || 0)
        }));
        var ang = (i / Math.max(1, Math.min(40, list.length))) * Math.PI * 2;
        var rad = 1.4 + hash01("mr", s.id) * 3.4;
        spr.position.set(Math.cos(ang) * rad, (hash01("my", s.id) - 0.5) * 2.8, Math.sin(ang) * rad);
        var base = 0.5 + (s.importance || 0.4) * 1.7;
        spr.scale.set(base, base, 1);
        spr.userData.starId = s.id;
        spr.userData.baseScale = base;
        group.add(spr);
        self.pickables.push(spr);
        self.clouds.push({ group: group, scope: scope, scopeColor: color, sprites: [] });
        self.clouds[self.clouds.length - 1].sprites.push(spr);
      });
      group.position.y = orbit.y;
      group.rotation.x = orbit.tilt;
      self.root.add(group);
      self.clouds.push({
        group: group, scope: scope, scopeColor: color, isScope: true,
        angle: hash01("sc", si) * Math.PI * 2, orbit: orbit, sprites: []
      });
    });

    /* --- 巡检蛛 --- */
    this.crawler = this.buildCrawler();
    this.root.add(this.crawler.group);

    this.onSelectChange();
  };

  NebulaScene.prototype.buildCrawler = function () {
    var THREE = this.THREE;
    var group = new THREE.Group();
    var body = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff0f6, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95 })
    );
    group.add(body);
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE, "rgba(255,240,250,0.9)", "rgba(255,160,210,0.32)"),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8
    }));
    halo.scale.set(3.4, 3.4, 1);
    group.add(halo);

    var legs = [];
    var legMat = new THREE.LineBasicMaterial({
      color: 0xffd8ea, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending
    });
    for (var i = 0; i < 8; i++) {
      var geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.9, -0.5, 0), new THREE.Vector3(1.6, -0.9, 0)
      ]);
      var leg = new THREE.Line(geo, legMat);
      var side = i < 4 ? 1 : -1;
      leg.userData = { side: side, phase: (i % 4) * 0.8 + (side < 0 ? 0.4 : 0) };
      leg.rotation.y = (i % 4) * Math.PI / 2;
      group.add(leg);
      legs.push(leg);
    }
    return { group: group, body: body, legs: legs, halo: halo };
  };

  NebulaScene.prototype.onDrag = function (dx, dy) {
    this.root.rotation.y += dx * 0.004;
    this.root.rotation.x = Math.max(-0.5, Math.min(0.5, this.root.rotation.x + dy * 0.003));
  };

  NebulaScene.prototype.onSelectChange = function () {
    var self = this;
    this.clouds.forEach(function (c) {
      if (!c.sprites) return;
      c.sprites.forEach(function (spr) {
        var sel = spr.userData.starId === self.selectedId;
        var base = spr.userData.baseScale;
        var k = base * (sel ? 1.7 : 1);
        spr.scale.set(k, k, 1);
        spr.material.opacity = sel ? 1 : 0.55;
      });
    });
  };

  NebulaScene.prototype.tick = function (dt) {
    var t = this.clock.getElapsedTime();
    var self = this;

    // 轨道公转
    this.orbits.forEach(function (o) {
      o.phase += dt * 0.06;
      o.line.rotation.z = o.phase * 0.2;
    });
    // 星云团公转
    this.clouds.forEach(function (c) {
      if (!c.isScope) return;
      c.angle += dt * (0.05 + (c.scope.length % 3) * 0.01);
      var r = c.orbit.radius;
      c.group.position.x = Math.cos(c.angle) * r * 0.55;
      c.group.position.z = Math.sin(c.angle) * r * 0.42;
      c.group.position.y = c.orbit.y + Math.sin(c.angle * 2) * 1.2;
      c.group.rotation.y += dt * 0.08;
    });

    // 星核脉动
    if (this.nebulaCoreGlow) {
      var s = 12 + Math.sin(t * 1.3) * 1.8;
      this.nebulaCoreGlow.scale.set(s, s, 1);
    }
    if (this.coreRibbon) {
      this.coreRibbon.rotation.y += dt * 0.16;
      this.coreRibbon.rotation.z = Math.sin(t * 0.4) * 0.12;
    }

    // 巡检蛛：绕着核心漂移，同时朝当前星云靠近
    if (this.crawler) {
      var cg = this.crawler.group;
      var target = this.clouds.filter(function (c) { return c.isScope; })[this.crawlerTarget];
      var tx = 0, ty = 0, tz = 0;
      if (target) { tx = target.group.position.x; ty = target.group.position.y; tz = target.group.position.z; }
      cg.position.x += (tx - cg.position.x) * Math.min(1, dt * 0.6);
      cg.position.y += (ty - cg.position.y) * Math.min(1, dt * 0.6);
      cg.position.z += (tz - cg.position.z) * Math.min(1, dt * 0.6);
      cg.position.y += Math.sin(t * 2.2) * 0.004;
      cg.rotation.y += dt * 0.9;
      this.crawler.legs.forEach(function (leg, i) {
        var u = leg.userData;
        leg.position.y = Math.sin(t * 6 + u.phase) * 0.12;
        leg.rotation.z = Math.sin(t * 6 + u.phase) * 0.16 * u.side;
      });
    }

    // 读词：每隔一段时间抛出一批词
    this._wordTimer = (this._wordTimer || 0) + dt;
    if (this._wordTimer > 0.55) {
      this._wordTimer = 0;
      this.emitWords();
    }

    // 词的飞行
    for (var i = this.words.length - 1; i >= 0; i--) {
      var w = this.words[i];
      w.t += dt * w.speed;
      if (w.t > 1) {
        this.root.remove(w.sprite);
        this.words.splice(i, 1);
        continue;
      }
      w.sprite.position.lerpVectors(w.from, w.to, w.t);
      w.sprite.material.opacity = 0.9 * (1 - Math.pow(w.t, 2.4));
    }

    var hit = this._pick();
    if (hit !== this.hoverId) {
      this.hoverId = hit;
      this.onSelectChange();
      if (this.opts.onHover) this.opts.onHover(hit);
      this.canvas.style.cursor = hit ? "pointer" : "default";
    }
  };

  NebulaScene.prototype.emitWords = function () {
    var THREE = this.THREE;
    var stars = this.model.stars || [];
    if (!stars.length) return;
    var scopeClouds = this.clouds.filter(function (c) { return c.isScope; });
    if (!scopeClouds.length) return;
    var cloud = scopeClouds[this.crawlerTarget % scopeClouds.length];
    var pool = stars.filter(function (s) { return s.scope === cloud.scope; });
    if (!pool.length) pool = stars;
    var star = pool[this.readIndex % pool.length];
    this.readIndex++;

    var words = (star.tags && star.tags.length ? star.tags : [star.content.slice(0, 6)]);
    var word = words[this.readIndex % words.length] || "记忆";
    var vague = star.clarity === "vague" || star.clarity === "faint";
    var color = vague ? 0xff8fa8 : (star.clarity === "clear" ? 0x9fe8ff : 0xcdb8ff);

    var spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE, "rgba(255,255,255,1)", "rgba(255,255,255,0.28)"),
      color: color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9
    }));
    var sz = 0.55 + (star.importance || 0.3) * 0.8;
    spr.scale.set(sz, sz, 1);
    var from = this.crawler ? this.crawler.group.position.clone() : new THREE.Vector3();
    var to = new THREE.Vector3(
      (hash01("wt", this.readIndex) - 0.5) * 18,
      (hash01("wy", this.readIndex) - 0.5) * 8,
      (hash01("wz", this.readIndex) - 0.5) * 10
    );
    spr.position.copy(from);
    this.root.add(spr);
    this.words.push({ sprite: spr, from: from, to: to, t: 0, speed: 0.45 + hash01("ws", this.readIndex) * 0.3 });

    // 巡检目标推进
    this.crawlerTarget = (this.crawlerTarget + 1) % scopeClouds.length;

    if (this.opts.onWord) {
      this.opts.onWord({
        word: word,
        vague: vague,
        starId: star.id,
        scope: star.scope,
        content: star.content,
        clarity: star.clarity
      });
    }
  };

  /* ---------------- 对外接口 ---------------- */

  function shortScope(scope) {
    var s = String(scope || "");
    if (s.indexOf("session:") === 0) s = s.slice(8);
    if (s.indexOf("user:") === 0) s = "用户 " + s.slice(5);
    if (s.indexOf("GroupMessage_") >= 0) s = s.replace(/^.*GroupMessage_/, "群 ");
    if (s.indexOf("FriendMessage_") >= 0) s = s.replace(/^.*FriendMessage_/, "私 ");
    if (s.length > 16) s = s.slice(0, 15) + "…";
    return s;
  }

  function create(theme, canvas, opts) {
    return loadThree().then(function (THREE) {
      if (!THREE) return null;
      try {
        if (theme === "nebula") return new NebulaScene(THREE, canvas, opts || {});
        return new NeuralScene(THREE, canvas, opts || {});
      } catch (err) {
        if (global.console) console.warn("[StarMemory] 3D 场景初始化失败:", err);
        return null;
      }
    });
  }

  global.StarScenes = {
    loadThree: loadThree,
    create: create,
    shortScope: shortScope,
    scopeColors: SCOPE_COLORS
  };
})(window);
