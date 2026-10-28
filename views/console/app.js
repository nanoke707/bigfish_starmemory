/* ============================================================
   咸鱼星空记忆 · 神经星环观测台
   ------------------------------------------------------------
   大屏：agent-display「03 · NEURAL 神经星环」原版移植
         （PolyForm Noncommercial 1.0.0 · Copyright (c) 2026 赛博老爸）
         主题代码结构原样保留，只把「智能体/工作流/渠道」换成
         「星域/记忆类型/记忆状态」，数据全部来自本插件真实接口。
   数据：插件的 16 条 WebAPI 路由（overview / stars / star / search /
         scopes / 维护 / 凝星 / 设置 …），后端零改动。
   ============================================================ */
(function () {
  "use strict";

  var PREFIX = "ui";
  var bridge = window.AstrBotPluginView || window.AstrBotPluginPage;
  var bridgeReady = false;

  // 设置页里哪些字段是"提供商下拉框"
  var PROVIDER_FIELD_MAP = { "llm.provider_id": "llm", "embedding.provider_id": "embedding" };

  // 记忆类型的中文名（跟 core/models.py 的 VALID_MEMORY_TYPES 对齐）
  var TYPE_ZH = {
    fact: "事实", event: "经历", preference: "偏好", promise: "约定",
    emotion: "情绪", skill: "技能", commitment: "约定", insight: "灵光",
    task: "待办", person: "人物", profile: "画像", other: "其他"
  };

  // 页面级异常兜底：出错时在界面上直接说清楚，而不是白屏
  window.addEventListener("error", function (e) {
    console.error("[StarMemory] 脚本异常:", e.message, (e.filename || "") + ":" + (e.lineno || 0));
    try {
      var t = document.getElementById("toast");
      if (t) {
        t.textContent = "脚本异常：" + e.message;
        t.classList.add("is-err");
        t.classList.remove("hidden");
      }
    } catch (x) { /* 连提示框都没有就算了 */ }
  });

  var state = {
    overview: null,
    stars: [],
    scopes: [],
    details: {},
    params: {},
    totals: {},
    selectedId: null,
    hoverId: null,
    drawerOpen: false,
    starStatus: "all",
    page: 1,
    settingsLoaded: false,
    botName: "",
    searchResults: [],
    host: null,
    shadow: null,
    themeReady: false
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


  /* ================= 神经星环主题：挂载与数据对接 ================= */

  function mountTheme() {
    var host = $("host-neural");
    var tpl = $("tpl-neural");
    if (!host || !tpl || !window.BSMNeural) return null;
    var SR = host.attachShadow({ mode: "open" });
    SR.appendChild(tpl.content.cloneNode(true));
    state.host = host;
    state.shadow = SR;

    var go = function () {
      try {
        window.BSMNeural.mount(host, SR);
        state.themeReady = true;
        // 主题里点星星 → 打开调试台的完整详情
        host.__nr = host.__nr || {};
        host.__nr.openDetail = function (id) { openDetail(id); };
        // 点恒星上的名字 → 去设置里改 bot 名字
        host.__nr.openBotSettings = function () {
          openDrawer();
          switchDrawerTab("settings");
          setTimeout(function () {
            var f = document.querySelector('[data-field="bot_name"]');
            if (f) f.focus();
          }, 350);
        };
        bindThemeButtons(SR);
        if (state.overview) pushModel();
      } catch (e) {
        console.error("[StarMemory] 神经星环挂载失败:", e);
        toast("大屏挂载失败：" + e.message, true);
      }
    };
    if (!window.THREE) {
      window.BSMNeural.loadScripts(window.BSMNeural.deps).then(go, go);
    } else {
      go();
    }
    return host;
  }

  /** 主题工具条上挂插件自己的动作 */
  function bindThemeButtons(SR) {
    var tools = SR.querySelector(".tools");
    if (tools) {
      var mk = function (label, title, fn) {
        var b = document.createElement("button");
        b.className = "tb";
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", fn);
        tools.insertBefore(b, tools.firstChild);
      };
      mk("维护", "立即执行遗忘维护", maintain);
      mk("刷新", "重新拉取数据（快捷键 R）", function () {
        refreshAll().catch(function (e) { toast(e.message, true); });
      });
    }
    SR.querySelectorAll("[data-series-pick]").forEach(function (b) {
      b.textContent = "调试台";
      b.title = "打开调试台（快捷键 D）";
      b.addEventListener("click", function () { openDrawer(); });
    });
  }

  /** 星域的短代号：群→GRP / 用户→USR / 私→PVT / 全局→GLB，同类再加序号 */
  function shortCode(scope, i) {
    var s = shortScope(scope).replace(/\s+/g, "");
    var kind = null;
    if (/^群/.test(s)) kind = "GRP";
    else if (/^用户/.test(s)) kind = "USR";
    else if (/^私/.test(s)) kind = "PVT";
    else if (/^(GLO|global)/i.test(s)) kind = "GLB";
    if (kind) {
      var seen = 0;
      for (var k = 0; k < i; k++) {
        if (shortCodeKind(shortScope((state.scopes || [])[k] && (state.scopes || [])[k].scope)) === kind) seen++;
      }
      return seen ? kind + (seen + 1) : kind;
    }
    var cjk = s.match(/[\u4e00-\u9fa5]+/g);
    if (cjk && cjk.length) return cjk.join("").slice(0, 2);
    var alnum = s.replace(/[^0-9A-Za-z]/g, "").slice(0, 3).toUpperCase();
    return alnum || ("S" + String(i + 1).padStart(2, "0"));
  }

  function shortCodeKind(scope) {
    var s = shortScope(scope).replace(/\s+/g, "");
    if (/^群/.test(s)) return "GRP";
    if (/^用户/.test(s)) return "USR";
    if (/^私/.test(s)) return "PVT";
    if (/^(GLO|global)/i.test(s)) return "GLB";
    return "OTH";
  }

  function scopeIndexOf(scope) {
    var list = state.scopes || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].scope === scope) return i;
    }
    return 0;
  }

  function countToday() {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
    var n = 0;
    (state.stars || []).forEach(function (s) {
      if (!s.event_time) return;
      var dt = new Date(s.event_time * 1000);
      if (dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d) n++;
    });
    return n;
  }

  function moodAverage() {
    var vs = 0, as = 0, n = 0;
    (state.scopes || []).forEach(function (s) {
      var m = s.mood || {};
      if (m.valence == null) return;
      vs += m.valence || 0; as += m.arousal || 0; n++;
    });
    return n ? { valence: vs / n, arousal: as / n } : { valence: 0, arousal: 0 };
  }

  function buildEvents() {
    var evs = [];
    var scopes = state.scopes || [];
    scopes.slice(0, 3).forEach(function (s, i) {
      var st = s.stats || {};
      if ((st.archived || 0) > 0) {
        evs.push({ scopeIndex: i, verb: "归档", text: shortScope(s.scope) + " 有 " + st.archived + " 颗星熄灯", kind: "bad" });
      } else if ((st.faded || 0) > 0) {
        evs.push({ scopeIndex: i, verb: "变暗", text: shortScope(s.scope) + " 有 " + st.faded + " 颗星开始变暗", kind: "" });
      }
    });
    var day = (state.overview && state.overview.last_maintenance_day) || "";
    var now = new Date();
    var today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    if (day === today) {
      evs.push({ scopeIndex: 0, verb: "维护", text: "今天的遗忘维护已经跑过一轮", kind: "ship" });
    }
    (state.stars || []).slice(0, 3).forEach(function (s) {
      evs.push({ scopeIndex: scopeIndexOf(s.scope), verb: "新星", text: String(s.content || "").slice(0, 22), kind: "" });
    });
    return evs;
  }

  /** 把插件数据整理成主题认识的模型 */
  function buildModel() {
    var st = computeStats();
    // 星域按星星数量排序，环上只放得下 11 个，其余的折叠起来
    var ranked = (state.scopes || []).slice().sort(function (a, b) {
      return ((b.stats || {}).total || 0) - ((a.stats || {}).total || 0);
    });
    var rank = {};
    ranked.forEach(function (s, i) { rank[s.scope] = i; });
    var scopes = ranked.slice(0, 11).map(function (s, i) {
      var ss = s.stats || {};
      return {
        scope: shortScope(s.scope),
        short: shortCode(s.scope, i),
        total: ss.total || 0,
        active: ss.active || 0,
        faded: ss.faded || 0,
        archived: ss.archived || 0,
        pinned: ss.pinned || 0,
        recalls: 0,
        valence: (s.mood || {}).valence,
        arousal: (s.mood || {}).arousal
      };
    });

    var stars = (state.stars || [])
      .filter(function (s) { return rank[s.scope] != null && rank[s.scope] < 11; })
      .map(function (s) {
        return {
          id: s.id,
          content: s.content,
          scope: s.scope,
          scopeShort: shortScope(s.scope),
          type: s.type || "fact",
          typeZh: TYPE_ZH[s.type || "fact"] || s.type || "其他",
          status: s.status,
          retention: s.retention || 0,
          clarity: clarityScore(s.clarity),
          importance: s.importance || 0,
          valence: s.valence || 0,
          arousal: s.arousal || 0,
          pinned: !!s.pinned,
          review: Math.min(1, (s.review_count || 0) / 8),
          scopeIndex: rank[s.scope],
          // 恒星与黑洞主题要用的细节
          halfLife: s.half_life_days || 0,
          recallCount: s.recall_count || 0,
          reviewCount: s.review_count || 0,
          reactivateCount: s.reactivate_count || 0,
          daysSince: s.days_since_anchor || 0,
          eventTime: s.event_time_label || "时间不详",
          anchor: s.anchor || "",
          tags: (s.tags || []).slice(0, 6)
        };
      });

    var byType = {};
    stars.forEach(function (s) {
      (byType[s.type] = byType[s.type] || []).push(s);
    });
    var types = Object.keys(byType).map(function (k, i) {
      var list = byType[k];
      // 这个类型整体偏"暗"还是偏"亮"，决定它落到哪个状态环
      var act = 0, fad = 0, arc = 0, pin = 0;
      list.forEach(function (x) {
        if (x.status === "active") act++;
        else if (x.status === "faded") fad++;
        else if (x.status === "archived") arc++;
        if (x.pinned) pin++;
      });
      var ch = 0;
      if (arc > 0 && arc >= fad) ch = 2;
      else if (fad > 0 && fad >= act) ch = 1;
      else if (pin > 0 && pin >= act) ch = 3;
      return {
        key: k,
        count: list.length,
        scopeIndex: list[0].scopeIndex,
        ch: ch,
        faded: ch === 1 || ch === 2,
        names: list.slice(0, 8).map(function (x) { return String(x.content || "").slice(0, 20); })
      };
    });

    var mood = moodAverage();
    return {
      scopes: scopes,
      stars: stars,
      types: types,
      totals: state.totals || {},
      scopeCount: scopes.length,
      extraScopes: Math.max(0, ranked.length - 11),
      avgRetention: st.avgRetention,
      recallCount: st.recall,
      archiveCount: (state.totals || {}).archived || 0,
      todayNew: countToday(),
      emotionEnergy: Math.round((st.axes[3] ? st.axes[3].value : 0) * 10000),
      mood: mood,
      events: buildEvents(),
      dayTarget: 30,
      botName: state.botName || "大肥鱼",
      recallRate: Math.max(1, Math.round((st.recall || 0) / 60))
    };
  }

  function pushModel() {
    if (state.host && state.host.__nr && state.host.__nr.setModel) {
      state.host.__nr.setModel(buildModel());
    }
    // 主题里点星星 → 打开调试台的完整详情
    if (state.host && state.host.__nr && !state.host.__nr.openDetail) {
      state.host.__nr.openDetail = function (id) { openDetail(id); };
    }
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


  function refreshAll() {
    return loadOverview()
      .then(loadStarPool)
      .then(loadFeaturedDetails)
      .then(loadBotName)
      .then(function () {
        pushModel();
      });
  }

  // 恒星的名字：general.bot_name（后端本来就有这个配置项，只是读出来）
  function loadBotName() {
    return apiGet("/settings").then(function (data) {
      var sections = (data && data.sections) || [];
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].name !== "general") continue;
        var fields = sections[i].fields || [];
        for (var j = 0; j < fields.length; j++) {
          if (fields[j].key === "bot_name" && fields[j].value) {
            state.botName = String(fields[j].value);
            return;
          }
        }
      }
    }).catch(function () { /* 拿不到就用默认名，不影响大屏 */ });
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


  /* ================= 调试台功能 ================= */

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
          '<div><div class="scope-name">' + esc(shortScope(s.scope)) + "</div>" +
          '<div class="scope-sub">星星 ' + (st.total || 0) + "（明亮 " + (st.active || 0) + " / 变暗 " + (st.faded || 0) + " / 熄灭 " + (st.archived || 0) + "）</div>" +
          '<div class="scope-sub scope-raw">' + esc(s.scope) + "</div>" +
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
      // bot 名字改了，恒星上的名字要跟着变
      if (section === "general" && key === "bot_name") {
        state.botName = String(raw);
        pushModel();
      }
      if (mark) {
        mark.classList.remove("hidden");
        setTimeout(function () { mark.classList.add("hidden"); }, 2200);
      }
    }).catch(function (e) {
      toast(e.message, true);
      state.settingsLoaded = false;
    });
  }


  function maintain() {
    var btn = $("btn-maintain");
    if (btn) { btn.disabled = true; btn.textContent = "维护中…"; }
    apiPost("/maintain").then(function (data) {
      toast("遗忘维护完成：推进 " + data.scopes + " 个星域，变化 " + data.changed +
        "，熄灭 " + data.archived + "，清理 " + data.purged);
      refreshAll();
    }).catch(function (e) { toast(e.message, true); })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "🌙 维护"; }
      });
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } catch (e) { /* 某些窗口不允许全屏 */ }
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // 这些按钮在大屏里（主题的 Shadow DOM 工具条），外层按钮不存在时跳过
    var bind = function (id, fn) {
      var el = $(id);
      if (el) el.addEventListener("click", fn);
    };
    bind("btn-console", toggleDrawer);
    bind("btn-refresh", function () {
      refreshAll().catch(function (e) { toast(e.message, true); });
    });
    bind("btn-maintain", maintain);
    bind("btn-full", toggleFullscreen);

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
      if (k === "d") { toggleDrawer(); }
      else if (k === "r") { refreshAll().catch(function (err) { toast(err.message, true); }); }
      else if (k === "m") { maintain(); }
      else if (k === "f") { toggleFullscreen(); }
      else if (k === "escape") {
        $("modal").classList.add("hidden");
        if (state.drawerOpen) closeDrawer();
      }
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
    mountTheme();
    refreshAll().catch(function (e) {
      toast("数据加载失败：" + e.message, true);
      console.warn("[StarMemory] 数据加载失败:", e);
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
