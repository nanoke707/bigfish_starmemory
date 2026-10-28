/* 咸鱼星空记忆 · 调试控制台前端逻辑
 * 通过 AstrBot 插件桥接 SDK 调用后端 WebAPI（鉴权由面板处理）。
 */
(function () {
  "use strict";

  var PREFIX = "ui";
  var bridge = window.AstrBotPluginView || window.AstrBotPluginPage;
  var bridgeReady = false;

  var state = {
    status: "all",
    page: 1,
    scopes: [],
  };

  // ---------- 桥接状态可见化 ----------
  function setBridgeState(cls, text, showWarn) {
    var el = document.getElementById("bridge-status");
    if (el) { el.className = "bridge-status " + cls; el.textContent = text; }
    var warn = document.getElementById("bridge-warn");
    if (warn) warn.classList.toggle("hidden", !showWarn);
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("桥接超时（" + ms + "ms 内未收到面板响应）")); }, ms);
      }),
    ]);
  }

  // ---------- 基础 ----------
  function toast(msg, isErr) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
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

  var ESC_MAP = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return "&" + ESC_MAP[c] + ";";
    });
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

  // ---------- 总览 ----------
  function loadOverview() {
    return apiGet("/overview").then(function (data) {
      var t = data.totals || {};
      document.getElementById("n-total").textContent = t.all ?? 0;
      document.getElementById("n-bright").textContent = t.active ?? 0;
      document.getElementById("n-faded").textContent = t.faded ?? 0;
      document.getElementById("n-archived").textContent = t.archived ?? 0;
      document.getElementById("n-pinned").textContent = t.pinned ?? 0;
      document.getElementById("n-scopes").textContent = data.scope_count ?? 0;
      if (data.last_maintenance_day) {
        document.getElementById("last-maintained").textContent =
          "上次遗忘维护：" + data.last_maintenance_day;
      }
      return data;
    });
  }

  // ---------- 星空列表 ----------
  function loadStars() {
    var list = document.getElementById("star-list");
    list.innerHTML = '<div class="empty">加载中……</div>';
    return apiGet("/stars/" + encodeURIComponent(state.status) + "/" + state.page)
      .then(function (data) {
        var stars = data.stars || [];
        if (!stars.length) {
          list.innerHTML = '<div class="empty">这片星域空空如也——去聊几轮天，等星星凝成吧。</div>';
        } else {
          list.innerHTML = stars.map(renderStarCard).join("");
          bindStarActions(list);
        }
        document.getElementById("page-indicator").textContent = "第 " + (data.page || 1) + " 页";
        document.getElementById("btn-prev").disabled = (data.page || 1) <= 1;
        document.getElementById("btn-next").disabled = !data.has_more;
      })
      .catch(function (e) { list.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }

  function renderStarCard(s) {
    var pct = Math.round((s.retention || 0) * 100);
    var badges =
      '<span class="badge b-' + esc(s.status) + '">' + statusText(s.status) + "</span>" +
      (s.pinned ? '<span class="badge b-pinned">珍藏</span>' : "") +
      '<span class="badge">重要度 ' + Math.round((s.importance || 0) * 100) + "%</span>" +
      '<span class="badge">强化 ' + (s.review_count || 0) + " 次</span>" +
      '<span class="badge">半衰期 ' + (s.half_life_days || 0) + " 天</span>" +
      '<span class="badge b-clarity-' + esc(s.clarity || "unknown") + '">' +
      clarityText(s.clarity) + "</span>" +
      (s.corrected ? '<span class="badge b-warn">已被纠正</span>' : "");
    var tags = (s.tags || []).map(function (t) { return "#" + esc(t); }).join(" ");
    var actions = [];
    if (!s.pinned) actions.push('<button class="btn small warn" data-act="pin" data-id="' + s.id + '">📌 珍藏</button>');
    else actions.push('<button class="btn small" data-act="unpin" data-id="' + s.id + '">取消珍藏</button>');
    if (s.status !== "active") actions.push('<button class="btn small good" data-act="revive" data-id="' + s.id + '">✦ 重新点亮</button>');
    if (s.status !== "archived") actions.push('<button class="btn small danger" data-act="forget" data-id="' + s.id + '">🌙 熄灭</button>');
    actions.push('<button class="btn small danger" data-act="delete" data-id="' + s.id + '">删除</button>');
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
      '<div class="brightness"><i style="width:' + pct + '%"></i></div>' +
      "</div>" +
      '<div class="star-actions"><button class="btn small" data-act="detail" data-id="' + s.id + '">详情</button>' +
      '<div class="row-actions">' + actions.join("") + "</div></div>" +
      "</div>"
    );
  }

  function clarityText(clarity) {
    return {
      clear: "可靠记得",
      vague: "记忆模糊",
      faint: "几乎不记得",
      unknown: "无法回忆"
    }[clarity] || "无法回忆";
  }

  function shortScope(scope) {
    if (!scope) return "—";
    if (scope.length > 34) return scope.slice(0, 33) + "…";
    return scope;
  }

  // 两步确认：沙箱 iframe 里 window.confirm 被浏览器静默屏蔽，必须页内实现
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

  // ---------- 详情 ----------
  function openDetail(id) {
    apiGet("/star/" + id)
      .then(function (s) {
        var d = s.debug || {};
        var moodLine = s.valence >= 0 ? "愉快 +" : "低落 ";
        var body =
          '<h2 style="font-size:16px;margin-bottom:4px;">' + statusIcon(s.status, s.pinned) + " 星星 #" + s.id + "</h2>" +
          '<p style="color:var(--tx1);font-size:13.5px;">' + esc(s.content) + "</p>" +
          '<div class="kv">' +
          kv("状态", statusText(s.status) + (s.pinned ? " · 📌珍藏" : "") + " · 亮度 " + Math.round((s.retention || 0) * 100) + "%") +
          kv("回忆清晰度", clarityText(s.clarity)) +
          kv("会话", esc(s.scope)) +
          kv("标签", (s.tags || []).map(esc).join("、") || "—") +
          kv("类型 / 重要度", esc(s.type) + " · " + Math.round((s.importance || 0) * 100) + "%") +
          kv("情绪印记（原始）", moodLine + Math.abs(s.valence).toFixed(2) + " · 激动 " + (s.arousal || 0).toFixed(2)) +
          kv("事件发生时间", esc(s.event_time_label || "时间不详") +
            (s.event_time_precision ? "（精度：" + esc(s.event_time_precision) + "）" : "")) +
          kv("记录写入时间", fmtDate(s.created_at)) +
          kv("上次有效强化", (s.last_reinforced_at ? fmtDate(s.last_reinforced_at) : "从未") +
            "（距锚点 " + (s.days_since_anchor || 0) + " 天）") +
          kv("强化 / 检索 / 再激活", (s.review_count || 0) + " / " + (s.recall_count || 0) + " / " + (s.reactivate_count || 0) + " 次") +
          kv("记忆半衰期 H_m", (s.half_life_days || 0) + " 天") +
          "</div>";

        // 细节
        var details = s.details || [];
        if (details.length) {
          body += '<div class="debugbox"><b>细节（各自独立遗忘）</b><br>' +
            details.map(function (x) {
              return "↳ [" + clarityText(x.clarity) + "] " + esc(x.text) +
                "（半衰期 " + (x.half_life_days || 0) + " 天 · 保持率 " +
                Math.round((x.retention || 0) * 100) + "%）";
            }).join("<br>") + "</div>";
        }
        // 情绪残留
        var emotions = s.emotions || [];
        if (emotions.length) {
          body += '<div class="debugbox"><b>情绪残留（独立半衰期）</b><br>' +
            emotions.map(function (x) {
              return "↳ " + esc(x.label) + "：原始 " + (x.original || 0).toFixed(2) +
                " → 残留 " + (x.residual || 0).toFixed(3) +
                "（半衰期 " + (x.half_life_days || 0) + " 天）";
            }).join("<br>") + "</div>";
        }
        // 关联
        var links = s.links || [];
        if (links.length) {
          body += '<div class="debugbox"><b>与其它星星的关系</b><br>' +
            links.map(function (x) {
              return "↳ " + esc(x.relation) + (x.reason ? "：" + esc(x.reason) : "");
            }).join("<br>") + "</div>";
        }
        // 再激活
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
        document.getElementById("modal-body").innerHTML = body;
        document.getElementById("modal").classList.remove("hidden");
      })
      .catch(function (e) { toast(e.message, true); });
  }

  function kv(k, v) {
    return '<span class="k">' + k + '</span><span class="v">' + v + "</span>";
  }

  // ---------- 检索调试 ----------
  function doSearch() {
    var input = document.getElementById("search-input");
    var q = (input.value || "").trim().replace(/[/\\]/g, " ");
    var box = document.getElementById("search-results");
    if (!q) { toast("请输入检索词", true); return; }
    box.innerHTML = '<div class="empty">检索中……</div>';
    apiGet("/search/" + encodeURIComponent(q))
      .then(function (data) {
        var rs = data.results || [];
        if (!rs.length) {
          box.innerHTML = '<div class="empty">没有任何星星亮起——连放宽阈值的调试检索都没命中。</div>';
          return;
        }
        box.innerHTML = rs.map(function (s) {
          var pct = Math.round((s.retention || 0) * 100);
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
            '<div class="brightness"><i style="width:' + pct + '%"></i></div>' +
            "</div>" +
            '<div class="star-actions"><button class="btn small" data-act="detail" data-id="' + s.id + '">详情</button></div>' +
            "</div>"
          );
        }).join("");
        bindStarActions(box);
      })
      .catch(function (e) {
        box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
      });
  }

  // ---------- 会话与凝星 ----------
  function loadScopes() {
    var box = document.getElementById("scope-list");
    box.innerHTML = '<div class="empty">加载中……</div>';
    apiGet("/overview").then(function (data) {
      var scopes = data.scopes || [];
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
          '<button class="btn small" data-scope="' + esc(s.scope) + '">✧ 立即凝星</button>' +
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
              var added = (data.added || []);
              toast("凝星完成：新增 " + added.length + " 颗，复习 " + (data.reinforced || []).length + " 颗，合并 " + (data.merged || 0) + " 颗" +
                (data.mood_changed ? "，心绪已更新" : ""));
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

  // ---------- 设置页 ----------
  var PROVIDER_FIELD_MAP = { "llm.provider_id": "llm", "embedding.provider_id": "embedding" };
  var settingsLoaded = false;

  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(String(str))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function loadSettings(force) {
    if (settingsLoaded && !force) return;
    settingsLoaded = true;
    var loader = document.getElementById("settings-loading");
    var box = document.getElementById("settings-list");
    loader.style.display = "";
    box.innerHTML = "";
    apiGet("/settings")
      .then(function (data) {
        loader.style.display = "none";
        var sections = data.sections || [];
        if (!sections.length) {
          box.innerHTML = '<div class="empty">没有可配置的项。</div>';
          return;
        }
        box.innerHTML = sections.map(function (sec) { return renderSettingsSection(sec, data.providers || {}); }).join("");
        bindSettingsEvents(box, data.providers || {});
      })
      .catch(function (e) {
        loader.style.display = "none";
        settingsLoaded = false;
        box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
      });
  }

  function renderSettingsSection(sec, providers) {
    var rows = sec.fields.map(function (f) { return renderField(sec, f, providers); }).join("");
    return (
      '<div class="settings-card" data-section="' + esc(sec.name) + '">' +
      '<div class="settings-head"><span class="settings-title">' + esc(sec.title) + "</span>" +
      '<button class="btn small ghost" data-reset="' + esc(sec.name) + '">恢复默认</button></div>' +
      rows +
      "</div>"
    );
  }

  function renderField(sec, f, providers) {
    var id = "f-" + sec.name + "-" + f.key;
    var control = "";
    var provKey = PROVIDER_FIELD_MAP[f.path];
    var value = f.value == null ? "" : f.value;

    if (provKey) {
      var list = providers[provKey] || [];
      var opts = ['<option value="">（默认）跟随 AstrBot 当前选择</option>'];
      var found = String(value) === "";
      list.forEach(function (p) {
        if (p.id === String(value)) found = true;
        opts.push('<option value="' + esc(p.id) + '"' + (p.id === String(value) ? " selected" : "") + ">" +
          esc(p.id) + (p.model ? " · " + esc(p.model) : "") + "</option>");
      });
      if (!found && value !== "") {
        opts.push('<option value="' + esc(value) + '" selected>' + esc(value) + "（当前配置）</option>");
      }
      control = '<select id="' + id + '" data-field="' + esc(f.key) + '" data-section="' + esc(sec.name) + '">' + opts.join("") + "</select>";
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
      el.addEventListener("change", function () {
        saveSetting(el);
      });
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
          apiPost("/settings/reset/" + section)
            .then(function (d) {
              toast(d.note || "已恢复默认");
              settingsLoaded = false;
              loadSettings(true);
            })
            .catch(function (e) { toast(e.message, true); });
        });
      });
    });
  }

  function saveSetting(el, forcedValue) {
    var section = el.dataset.section;
    var key = el.dataset.field;
    var raw = forcedValue !== undefined ? forcedValue : el.value;
    var row = document.getElementById("row-f-" + section + "-" + key);
    var mark = row ? row.querySelector(".saved-mark") : null;
    if (mark) mark.classList.add("hidden");
    apiPost("/settings/set/" + section + "/" + key + "/" + b64urlEncode(raw))
      .then(function (d) {
        toast(d.note || "已保存并生效");
        if (mark) {
          mark.classList.remove("hidden");
          setTimeout(function () { mark.classList.add("hidden"); }, 2200);
        }
      })
      .catch(function (e) {
        toast(e.message, true);
        settingsLoaded = false;
      });
  }
  // ---------- 全局操作 ----------
  function refreshAll() {
    loadOverview().catch(function (e) { toast(e.message, true); });
    loadStars();
    loadScopes();
  }

  function maintain() {
    var btn = document.getElementById("btn-maintain");
    btn.disabled = true;
    btn.textContent = "维护中……";
    apiPost("/maintain")
      .then(function (data) {
        toast("遗忘维护完成：推进 " + data.scopes + " 个星域，变化 " + data.changed + "，熄灭 " + data.archived + "，清理 " + data.purged);
        refreshAll();
      })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "🌙 遗忘维护";
      });
  }

  // ---------- 事件绑定 ----------
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".tabpane").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "settings") loadSettings();
    });
  });

  document.querySelectorAll("#status-chips .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll("#status-chips .chip").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      state.status = chip.dataset.status;
      state.page = 1;
      loadStars();
    });
  });

  document.getElementById("btn-prev").addEventListener("click", function () { state.page--; loadStars(); });
  document.getElementById("btn-next").addEventListener("click", function () { state.page++; loadStars(); });
  document.getElementById("btn-refresh").addEventListener("click", refreshAll);
  document.getElementById("btn-maintain").addEventListener("click", maintain);
  document.getElementById("btn-search").addEventListener("click", doSearch);
  document.getElementById("search-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") doSearch();
  });
  document.getElementById("modal-close").addEventListener("click", function () {
    document.getElementById("modal").classList.add("hidden");
  });
  document.getElementById("modal").addEventListener("click", function (e) {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });

  // ---------- 启动 ----------
  function boot() {
    refreshAll();
  }

  if (!bridge || typeof bridge.ready !== "function") {
    // 桥接 SDK 没加载成功：页面仍可浏览，但数据按钮不可用，并给出明确指引
    setBridgeState("bad", "桥接未就绪", true);
    boot(); // 让各区块显示明确的错误信息，而不是永远"加载中"
  } else {
    // 握手最多等 6 秒：超时说明 iframe 桥没有连通（例如页面不是从面板内打开的）
    withTimeout(bridge.ready(), 6000).then(function () {
      bridgeReady = true;
      setBridgeState("ok", "桥接就绪", false);
      boot();
    }).catch(function (e) {
      setBridgeState("bad", "桥接超时", true);
      boot(); // 展示明确的"桥接未就绪"错误而非无限加载
      console.warn("[StarMemory] 桥接握手失败:", e);
    });
  }
})();
