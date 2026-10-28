/* ============================================================
   咸鱼星空记忆 · 记忆观测台
   数据全部来自 AstrBot 插件桥接（16 条 WebAPI 路由），
   渲染成两款大屏主题：神经星环（neural）/ 星核星云（nebula）。
   ============================================================ */
(function () {
  "use strict";

  var PREFIX = "ui";
  var bridge = window.AstrBotPluginView || window.AstrBotPluginPage;
  var bridgeReady = false;

  var THEMES = {
    neural: {
      caption: "神经星环 · 记忆拓扑实时观测",
      kicker: "NEURAL RING",
      title: "神经星环"
    },
    nebula: {
      caption: "星核星云 · 逐字审读每一段记忆",
      kicker: "NEBULA CORE",
      title: "星核星云"
    }
  };

  var state = {
    theme: "neural",
    overview: null,
    stars: [],
    scopes: [],
    details: {},
    params: {},
    totals: {},
    selectedId: null,
    hoverId: null,
    fps: 0,
    scene: null,
    sceneReady: false,
    drawerOpen: false,
    starStatus: "all",
    page: 1,
    settingsLoaded: false,
    crawlLog: [],
    wordHeat: {},
    searchResults: []
  };

  /* ================= 基础工具 ================= */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c];
    });
  }

  function toast(msg, isErr) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("is-err", !!isErr);
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add("hidden"); }, 2600);
  }

  function apiGet(path, params) {
    if (!bridgeReady) {
      return Promise.reject(new Error("桥接未就绪：请从 AstrBot WebUI 插件详情页打开本页面"));
    }
    return bridge.apiGet(PREFIX + path, params || {});
  }

  function apiPost(path) {
    if (!bridgeReady) {
      return Promise.reject(new Error("桥接未就绪：请从 AstrBot WebUI 插件详情页打开本页面"));
    }
    return bridge.apiPost(PREFIX + path, {});
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function statusText(s) {
    return { active: "明亮", faded: "变暗", archived: "熄灭" }[s] || s;
  }

  function statusIcon(s, pinned) {
    if (pinned) return "📌";
    return { active: "★", faded: "✧", archived: "·" }[s] || "·";
  }

  function clarityText(c) {
    return { clear: "可靠记得", vague: "记忆模糊", faint: "几乎不记得", unknown: "无法回忆" }[c] || "无法回忆";
  }

  function clarityScore(c) {
    return { clear: 1, vague: 0.55, faint: 0.25, unknown: 0.05 }[c] || 0;
  }

  function shortScope(scope) {
    if (!scope) return "—";
    var s = String(scope);
    if (s.indexOf("session:") === 0) s = s.slice(8);
    if (s.indexOf("user:") === 0) s = "用户 " + s.slice(5);
    if (s.indexOf("GroupMessage_") >= 0) s = s.replace(/^.*GroupMessage_/, "群 ");
    if (s.indexOf("FriendMessage_") >= 0) s = s.replace(/^.*FriendMessage_/, "私 ");
    if (s.length > 22) s = s.slice(0, 21) + "…";
    return s;
  }

  function pct(v) { return Math.round((Number(v) || 0) * 100); }

  function panelHtml(title, note, body, bodyClass) {
    return (
      '<section class="panel">' +
      '<header class="panel-head"><span class="panel-title">' + esc(title) + "</span>" +
      '<span class="panel-note">' + esc(note || "") + "</span></header>" +
      '<div class="panel-body ' + (bodyClass || "") + '">' + body + "</div>" +
      "</section>"
    );
  }

  function kvRow(k, v) {
    return '<div class="kv-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
  }

  function bar(value, color) {
    var w = Math.max(0, Math.min(100, (Number(value) || 0) * 100));
    return '<div class="bar-track"><div class="bar-fill" style="width:' + w + "%" +
      (color ? ";background:" + color : "") + '"></div></div>';
  }

  /* ================= 数据加载 ================= */

  function loadOverview() {
    return apiGet("/overview").then(function (data) {
      state.overview = data || {};
      state.totals = (data && data.totals) || {};
      state.params = (data && data.params) || {};
      state.scopes = (data && data.scopes) || [];
      if (data && data.last_maintenance_day) {
        var el = $("last-maintained");
        if (el) el.textContent = "上次遗忘维护：" + data.last_maintenance_day;
      }
      return data;
    });
  }

  /** 拉取前若干页的星星，作为大屏的节点池（每页 20 条，最多 6 页 = 120 颗）。 */
  function loadStarPool() {
    var pool = [];
    var page = 1;
    var maxPages = 6;

    function step() {
      return apiGet("/stars/all/" + page).then(function (data) {
        var stars = (data && data.stars) || [];
        pool = pool.concat(stars);
        if (stars.length && data.has_more && page < maxPages) {
          page += 1;
          return step();
        }
        return pool;
      });
    }
    return step().then(function (stars) {
      state.stars = stars;
      return stars;
    });
  }

  /** 取若干颗"代表星"的详情（细节 / 情绪 / 关系 / 再激活），供面板使用。 */
  function loadFeaturedDetails() {
    var featured = state.stars.slice().sort(function (a, b) {
      return (b.retention || 0) + (b.pinned ? 1 : 0) - ((a.retention || 0) + (a.pinned ? 1 : 0));
    }).slice(0, 8);

    return Promise.all(featured.map(function (s) {
      return apiGet("/star/" + s.id).then(function (d) {
        state.details[s.id] = d;
      }).catch(function () { /* 单颗失败不影响整体 */ });
    }));
  }

  function refreshAll() {
    return loadOverview()
      .then(loadStarPool)
      .then(loadFeaturedDetails)
      .then(function () {
        renderAll();
        pushSceneData();
        // 3D 不可用时，列表内容要跟着数据一起补上
        if (!state.scene) renderFallbackChips();
      });
  }

  /* ================= 统计计算 ================= */

  function computeStats() {
    var stars = state.stars || [];
    var totals = { all: stars.length, active: 0, faded: 0, archived: 0, pinned: 0, clear: 0 };
    var retSum = 0, hlSum = 0, impSum = 0, emoSum = 0, ageSum = 0;
    var recall = 0, review = 0, react = 0, days = 0;
    var byType = {}, byScope = {}, precision = { exact: 0, day: 0, approximate: 0, unknown: 0 };
    var ageBuckets = [0, 0, 0, 0, 0];

    stars.forEach(function (s) {
      totals[s.status] = (totals[s.status] || 0) + 1;
      if (s.pinned) totals.pinned++;
      if (s.clarity === "clear") totals.clear++;
      retSum += s.retention || 0;
      hlSum += s.half_life_days || 0;
      impSum += s.importance || 0;
      emoSum += Math.min(1, Math.abs(s.valence || 0) + (s.arousal || 0) * 0.5);
      ageSum += s.days_since_anchor || 0;
      recall += s.recall_count || 0;
      review += s.review_count || 0;
      react += s.reactivate_count || 0;
      byType[s.type || "fact"] = (byType[s.type || "fact"] || 0) + 1;
      byScope[s.scope] = (byScope[s.scope] || 0) + 1;
      if (precision[s.event_time_precision] !== undefined) precision[s.event_time_precision]++;
      var d = s.days_since_anchor || 0;
      days++;
      if (d < 1) ageBuckets[0]++;
      else if (d < 3) ageBuckets[1]++;
      else if (d < 7) ageBuckets[2]++;
      else if (d < 30) ageBuckets[3]++;
      else ageBuckets[4]++;
    });

    var n = Math.max(1, stars.length);
    var avgRet = retSum / n;
    var avgAge = ageSum / n;

    // 七维质量：清晰度 / 保持率 / 重要度 / 情绪浓烈 / 时效性 / 细节完整度 / 关联密度
    var detailRatios = [];
    var linkCount = 0;
    Object.keys(state.details).forEach(function (id) {
      var d = state.details[id] || {};
      var ds = d.details || [];
      if (ds.length) {
        var ok = ds.filter(function (x) { return x.clarity === "clear"; }).length;
        detailRatios.push(ok / ds.length);
      }
      linkCount += (d.links || []).length;
    });
    var detailScore = detailRatios.length
      ? detailRatios.reduce(function (a, b) { return a + b; }, 0) / detailRatios.length
      : 0.5;
    var linkScore = Math.min(1, linkCount / Math.max(1, stars.length) * 6);
    var freshScore = Math.max(0, 1 - avgAge / 30);

    var axes = [
      { key: "清晰度", value: totals.clear / n },
      { key: "保持率", value: avgRet },
      { key: "重要度", value: impSum / n },
      { key: "情绪浓烈", value: emoSum / n },
      { key: "时效性", value: freshScore },
      { key: "细节完整", value: detailScore },
      { key: "关联密度", value: linkScore }
    ];
    var weights = [0.2, 0.2, 0.15, 0.1, 0.15, 0.12, 0.08];
    var score = axes.reduce(function (acc, ax, i) {
      return acc + ax.value * weights[i];
    }, 0) * 100;

    return {
      totals: totals,
      avgRetention: avgRet,
      avgHalfLife: hlSum / n,
      avgImportance: impSum / n,
      avgAge: avgAge,
      recall: recall,
      review: review,
      reactivate: react,
      byType: byType,
      byScope: byScope,
      precision: precision,
      ageBuckets: ageBuckets,
      axes: axes,
      score: score,
      detailScore: detailScore,
      linkCount: linkCount,
      scopeCount: (state.scopes || []).length
    };
  }

  /* ================= 渲染：顶部读数 ================= */

  function renderHUD() {
    var st = computeStats();
    var box = $("hud-metrics");
    if (!box) return;
    var metrics;

    if (state.theme === "neural") {
      metrics = [
        { k: "NEURONS 记忆节点", v: st.totals.all, c: "var(--accent)" },
        { k: "SECTORS 星域", v: st.scopeCount, c: "var(--accent-2)" },
        { k: "RETAIN 保持率", v: pct(st.avgRetention), u: "%", c: "var(--gold)" },
        { k: "CLARITY 清晰占比", v: pct(st.totals.clear / Math.max(1, st.totals.all)), u: "%", c: "var(--green)" },
        { k: "PULSES 召回脉冲", v: st.recall, c: "var(--violet)" },
        { k: "FPS 帧率", v: state.fps || "–", c: "var(--ink-1)" }
      ];
    } else {
      metrics = [
        { k: "CLOUDS 星云团", v: st.scopeCount, c: "var(--pink)" },
        { k: "STARS 记忆体", v: st.totals.all, c: "var(--accent)" },
        { k: "HEALTH 健康分", v: Math.round(st.score), c: "var(--gold)" },
        { k: "VAGUE 模糊记忆", v: st.totals.all - st.totals.clear, c: "var(--red)" },
        { k: "WORDS 读词", v: Object.keys(state.wordHeat).length, c: "var(--green)" },
        { k: "FPS 帧率", v: state.fps || "–", c: "var(--ink-1)" }
      ];
    }

    box.innerHTML = metrics.map(function (m) {
      return '<div class="metric" style="--mc:' + m.c + '">' +
        '<div class="m-val">' + m.v + (m.u ? "<small>" + m.u + "</small>" : "") + "</div>" +
        '<div class="m-key">' + esc(m.k) + "</div></div>";
    }).join("");
  }

  /* ================= 渲染：左栏 / 右栏 ================= */

  function renderRails() {
    var st = computeStats();
    var left = $("rail-left");
    var right = $("rail-right");
    if (!left || !right) return;

    if (state.theme === "neural") {
      left.innerHTML = renderNeuralLeft(st);
      right.innerHTML = renderNeuralRight(st);
    } else {
      left.innerHTML = renderNebulaLeft(st);
      right.innerHTML = renderNebulaRight(st);
    }
  }

  function scopeRows() {
    var scopes = state.scopes || [];
    var byScope = computeStats().byScope;
    return scopes.slice(0, 10).map(function (s, i) {
      var st = s.stats || {};
      var mood = s.mood || {};
      var color = (window.StarScenes && window.StarScenes.scopeColors[i % 8]) || "var(--accent)";
      var v = mood.valence || 0, a = mood.arousal || 0, f = mood.affection || 0;
      return '<div class="mini-item" data-scope="' + esc(s.scope) + '">' +
        '<span class="mi-dot" style="background:' + color + '"></span>' +
        '<span class="mi-text" title="' + esc(s.scope) + '">' + esc(shortScope(s.scope)) +
        " · " + (st.total || 0) + " 颗</span>" +
        '<span class="mi-time">v' + v.toFixed(2) + " a" + a.toFixed(2) + "</span></div>";
    }).join("");
  }

  function renderNeuralLeft(st) {
    var scopeBody = scopeRows() || '<div class="empty">还没有任何星域记录。</div>';
    var log = buildEventLog();
    return (
      panelHtml("SECTOR MAP · 星域扇区", st.scopeCount + " 个星域",
        '<div class="mini-list">' + scopeBody + "</div>" +
        '<div style="margin-top:8px">' +
        '<div class="kv-row"><span class="k">愉悦 valence</span><span class="v">' +
        bar((moodAvg("valence") + 1) / 2, "linear-gradient(90deg,#ff9ec4,#ffd76a)") +
        "</span></div>" +
        '<div class="kv-row"><span class="k">激动 arousal</span><span class="v">' +
        bar((moodAvg("arousal") + 1) / 2, "linear-gradient(90deg,#4d8cff,#6fe3ff)") + "</span></div>" +
        '<div class="kv-row"><span class="k">好感 affection</span><span class="v">' +
        bar((moodAvg("affection") + 1) / 2, "linear-gradient(90deg,#6ee7a8,#ffd76a)") + "</span></div>" +
        "</div>") +
      panelHtml("SYNAPSE LOG · 突触日志", "最近事件",
        '<div class="mini-list">' + (log || '<div class="empty">暂无事件。</div>') + "</div>")
    );
  }

  function moodAvg(axis) {
    var scopes = state.scopes || [];
    if (!scopes.length) return 0;
    var sum = 0;
    scopes.forEach(function (s) {
      sum += ((s.mood || {})[axis]) || 0;
    });
    return sum / scopes.length;
  }

  function buildEventLog() {
    var events = [];
    (state.stars || []).forEach(function (s) {
      if (s.last_reinforced_at) {
        events.push({ ts: s.last_reinforced_at, text: "强化 · " + shortScope(s.scope) + " · " + trunc(s.content, 18), color: "var(--gold)" });
      }
      (state.details[s.id] && state.details[s.id].reactivations || []).forEach(function (r) {
        events.push({ ts: r.ts, text: "再激活 · " + (r.trigger || "") + " · " + trunc(s.content, 14), color: "var(--violet)" });
      });
    });
    events.sort(function (a, b) { return b.ts - a.ts; });
    return events.slice(0, 12).map(function (e) {
      return '<div class="mini-item"><span class="mi-dot" style="background:' + e.color + '"></span>' +
        '<span class="mi-text">' + esc(e.text) + "</span>" +
        '<span class="mi-time">' + esc(fmtDate(e.ts).slice(5, 16)) + "</span></div>";
    }).join("");
  }

  function trunc(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function renderNeuralRight(st) {
    // 亮度热力：行 = 星域，列 = 该星域的星星（保持率决定亮度）
    var scopes = (state.scopes || []).slice(0, 8);
    var rows = scopes.map(function (s) {
      var list = (state.stars || []).filter(function (x) { return x.scope === s.scope; }).slice(0, 12);
      var cells = "";
      for (var i = 0; i < 12; i++) {
        var v = list[i] ? (list[i].retention || 0) : -1;
        var bg = v < 0 ? "rgba(255,255,255,.04)"
          : "rgba(" + Math.round(90 + v * 165) + "," + Math.round(200 - v * 60) + "," + Math.round(255 - v * 130) + "," + (0.25 + v * 0.75) + ")";
        cells += '<div class="heat-cell" style="background:' + bg + '" title="' +
          (list[i] ? esc(list[i].content) : "无") + '"></div>';
      }
      return '<div style="display:grid;grid-template-columns:58px 1fr;gap:6px;align-items:center">' +
        '<span style="font-size:9.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        esc(shortScope(s.scope)) + "</span>" +
        '<div class="heat-grid" style="--heat-cols:12">' + cells + "</div></div>";
    }).join("");

    var clarity = ["clear", "vague", "faint", "unknown"];
    var total = Math.max(1, st.totals.all);
    var inspect = clarity.map(function (c) {
      var n = (state.stars || []).filter(function (s) { return s.clarity === c; }).length;
      return kvRow(clarityText(c), n + " 颗 · " + pct(n / total) + "%");
    }).join("");

    return (
      panelHtml("BRIGHTNESS HEAT · 亮度热力", "按星域分组",
        '<div style="display:flex;flex-direction:column;gap:4px">' + (rows || '<div class="empty">暂无数据。</div>') + "</div>") +
      panelHtml("INSPECTION · 巡检统计", "记忆体检",
        '<div class="kv-list">' +
        kvRow("明亮 / 变暗 / 熄灭", st.totals.active + " / " + st.totals.faded + " / " + st.totals.archived) +
        kvRow("珍藏", st.totals.pinned + " 颗") +
        kvRow("平均半衰期", st.avgHalfLife.toFixed(2) + " 天") +
        kvRow("平均记忆年龄", st.avgAge.toFixed(1) + " 天") +
        inspect + "</div>")
    );
  }

  function renderNebulaLeft(st) {
    var logs = state.crawlLog.length ? state.crawlLog.slice(-14).reverse().map(function (e) {
      return '<div class="mini-item"><span class="mi-dot" style="background:' +
        (e.vague ? "var(--red)" : "var(--accent)") + '"></span>' +
        '<span class="mi-text" title="' + esc(e.content || "") + '">' +
        esc(e.vague ? "追问 · " + e.word : "读词 · " + e.word) + "</span>" +
        '<span class="mi-time">' + esc(e.scope ? shortScope(e.scope) : "") + "</span></div>";
    }).join("") : '<div class="empty">等待巡检蛛开始读词…</div>';

    return (
      panelHtml("CLOUD ATLAS · 星云目录", st.scopeCount + " 团星云",
        '<div class="mini-list">' + (scopeRows() || '<div class="empty">还没有任何星域记录。</div>') + "</div>") +
      panelHtml("CRAWL LOG · 巡检日志", "逐字审读",
        '<div class="mini-list">' + logs + "</div>")
    );
  }

  function renderNebulaRight(st) {
    var words = Object.keys(state.wordHeat).sort(function (a, b) {
      return state.wordHeat[b] - state.wordHeat[a];
    }).slice(0, 24);
    var maxHeat = Math.max.apply(null, words.map(function (w) { return state.wordHeat[w]; }).concat([1]));
    var wordBody = words.length
      ? '<div class="word-list">' + words.map(function (w) {
        var hot = state.wordHeat[w] / maxHeat > 0.6;
        return '<span class="word-chip' + (hot ? " hot" : "") + '">' + esc(w) +
          " ×" + state.wordHeat[w] + "</span>";
      }).join("") + "</div>"
      : '<div class="empty">等待读词…</div>';

    var selected = selectedStar();
    var mood = selected ? null : null;
    var core = state.scopes[0] ? (state.scopes[0].mood || {}) : {};

    return (
      panelHtml("WORD HEAT · 读词热力", Object.keys(state.wordHeat).length + " 个词",
        wordBody) +
      panelHtml("CORE STATE · 星核状态", selected ? "已选中" : "全局",
        '<div class="kv-list">' +
        kvRow("心绪 · 愉悦", (core.valence || 0).toFixed(2)) +
        kvRow("心绪 · 激动", (core.arousal || 0).toFixed(2)) +
        kvRow("心绪 · 好感", (core.affection || 0).toFixed(2)) +
        kvRow("心绪描述", esc(core.desc || "—")) +
        kvRow("健康分", Math.round(st.score) + " / 100") +
        (selected ? kvRow("当前记忆", esc(trunc(selected.content, 22))) : "") +
        "</div>")
    );
  }

  function selectedStar() {
    if (!state.selectedId) return null;
    for (var i = 0; i < (state.stars || []).length; i++) {
      if (state.stars[i].id === state.selectedId) return state.stars[i];
    }
    return null;
  }

  /* ================= 渲染：底部面板 ================= */

  function renderBottom() {
    var box = $("hud-bottom");
    if (!box) return;
    var st = computeStats();
    if (state.theme === "neural") {
      box.style.setProperty("--cols", 6);
      box.innerHTML = neuralBottom(st);
    } else {
      box.style.setProperty("--cols", 6);
      box.innerHTML = nebulaBottom(st);
    }
    // 画布类面板需要等插入后再绘制
    var radar = $("radar-canvas");
    if (radar) drawRadar(radar, st.axes);
    var gauge = $("gauge-canvas");
    if (gauge) drawGauge(gauge, st.score);
    // 打字机面板：面板被重建时保留已打出的内容，不要从头再来
    var code = $("code-box");
    if (code && state.theme === "nebula") {
      if (TYPER.timer) code.innerHTML = highlight(TYPER.text);
      else if (!TYPER.text) startTyping();
      else code.innerHTML = highlight(TYPER.text);
    }
  }

  function neuralBottom(st) {
    var total = Math.max(1, st.totals.all);
    var typeRows = Object.keys(st.byType).sort(function (a, b) {
      return st.byType[b] - st.byType[a];
    }).slice(0, 6).map(function (k) {
      return kvRow(k, st.byType[k] + " 颗 · " + pct(st.byType[k] / total) + "%");
    }).join("");

    var ageRows = ["< 1 天", "1–3 天", "3–7 天", "7–30 天", "> 30 天"].map(function (label, i) {
      return kvRow(label, st.ageBuckets[i] + " 颗");
    }).join("");

    var prec = Object.keys(st.precision).map(function (k) {
      return kvRow(k, st.precision[k] + " 颗");
    }).join("");

    var recent = (state.stars || []).slice().sort(function (a, b) {
      return (b.event_time || b.created_at || 0) - (a.event_time || a.created_at || 0);
    }).slice(0, 5).map(function (s) {
      return '<div class="mini-item"><span class="mi-dot" style="background:var(--accent)"></span>' +
        '<span class="mi-text" title="' + esc(s.content) + '">' + esc(trunc(s.content, 20)) + "</span>" +
        '<span class="mi-time">' + esc(s.event_time_label || "时间不详") + "</span></div>";
    }).join("");

    return (
      panelHtml("TOPOLOGY · 拓扑规模", st.scopeCount + " 域",
        '<div class="kv-list">' +
        kvRow("记忆节点", st.totals.all + " 颗") +
        kvRow("关系连线", st.linkCount + " 条") +
        kvRow("记忆类型", Object.keys(st.byType).length + " 种") +
        typeRows + "</div>") +

      panelHtml("PULSE RATE · 脉冲频率", "召回 / 强化",
        '<div class="kv-list">' +
        kvRow("召回次数合计", st.recall + " 次") +
        kvRow("有效强化", st.review + " 次") +
        kvRow("再激活", st.reactivate + " 次") +
        kvRow("每星平均召回", (st.recall / total).toFixed(1) + " 次") +
        kvRow("星域覆盖", st.scopeCount + " 个星域") +
        "</div>") +

      panelHtml("RECALL GATE · 召回闸门", "阈值",
        '<div class="kv-list">' +
        kvRow("注入最低分", state.params.min_score != null ? state.params.min_score : "—") +
        kvRow("可靠阈值", state.params.clear_threshold != null ? state.params.clear_threshold : "—") +
        kvRow("模糊阈值", state.params.vague_threshold != null ? state.params.vague_threshold : "—") +
        kvRow("可见记忆", pct(st.totals.active / total) + "% 的星星仍明亮") +
        kvRow("可回忆", pct(st.totals.clear / total) + "% 可靠") +
        "</div>") +

      panelHtml("FORGETTING · 遗忘曲线", "半衰期",
        '<div class="kv-list">' +
        kvRow("基准半衰期", (state.params.base_half_life_days || "—") + " 天") +
        kvRow("平均半衰期", st.avgHalfLife.toFixed(2) + " 天") +
        kvRow("细节比例", state.params.detail_half_life_ratio != null ? state.params.detail_half_life_ratio : "—") +
        kvRow("平均保持率", pct(st.avgRetention) + "%") +
        kvRow("平均记忆年龄", st.avgAge.toFixed(1) + " 天") +
        "</div>") +

      panelHtml("AGE PROFILE · 年龄分布", "锚点距今",
        '<div class="kv-list">' + ageRows + "</div>") +

      panelHtml("EVENT TIME · 事件时间", "精度分布",
        '<div class="kv-list">' + prec + "</div>" +
        '<div class="mini-list" style="margin-top:6px">' + (recent || "") + "</div>")
    );
  }

  function nebulaBottom(st) {
    var sections = Object.keys(st.byType).sort(function (a, b) {
      return st.byType[b] - st.byType[a];
    }).map(function (k) {
      return '<div class="mini-item"><span class="mi-dot" style="background:var(--pink)"></span>' +
        '<span class="mi-text">' + esc(k) + " 章节</span>" +
        '<span class="mi-time">' + st.byType[k] + " 段</span></div>";
    }).join("");

    var steps = ["读取分区", "逐字抽取", "模糊标记", "向星核追问", "归档评分"];
    var stepHtml = '<div class="step-row">' + steps.map(function (s, i) {
      var cls = i < 3 ? "is-done" : (i === 3 ? "is-on" : "");
      return '<span class="step-chip ' + cls + '">' + esc(s) + "</span>" +
        (i < steps.length - 1 ? '<span class="step-arrow">›</span>' : "");
    }).join("") + "</div>";

    var words = Object.keys(state.wordHeat).sort(function (a, b) {
      return state.wordHeat[b] - state.wordHeat[a];
    }).slice(0, 20);
    var wordBody = words.length
      ? '<div class="word-list">' + words.map(function (w) {
        return '<span class="word-chip' + (state.wordHeat[w] > 1 ? " hot" : "") + '">' + esc(w) + "</span>";
      }).join("") + "</div>"
      : '<div class="empty">等待读词…</div>';

    return (
      panelHtml("SECTIONS · 章节", Object.keys(st.byType).length + " 类",
        '<div class="mini-list">' + (sections || '<div class="empty">暂无章节。</div>') + "</div>") +

      panelHtml("SPEC RADAR · 质量雷达", "七维",
        '<div class="radar-wrap"><canvas id="radar-canvas" width="264" height="264"></canvas>' +
        '<div class="radar-legend">' + st.axes.map(function (ax, i) {
          return '<div><i style="background:hsl(' + (200 - i * 26) + ',80%,62%)"></i>' + esc(ax.key) +
            " " + pct(ax.value) + "%</div>";
        }).join("") + "</div></div>") +

      panelHtml("WORD HEAT · 读词热力", Object.keys(state.wordHeat).length + " 词",
        wordBody) +

      panelHtml("SPEC SCORE · 记忆评分", "综合",
        '<div class="gauge-wrap"><canvas id="gauge-canvas" width="216" height="216"></canvas>' +
        '<div class="gauge-side"><div class="gauge-score">' + Math.round(st.score) + "</div>" +
        '<div class="gauge-note">' + (st.score >= 80 ? "记忆质量优秀" : st.score >= 60 ? "记忆质量一般" : "记忆正在淡去") +
        "</div><div style=\"margin-top:6px\">" + stepHtml + "</div></div></div>") +

      panelHtml("CRAWLER.PY · 审查脚本", "展示用",
        '<div class="code-box" id="code-box"></div>') +

      panelHtml("TELEMETRY · 遥测", "实时",
        '<div class="kv-list">' +
        kvRow("星云团", st.scopeCount + " 团") +
        kvRow("记忆体", st.totals.all + " 颗") +
        kvRow("读词计数", Object.keys(state.wordHeat).length) +
        kvRow("模糊记忆", (st.totals.all - st.totals.clear) + " 颗") +
        kvRow("帧率", (state.fps || "–") + " FPS") +
        kvRow("健康分", Math.round(st.score) + " / 100") +
        "</div>")
    );
  }

  /* ================= 画布：雷达 / 仪表 ================= */

  function drawRadar(canvas, axes) {
    if (!canvas || !axes) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;
    ctx.clearRect(0, 0, w, h);

    var rings = 4;
    for (var r = rings; r >= 1; r--) {
      ctx.beginPath();
      for (var i = 0; i < axes.length; i++) {
        var ang = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
        var x = cx + Math.cos(ang) * R * (r / rings);
        var y = cy + Math.sin(ang) * R * (r / rings);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(140,180,255,.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (var j = 0; j < axes.length; j++) {
      var a2 = -Math.PI / 2 + (j / axes.length) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a2) * R, cy + Math.sin(a2) * R);
      ctx.strokeStyle = "rgba(140,180,255,.12)";
      ctx.stroke();
    }
    ctx.beginPath();
    for (var k = 0; k < axes.length; k++) {
      var ang3 = -Math.PI / 2 + (k / axes.length) * Math.PI * 2;
      var v = Math.max(0.02, axes[k].value);
      var x2 = cx + Math.cos(ang3) * R * v;
      var y2 = cy + Math.sin(ang3) * R * v;
      k ? ctx.lineTo(x2, y2) : ctx.moveTo(x2, y2);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(94,231,255,.22)";
    ctx.fill();
    ctx.strokeStyle = "#5ee7ff";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.font = "11px 'JetBrains Mono', Consolas, monospace";
    ctx.fillStyle = "rgba(200,220,255,.75)";
    for (var m = 0; m < axes.length; m++) {
      var ang4 = -Math.PI / 2 + (m / axes.length) * Math.PI * 2;
      var lx = cx + Math.cos(ang4) * (R + 16);
      var ly = cy + Math.sin(ang4) * (R + 14);
      ctx.textAlign = Math.abs(lx - cx) < 6 ? "center" : (lx > cx ? "left" : "right");
      ctx.textBaseline = "middle";
      ctx.fillText(axes[m].key, lx, ly);
    }
  }

  function drawGauge(canvas, score) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.38;
    var start = Math.PI * 0.75, end = Math.PI * 2.25;
    ctx.clearRect(0, 0, w, h);

    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    ctx.strokeStyle = "rgba(140,180,255,.14)";
    ctx.stroke();

    var v = Math.max(0, Math.min(100, score)) / 100;
    var grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#ffd76a");
    grad.addColorStop(1, "#5ee7ff");
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, start + (end - start) * v);
    ctx.strokeStyle = grad;
    ctx.shadowColor = "rgba(94,231,255,.5)";
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e9f1ff";
    ctx.font = "700 26px 'JetBrains Mono', Consolas, monospace";
    ctx.fillText(Math.round(score), cx, cy - 4);
    ctx.fillStyle = "rgba(140,170,220,.85)";
    ctx.font = "10px 'JetBrains Mono', Consolas, monospace";
    ctx.fillText("MEMORY SCORE", cx, cy + 16);
  }

  /* ================= 代码面板（打字机） ================= */

  var TYPER = { timer: null, idx: 0, text: "" };

  function codeLines() {
    var scope = (state.scopes[0] && state.scopes[0].scope) || "session";
    var st = computeStats();
    return [
      "# CRAWLER.PY · 记忆审读脚本（仅展示，不在插件内执行）",
      "def crawl(scope: str = " + JSON.stringify(scope) + "):",
      "    stars = recall(scope, top_k=32)          # 取回候选记忆",
      "    for star in stars:",
      "        for word in star.words:",
      "            if word.clarity < VAGUE:        # 0.20",
      "                ask_core(star, word)       # 模糊词 → 向星核追问",
      "            else:",
      "                link(star, word)          # 可靠词 → 挂进章节",
      "    return score = %.1f" % st.score,
    ];
  }

  function startTyping() {
    var lines = codeLines();
    var full = lines.join("\n");
    if (TYPER.timer) clearInterval(TYPER.timer);
    TYPER.idx = 0;
    TYPER.text = "";
    TYPER.timer = setInterval(function () {
      var box = $("code-box");
      if (!box) { clearInterval(TYPER.timer); TYPER.timer = null; return; }
      TYPER.idx += 1;
      if (TYPER.idx >= full.length) {
        clearInterval(TYPER.timer);
        TYPER.timer = null;
        TYPER.text = full;
        box.innerHTML = highlight(full);
        return;
      }
      TYPER.text = full.slice(0, TYPER.idx);
      box.innerHTML = highlight(TYPER.text);
    }, 22);
  }

  function highlight(text) {
    var lines = text.split("\n");
    var out = lines.map(function (ln, i) {
      var isLast = i === lines.length - 1;
      var cls = "";
      var html = esc(ln);
      if (/^\s*#/.test(ln)) cls = "c-cm";
      else if (/^\s*def /.test(ln)) cls = "c-key";
      else if (/"[^"]*"/.test(ln)) cls = "c-str";
      if (isLast && TYPER.timer) cls += " c-cur";
      return '<span class="' + cls + '">' + (html || " ") + "</span>";
    }).join("\n");
    return out;
  }

  /* ================= 场景 ================= */

  function pushSceneData() {
    if (!state.scene) return;
    state.scene.setData({
      stars: state.stars,
      scopes: state.scopes,
      totals: state.totals,
      params: state.params
    });
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.body.setAttribute("data-theme", theme);
    try { localStorage.setItem("bsm-console-theme", theme); } catch (e) { /* 忽略 */ }

    var meta = THEMES[theme];
    $("theme-caption").textContent = meta.caption;
    $("stage-kicker").textContent = meta.kicker;
    $("stage-title").textContent = meta.title;

    if (state.scene) {
      state.scene.dispose();
      state.scene = null;
    }
    state.sceneReady = false;
    $("stage-fallback").classList.add("hidden");
    var stageEl = $("stage-wrap");
    if (stageEl) stageEl.classList.remove("is-fallback");
    // 换主题时重置打字机
    if (TYPER.timer) { clearInterval(TYPER.timer); TYPER.timer = null; }
    TYPER.text = "";

    var canvas = $("stage");
    if (window.StarScenes) {
      window.StarScenes.create(theme, canvas, {
        onSelect: function (id) { selectStar(id); },
        onHover: function (id) { hoverStar(id); },
        onWord: function (evt) { onWord(evt); },
        onFps: function (fps) { state.fps = fps; renderHUD(); }
      }).then(function (scene) {
        if (!scene) {
          state.scene = null;
          showFallback();
          return;
        }
        state.scene = scene;
        state.sceneReady = true;
        pushSceneData();
        scene.start();
        setStageStatus("星域拓扑已建立", "ok");
      });
    } else {
      showFallback();
    }
    renderAll();
  }

  function showFallback() {
    var fb = $("stage-fallback");
    if (fb) fb.classList.remove("hidden");
    var stage = $("stage-wrap");
    if (stage) stage.classList.add("is-fallback");
    setStageStatus("3D 不可用（仅数据面板）", "warn");
    renderFallbackChips();
  }

  function renderFallbackChips() {
    var box = $("fallback-stars");
    if (!box) return;
    box.innerHTML = (state.stars || []).slice(0, 24).map(function (s) {
      return '<span class="fallback-chip" title="' + esc(s.content) + '">' +
        esc(statusIcon(s.status, s.pinned) + " " + trunc(s.content, 16)) + "</span>";
    }).join("");
  }

  function setStageStatus(text, kind) {
    var t = $("stage-status-text");
    var d = $("stage-dot");
    if (t) t.textContent = text;
    if (d) {
      d.className = "stage-dot" + (kind === "warn" ? " is-warn" : kind === "bad" ? " is-bad" : "");
    }
  }

  function selectStar(id) {
    state.selectedId = id;
    if (state.scene) state.scene.selectStar(id);
    updateReadout();
    renderHUD();
    renderRails();
  }

  function hoverStar(id) {
    state.hoverId = id;
    updateReadout();
  }

  function updateReadout() {
    var el = $("stage-readout");
    if (!el) return;
    var s = null;
    var stars = state.stars || [];
    for (var i = 0; i < stars.length; i++) {
      if (stars[i].id === (state.hoverId || state.selectedId)) { s = stars[i]; break; }
    }
    if (!s) {
      el.textContent = "悬停节点查看记忆\n点击查看详情";
      return;
    }
    el.textContent = "#" + s.id + " · " + statusText(s.status) + " · 保持率 " + pct(s.retention) + "%\n" +
      clarityText(s.clarity) + " · 半衰期 " + s.half_life_days + " 天 · " + (s.event_time_label || "时间不详");
  }

  function onWord(evt) {
    if (!evt) return;
    state.wordHeat[evt.word] = (state.wordHeat[evt.word] || 0) + 1;
    state.crawlLog.push({
      word: evt.word,
      vague: !!evt.vague,
      scope: evt.scope,
      content: evt.content,
      starId: evt.starId
    });
    if (state.crawlLog.length > 200) state.crawlLog.shift();
    if (state.theme === "nebula") {
      renderHUD();
      renderRails();
      renderBottom();
    }
  }

  /* ================= 渲染入口 ================= */

  function renderAll() {
    renderHUD();
    renderRails();
    renderBottom();
    renderLegend();
    updateReadout();
    if (state.theme === "nebula" && !TYPER.timer) startTyping();
  }

  function renderLegend() {
    var box = $("stage-legend");
    if (!box) return;
    var items = state.theme === "neural"
      ? [["var(--accent)", "明亮"], ["var(--violet)", "变暗"], ["var(--ink-2)", "熄灭"], ["var(--gold)", "珍藏"]]
      : [["var(--accent)", "可靠"], ["var(--violet)", "模糊"], ["var(--red)", "需追问"], ["var(--pink)", "星核"]];
    box.innerHTML = items.map(function (it) {
      return '<span class="legend-item" style="color:' + it[1] + '">' +
        '<i class="legend-swatch" style="color:' + it[0] + ';background:' + it[0] + '"></i>' + esc(it[1]) + "</span>";
    }).join("");
  }

  /* ================= 调试台抽屉 ================= */

  function openDrawer() {
    state.drawerOpen = true;
    $("drawer").classList.add("is-open");
    $("drawer").setAttribute("aria-hidden", "false");
    // 首次打开时把当前标签页的数据拉起来
    var active = document.querySelector(".drawer-tab.is-active");
    switchDrawerTab(active ? active.dataset.dtab : "stars");
  }

  function closeDrawer() {
    state.drawerOpen = false;
    $("drawer").classList.remove("is-open");
    $("drawer").setAttribute("aria-hidden", "true");
  }

  function toggleDrawer() {
    state.drawerOpen ? closeDrawer() : openDrawer();
  }

  function switchDrawerTab(tab) {
    document.querySelectorAll(".drawer-tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.dtab === tab);
    });
    document.querySelectorAll(".dpane").forEach(function (p) {
      p.classList.toggle("is-active", p.dataset.dpane === tab);
    });
    if (tab === "settings") loadSettings(true);
    if (tab === "stars") loadStars();
    if (tab === "scopes") loadScopes();
  }

  /* ---------- 星星列表 ---------- */

  function loadStars() {
    var list = $("star-list");
    if (!list) return Promise.resolve();
    list.innerHTML = '<div class="empty">加载中……</div>';
    return apiGet("/stars/" + encodeURIComponent(state.starStatus) + "/" + state.page)
      .then(function (data) {
        var stars = (data && data.stars) || [];
        if (!stars.length) {
          list.innerHTML = '<div class="empty">这片星域空空如也——去聊几轮天，等星星凝成吧。</div>';
        } else {
          list.innerHTML = stars.map(renderStarCard).join("");
          bindStarActions(list);
        }
        $("page-indicator").textContent = "第 " + ((data && data.page) || 1) + " 页";
        $("btn-prev").disabled = ((data && data.page) || 1) <= 1;
        $("btn-next").disabled = !(data && data.has_more);
      })
      .catch(function (e) { list.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }

  function renderStarCard(s) {
    var badges =
      '<span class="badge b-' + esc(s.status) + '">' + statusText(s.status) + "</span>" +
      (s.pinned ? '<span class="badge b-pinned">珍藏</span>' : "") +
      '<span class="badge">重要度 ' + Math.round((s.importance || 0) * 100) + "%</span>" +
      '<span class="badge">强化 ' + (s.review_count || 0) + " 次</span>" +
      '<span class="badge">半衰期 ' + (s.half_life_days || 0) + " 天</span>" +
      '<span class="badge b-clarity-' + esc(s.clarity || "unknown") + '">' + clarityText(s.clarity) + "</span>" +
      (s.corrected ? '<span class="badge b-warn">已被纠正</span>' : "");
    var tags = (s.tags || []).map(function (t) { return "#" + esc(t); }).join(" ");
    var actions = [];
    if (!s.pinned) actions.push('<button class="mini-btn warn" data-act="pin" data-id="' + s.id + '">📌 珍藏</button>');
    else actions.push('<button class="mini-btn" data-act="unpin" data-id="' + s.id + '">取消珍藏</button>');
    if (s.status !== "active") actions.push('<button class="mini-btn good" data-act="revive" data-id="' + s.id + '">✦ 重新点亮</button>');
    if (s.status !== "archived") actions.push('<button class="mini-btn danger" data-act="forget" data-id="' + s.id + '">🌙 熄灭</button>');
    actions.push('<button class="mini-btn danger" data-act="delete" data-id="' + s.id + '">删除</button>');

    return (
      '<div class="star-card" data-id="' + s.id + '">' +
      '<div class="star-icon">' + statusIcon(s.status, s.pinned) + "</div>" +
      '<div class="star-main">' +
      '<div class="star-content">' + esc(s.content) + "</div>" +
      '<div class="star-meta">' + badges +
      (tags ? '<span class="badge">' + tags + "</span>" : "") +
      '<span class="badge">' + esc(shortScope(s.scope)) + "</span>" +
      '<span class="badge">发生于 ' + esc(s.event_time_label || "时间不详") + "</span>" +
      "</div>" +
      '<div class="brightness"><i style="width:' + pct(s.retention) + '%"></i></div>' +
      "</div>" +
      '<div class="star-actions"><button class="mini-btn" data-act="detail" data-id="' + s.id + '">详情</button>' +
      '<div class="row-actions">' + actions.join("") + "</div></div>" +
      "</div>"
    );
  }

  // 两步确认：沙箱 iframe 里 window.confirm 会被浏览器静默屏蔽，必须页内实现
  function confirmTwice(btn, question, fn) {
    if (btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      btn.textContent = btn.dataset.label || "删除";
      fn();
      return;
    }
    btn.dataset.armed = "1";
    btn.dataset.label = btn.textContent;
    btn.textContent = question;
    setTimeout(function () {
      if (btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.textContent = btn.dataset.label || btn.textContent;
      }
    }, 4000);
  }

  function starAction(act, id, refresh, btn) {
    if (act === "detail") return openDetail(id);
    if (act === "delete") {
      confirmTwice(btn, "确认删除?", function () {
        apiPost("/star/" + id + "/delete")
          .then(function () { toast("已删除 ✓"); refreshAll(); })
          .catch(function (e) { toast(e.message, true); });
      });
      return;
    }
    apiPost("/star/" + id + "/" + act)
      .then(function (data) {
        toast(data.message || "完成 ✓");
        refreshAll();
      })
      .catch(function (e) { toast(e.message, true); });
  }

  function bindStarActions(root) {
    root.querySelectorAll("button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        starAction(btn.dataset.act, btn.dataset.id, loadStars, btn);
      });
    });
  }

  /* ---------- 详情 ---------- */

  function openDetail(id) {
    apiGet("/star/" + id).then(function (s) {
      var d = s.debug || {};
      var body =
        '<h2>' + statusIcon(s.status, s.pinned) + " 星星 #" + s.id + "</h2>" +
        '<p class="modal-body-text">' + esc(s.content) + "</p>" +
        '<div class="kv">' +
        kv("状态", statusText(s.status) + (s.pinned ? " · 📌珍藏" : "") + " · 亮度 " + pct(s.retention) + "%") +
        kv("回忆清晰度", clarityText(s.clarity)) +
        kv("会话", esc(s.scope)) +
        kv("标签", (s.tags || []).map(esc).join("、") || "—") +
        kv("类型 / 重要度", esc(s.type) + " · " + Math.round((s.importance || 0) * 100) + "%") +
        kv("情绪印记（原始）", (s.valence >= 0 ? "愉快 +" : "低落 ") + Math.abs(s.valence).toFixed(2) +
          " · 激动 " + (s.arousal || 0).toFixed(2)) +
        kv("事件发生时间", esc(s.event_time_label || "时间不详") +
          (s.event_time_precision ? "（精度：" + esc(s.event_time_precision) + "）" : "")) +
        kv("记录写入时间", fmtDate(s.created_at)) +
        kv("上次有效强化", (s.last_reinforced_at ? fmtDate(s.last_reinforced_at) : "从未") +
          "（距锚点 " + (s.days_since_anchor || 0) + " 天）") +
        kv("强化 / 检索 / 再激活", (s.review_count || 0) + " / " + (s.recall_count || 0) + " / " + (s.reactivate_count || 0) + " 次") +
        kv("记忆半衰期 H_m", (s.half_life_days || 0) + " 天") +
        "</div>";

      var details = s.details || [];
      if (details.length) {
        body += '<div class="debugbox"><b>细节（各自独立遗忘）</b><br>' +
          details.map(function (x) {
            return "↳ [" + clarityText(x.clarity) + "] " + esc(x.text) +
              "（半衰期 " + (x.half_life_days || 0) + " 天 · 保持率 " + pct(x.retention) + "%）";
          }).join("<br>") + "</div>";
      }
      var emotions = s.emotions || [];
      if (emotions.length) {
        body += '<div class="debugbox"><b>情绪残留（独立半衰期）</b><br>' +
          emotions.map(function (x) {
            return "↳ " + esc(x.label) + "：原始 " + (x.original || 0).toFixed(2) +
              " → 残留 " + (x.residual || 0).toFixed(3) +
              "（半衰期 " + (x.half_life_days || 0) + " 天）";
          }).join("<br>") + "</div>";
      }
      var links = s.links || [];
      if (links.length) {
        body += '<div class="debugbox"><b>与其它星星的关系</b><br>' +
          links.map(function (x) {
            return "↳ " + esc(x.relation) + (x.reason ? "：" + esc(x.reason) : "");
          }).join("<br>") + "</div>";
      }
      var reacts = s.reactivations || [];
      if (reacts.length) {
        body += '<div class="debugbox"><b>重新激活记录</b><br>' +
          reacts.map(function (x) {
            return "↳ " + fmtDate(x.ts) + " · " + esc(x.trigger || "") +
              "（得分 " + (x.score || 0).toFixed(3) + "）";
          }).join("<br>") + "</div>";
      }

      body += '<div class="debugbox"><b>遗忘曲线调试</b><br>' +
        esc(d.retention_formula || "") + "<br>" +
        "锚点：" + esc(d.anchor || "—") + "；半衰期 " + (d.half_life_days || "—") +
        " 天；R 低于 " + d.will_fade_at_r + " 变暗、低于 " + d.will_archive_at_r + " 熄灭归档；" +
        "可靠阈值 " + (d.clear_threshold || "—") + "、模糊阈值 " + (d.vague_threshold || "—") +
        "；此刻被真正想起可把半衰期提到 " + (d.half_life_after_recall || "—") + " 天。" +
        "</div>";

      $("modal-body").innerHTML = body;
      $("modal").classList.remove("hidden");
    }).catch(function (e) { toast(e.message, true); });
  }

  function kv(k, v) {
    return '<span class="k">' + esc(k) + '</span><span class="v">' + v + "</span>";
  }

  /* ---------- 检索调试 ---------- */

  function doSearch() {
    var input = $("search-input");
    var q = (input.value || "").trim().replace(/[/\\]/g, " ");
    var box = $("search-results");
    if (!q) { toast("请输入检索词", true); return; }
    box.innerHTML = '<div class="empty">检索中……</div>';
    apiGet("/search/" + encodeURIComponent(q)).then(function (data) {
      var rs = (data && data.results) || [];
      state.searchResults = rs;
      if (!rs.length) {
        box.innerHTML = '<div class="empty">没有任何星星亮起——连放宽阈值的调试检索都没命中。</div>';
        return;
      }
      box.innerHTML = rs.map(function (s) {
        var badges =
          '<span class="badge b-score">得分 ' + (s.score || 0) + "</span>" +
          '<span class="badge b-match">' + esc(s.matched_by || "hybrid") + "</span>" +
          (s.glimmer ? '<span class="badge b-pinned">✧ 灵光一现</span>' : "") +
          '<span class="badge b-' + esc(s.status) + '">' + statusText(s.status) + "</span>";
        return (
          '<div class="star-card" data-id="' + s.id + '">' +
          '<div class="star-icon">' + statusIcon(s.status, s.pinned) + "</div>" +
          '<div class="star-main">' +
          '<div class="star-content">' + esc(s.content) + "</div>" +
          '<div class="star-meta">' + badges +
          '<span class="badge">' + esc(shortScope(s.scope)) + "</span></div>" +
          '<div class="brightness"><i style="width:' + pct(s.retention) + '%"></i></div>' +
          "</div>" +
          '<div class="star-actions"><button class="mini-btn" data-act="detail" data-id="' + s.id + '">详情</button></div>' +
          "</div>"
        );
      }).join("");
      bindStarActions(box);
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
    });
  }

  /* ---------- 星域与凝星 ---------- */

  function loadScopes() {
    var box = $("scope-list");
    if (!box) return Promise.resolve();
    box.innerHTML = '<div class="empty">加载中……</div>';
    return apiGet("/overview").then(function (data) {
      var scopes = (data && data.scopes) || [];
      if (!scopes.length) {
        box.innerHTML = '<div class="empty">还没有任何星域记录。</div>';
        return;
      }
      box.innerHTML = scopes.map(function (s) {
        var mood = s.mood || {};
        var st = s.stats || {};
        return (
          '<div class="scope-card">' +
          "<div><div class=\"scope-name\">" + esc(s.scope) + "</div>" +
          '<div class="scope-sub">星星 ' + (st.total || 0) + "（明亮 " + (st.active || 0) + " / 变暗 " + (st.faded || 0) + " / 熄灭 " + (st.archived || 0) + "）</div>" +
          '<div class="mood-bar">' +
          '<span class="m">愉悦 ' + bar10(mood.valence) + "</span>" +
          '<span class="m">激动 ' + bar10(mood.arousal) + "</span>" +
          '<span class="m">好感 ' + bar10(mood.affection) + "</span>" +
          "</div></div>" +
          '<button class="mini-btn" data-scope="' + esc(s.scope) + '">✧ 立即凝星</button>' +
          "</div>"
        );
      }).join("");
      box.querySelectorAll("button[data-scope]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var scope = btn.dataset.scope;
          btn.disabled = true;
          btn.textContent = "凝星中……";
          apiPost("/consolidate/" + encodeURIComponent(scope))
            .then(function (data) {
              var added = (data && data.added) || [];
              toast("凝星完成：新增 " + added.length + " 颗，复习 " +
                ((data && data.reinforced) || []).length + " 颗，合并 " + ((data && data.merged) || 0) + " 颗" +
                (data && data.mood_changed ? "，心绪已更新" : ""));
              refreshAll();
            })
            .catch(function (e) {
              toast(e.message, true);
              btn.disabled = false;
              btn.textContent = "✧ 立即凝星";
            });
        });
      });
    }).catch(function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }

  function bar10(v) {
    v = Number(v) || 0;
    var n = Math.round(Math.abs(v) * 10);
    var sign = v < 0 ? "-" : "";
    var s = "";
    for (var i = 0; i < 10; i++) s += i < n ? "●" : "○";
    return sign + s;
  }

  /* ---------- 设置页 ---------- */

  var PROVIDER_FIELD_MAP = { "llm.provider_id": "llm", "embedding.provider_id": "embedding" };

  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(String(str))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function loadSettings(force) {
    if (state.settingsLoaded && !force) return;
    state.settingsLoaded = true;
    var loader = $("settings-loading");
    var box = $("settings-list");
    if (loader) loader.style.display = "";
    if (box) box.innerHTML = "";
    apiGet("/settings").then(function (data) {
      if (loader) loader.style.display = "none";
      var sections = (data && data.sections) || [];
      if (!sections.length) {
        if (box) box.innerHTML = '<div class="empty">没有可配置的项。</div>';
        return;
      }
      if (box) {
        box.innerHTML = sections.map(function (sec) {
          return renderSettingsSection(sec, (data && data.providers) || {});
        }).join("");
        bindSettingsEvents(box, (data && data.providers) || {});
      }
    }).catch(function (e) {
      if (loader) loader.style.display = "none";
      state.settingsLoaded = false;
      if (box) box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
    });
  }

  function renderSettingsSection(sec, providers) {
    var rows = sec.fields.map(function (f) { return renderField(sec, f, providers); }).join("");
    return (
      '<div class="settings-card" data-section="' + esc(sec.name) + '">' +
      '<div class="settings-head"><span class="settings-title">' + esc(sec.title) + "</span>" +
      '<button class="mini-btn" data-reset="' + esc(sec.name) + '">恢复默认</button></div>' +
      rows + "</div>"
    );
  }

  function renderField(sec, f, providers) {
    var id = "f-" + sec.name + "-" + f.key;
    var control = "";
    var provKey = PROVIDER_FIELD_MAP[f.path];
    var value = f.value == null ? "" : f.value;

    if (provKey) {
      var list = providers[provKey] || [];
      var defaultId = providers[provKey === "llm" ? "default_llm" : "default_embedding"] || "";
      var opts = ['<option value="">（默认）跟随 AstrBot 当前选择</option>'];
      var found = String(value) === "";
      list.forEach(function (p) {
        var pid = String(p.id);
        if (pid === String(value)) found = true;
        var tags = [];
        if (p.model) tags.push(p.model);
        if (p.type) tags.push(p.type);
        var label = pid + (tags.length ? " · " + tags.join(" · ") : "");
        if (pid === defaultId) label += "（当前默认）";
        opts.push('<option value="' + esc(pid) + '"' + (pid === String(value) ? " selected" : "") +
          ' title="' + esc(pid) + '">' + esc(label) + "</option>");
      });
      if (!found && value !== "") {
        opts.push('<option value="' + esc(value) + '" selected>' + esc(value) + "（当前配置）</option>");
      }
      control = '<select id="' + id + '" data-field="' + esc(f.key) + '" data-section="' + esc(sec.name) + '">' + opts.join("") + "</select>";
      if (!list.length) {
        control += '<div class="field-hint">没有列出任何提供商：请先在 AstrBot「提供商设置」里添加并启用模型，' +
          "然后点右上角刷新。留空则始终跟随 AstrBot 当前选择。</div>";
      }
    } else if (f.options && f.options.length) {
      control = '<select id="' + id + '" data-field="' + esc(f.key) + '" data-section="' + esc(sec.name) + '">' +
        f.options.map(function (o) {
          return '<option value="' + esc(o) + '"' + (o === String(value) ? " selected" : "") + ">" + esc(o) + "</option>";
        }).join("") + "</select>";
    } else if (f.type === "bool") {
      control = '<label class="switch"><input type="checkbox" id="' + id + '" data-field="' + esc(f.key) +
        '" data-section="' + esc(sec.name) + '"' + (value ? " checked" : "") + "><i></i></label>";
    } else if (f.type === "int" || f.type === "float") {
      var step = f.type === "int" ? 1 : 0.05;
      var extra = "";
      if (f.slider) {
        extra = ' min="' + f.slider.min + '" max="' + f.slider.max + '" step="' + (f.slider.step || step) + '"';
      }
      control = '<input type="number" id="' + id + '" data-field="' + esc(f.key) + '" data-section="' + esc(sec.name) +
        '" value="' + esc(value) + '"' + extra + ">";
    } else {
      control = '<input type="text" id="' + id + '" data-field="' + esc(f.key) + '" data-section="' + esc(sec.name) +
        '" value="' + esc(value) + '" placeholder="留空使用默认">';
    }
    return (
      '<div class="field-row" id="row-' + id + '">' +
      '<div class="field-info"><div class="field-desc">' + esc(f.desc) + "</div>" +
      (f.hint ? '<div class="field-hint">' + esc(f.hint) + "</div>" : "") + "</div>" +
      '<div class="field-ctl">' + control + '<span class="saved-mark hidden">已保存 ✓</span></div>' +
      "</div>"
    );
  }

  function bindSettingsEvents(box, providers) {
    box.querySelectorAll("select[data-field], input[type=number][data-field], input[type=text][data-field]").forEach(function (el) {
      el.addEventListener("change", function () { saveSetting(el); });
    });
    box.querySelectorAll("input[type=checkbox][data-field]").forEach(function (el) {
      el.addEventListener("change", function () {
        saveSetting(el, el.checked ? "true" : "false");
      });
    });
    box.querySelectorAll("button[data-reset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var section = btn.dataset.reset;
        confirmTwice(btn, "全部恢复默认?", function () {
          apiPost("/settings/reset/" + section).then(function (d) {
            toast(d.note || "已恢复默认");
            state.settingsLoaded = false;
            loadSettings(true);
          }).catch(function (e) { toast(e.message, true); });
        });
      });
    });
  }

  function saveSetting(el, forcedValue) {
    var section = el.dataset.section;
    var key = el.dataset.field;
    var raw = forcedValue !== undefined ? forcedValue : el.value;
    var row = $("row-f-" + section + "-" + key);
    var mark = row ? row.querySelector(".saved-mark") : null;
    if (mark) mark.classList.add("hidden");
    apiPost("/settings/set/" + section + "/" + key + "/" + b64urlEncode(raw)).then(function (d) {
      toast(d.note || "已保存并生效");
      if (mark) {
        mark.classList.remove("hidden");
        setTimeout(function () { mark.classList.add("hidden"); }, 2200);
      }
    }).catch(function (e) {
      toast(e.message, true);
      state.settingsLoaded = false;
    });
  }

  /* ---------- 全局操作 ---------- */

  function maintain() {
    var btn = $("btn-maintain");
    btn.disabled = true;
    btn.textContent = "维护中…";
    apiPost("/maintain").then(function (data) {
      toast("遗忘维护完成：推进 " + data.scopes + " 个星域，变化 " + data.changed +
        "，熄灭 " + data.archived + "，清理 " + data.purged);
      refreshAll();
    }).catch(function (e) { toast(e.message, true); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "🌙 维护";
      });
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    $("btn-theme").addEventListener("click", function () {
      applyTheme(state.theme === "neural" ? "nebula" : "neural");
    });
    $("btn-console").addEventListener("click", toggleDrawer);
    $("btn-refresh").addEventListener("click", function () {
      refreshAll().catch(function (e) { toast(e.message, true); });
    });
    $("btn-maintain").addEventListener("click", maintain);
    $("btn-full").addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    });

    document.querySelectorAll(".drawer-tab").forEach(function (tab) {
      tab.addEventListener("click", function () { switchDrawerTab(tab.dataset.dtab); });
    });
    $("drawer-close").addEventListener("click", closeDrawer);

    document.querySelectorAll("#status-chips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        document.querySelectorAll("#status-chips .chip").forEach(function (c) { c.classList.remove("is-active"); });
        chip.classList.add("is-active");
        state.starStatus = chip.dataset.status;
        state.page = 1;
        loadStars();
      });
    });

    $("btn-prev").addEventListener("click", function () { state.page--; loadStars(); });
    $("btn-next").addEventListener("click", function () { state.page++; loadStars(); });
    $("btn-search").addEventListener("click", doSearch);
    $("search-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSearch();
    });
    $("modal-close").addEventListener("click", function () {
      $("modal").classList.add("hidden");
    });
    $("modal").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
    });

    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var k = (e.key || "").toLowerCase();
      if (k === "t") { applyTheme(state.theme === "neural" ? "nebula" : "neural"); }
      else if (k === "d") { toggleDrawer(); }
      else if (k === "r") { refreshAll().catch(function (err) { toast(err.message, true); }); }
      else if (k === "f") { $("btn-full").click(); }
      else if (k === "escape") {
        $("modal").classList.add("hidden");
        if (state.drawerOpen) closeDrawer();
      }
    });

    window.addEventListener("resize", function () {
      if (state.scene) state.scene.resize();
    });
  }

  /* ================= 启动 ================= */

  // 调试句柄：便于在浏览器控制台里观察运行状态（只读，不影响插件行为）
  window.__BSM_STATE__ = state;

  function setBridgeState(cls, text, showWarn) {
    var el = $("bridge-status");
    if (el) { el.className = "bridge-pill " + cls; el.textContent = text; }
    var warn = $("bridge-warn");
    if (warn) warn.classList.toggle("hidden", !showWarn);
  }

  function boot() {
    bindEvents();
    var saved = null;
    try { saved = localStorage.getItem("bsm-console-theme"); } catch (e) { /* 忽略 */ }
    var hash = (location.hash || "").replace("#", "");
    applyTheme(hash === "nebula" ? "nebula" : hash === "neural" ? "neural" : (saved === "nebula" ? "nebula" : "neural"));
    refreshAll().catch(function (e) {
      setStageStatus("数据加载失败：" + e.message, "bad");
      toast(e.message, true);
    });
  }

  if (!bridge || typeof bridge.ready !== "function") {
    setBridgeState("is-bad", "桥接未就绪", true);
    boot();
  } else {
    var handshake = Promise.race([
      bridge.ready(),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("桥接超时（6 秒内未收到面板响应）")); }, 6000);
      })
    ]);
    handshake.then(function () {
      bridgeReady = true;
      setBridgeState("is-ok", "桥接就绪", false);
      boot();
    }).catch(function (e) {
      setBridgeState("is-bad", "桥接超时", true);
      boot();
      console.warn("[StarMemory] 桥接握手失败:", e);
    });
  }
})();
