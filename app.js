/*
 * 漆线雕阴干室交接簿 —— 页面块
 * 只负责录入与展示：所有判定取自 DryingRules，所有落档取自 DryingStore。
 * 列表 / 待办 / 重载结果均由同一份 state 经同一推导函数渲染。
 */
(function () {
  "use strict";

  var Store = window.DryingStore;
  var Rules = window.DryingRules;
  var CABINETS = Store.CABINETS;
  var drafts = [];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function localInputValue(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDateTime(iso) {
    var t = Rules.time(iso);
    if (!Number.isFinite(t)) return "—";
    var d = new Date(t);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function pct(v) { return (v * 100).toFixed(2) + "%"; }

  function banner(cls, html) {
    var el = $("#banner");
    el.className = "banner " + cls;
    el.innerHTML = html;
    el.style.display = html ? "block" : "none";
  }

  // ---------- 投递单草稿行 ----------
  function emptyDraft() {
    var works = Store.loadWorks();
    var now = new Date();
    var later = new Date(now.getTime() + 3 * 86400000);
    return {
      workId: works[0] ? works[0].id : "",
      cabinetId: CABINETS[0].id,
      start: localInputValue(now),
      end: localInputValue(later),
      initialWeight: "",
      temp: "24",
      humidity: "62"
    };
  }

  function renderDrafts() {
    var works = Store.loadWorks();
    if (!works.length) {
      $("#draftRows").innerHTML = '<div class="empty">作品库为空：请先在 <a href="index.html">工坊看板</a> 新增作品。</div>';
      return;
    }
    $("#draftRows").innerHTML = drafts.map(function (d, i) {
      return '<div class="row">' +
        '<label>作品<select data-k="workId" data-i="' + i + '">' +
          works.map(function (w) {
            return '<option value="' + esc(w.id) + '"' + (w.id === d.workId ? " selected" : "") + ">" +
              esc(w.theme + "（" + w.base + "）") + "</option>";
          }).join("") +
        "</select></label>" +
        '<label>柜位<select data-k="cabinetId" data-i="' + i + '">' +
          CABINETS.map(function (c) {
            return '<option value="' + c.id + '"' + (c.id === d.cabinetId ? " selected" : "") + ">" + c.name + "</option>";
          }).join("") +
        "</select></label>" +
        '<label>起<input type="datetime-local" data-k="start" data-i="' + i + '" value="' + esc(d.start) + '"></label>' +
        '<label>止<input type="datetime-local" data-k="end" data-i="' + i + '" value="' + esc(d.end) + '"></label>' +
        '<label>初重 g<input type="number" step="0.1" min="0" data-k="initialWeight" data-i="' + i + '" value="' + esc(d.initialWeight) + '" placeholder="缺则留空"></label>' +
        '<label>温度 ℃<input type="number" step="0.1" data-k="temp" data-i="' + i + '" value="' + esc(d.temp) + '"></label>' +
        '<label>湿度 %<input type="number" step="0.1" data-k="humidity" data-i="' + i + '" value="' + esc(d.humidity) + '"></label>' +
        '<button type="button" class="danger ghost" data-act="delRow" data-i="' + i + '">删</button>' +
      "</div>";
    }).join("");
  }

  // ---------- 卡片 ----------
  function verdictBadge(j) {
    if (j.verdict === "recheck") return '<span class="tag red">待复检</span>';
    if (j.verdict === "ready") return '<span class="tag violet">可上金粉</span>';
    return '<span class="tag amber">续干中</span>';
  }

  function measureRows(it) {
    if (!it.measurements.length) return '<div class="empty">尚无复检记录</div>';
    var floor = -Infinity;
    if (it.dryingStartAt) floor = Math.max(floor, Rules.time(it.dryingStartAt));
    if (it.resetAt) floor = Math.max(floor, Rules.time(it.resetAt));
    return '<table class="msr"><thead><tr><th>时间</th><th>重量</th><th>失重</th><th>档</th><th>复检人</th></tr></thead><tbody>' +
      it.measurements.slice().sort(function (a, b) { return Rules.time(a.at) - Rules.time(b.at); }).map(function (m, idx) {
        var ratio = Rules.lossRatio(it.initialWeight, m.weight);
        var tier = Rules.tierOf(ratio);
        var ignored = Rules.time(m.at) < floor;
        // 首次补录初重时 ratio 为 0，也照常展示
        return '<tr' + (ignored ? ' class="ignored"' : "") + '>' +
          "<td>" + fmtDateTime(m.at) + (ignored ? " <span class=meta>重算前</span>" : "") + "</td>" +
          "<td>" + esc(m.weight) + "g</td>" +
          "<td>" + (ratio == null ? "—" : pct(ratio)) + "</td>" +
          "<td>" + (tier ? tier.key : "—") + "</td>" +
          "<td>" + esc(m.inspector) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function cardHtml(entry) {
    var it = entry.item, o = entry.order;
    var j = Rules.judge(it);
    var works = Store.loadWorks();
    var w = works.find(function (x) { return x.id === it.workId; });
    var drifted = w && (w.base !== it.workSnapshot.base || w.theme !== it.workSnapshot.theme);
    var envOk = Rules.envInBounds(it.temp, it.humidity);
    return '<article class="card v-' + j.verdict + '">' +
      '<div class="card-head">' +
        "<b>" + esc(it.workSnapshot.theme) + "</b> " + verdictBadge(j) +
        (drifted ? '<span class="tag red" title="作品库胎体/纹样已改，同步后将许可即止并重算">胎体/纹样已变更</span>' : "") +
      "</div>" +
      '<div class="meta">' + esc(it.workSnapshot.base) + " · " + Store.cabinetName(it.cabinetId) + "<br>" +
        fmtDateTime(it.start) + " ～ " + fmtDateTime(it.end) + "<br>" +
        "责任人 " + esc(it.person) + " · 交接单 " + esc(o.id) + "<br>" +
        "初重 " + (it.initialWeight == null ? '<b class="red">缺</b>' : it.initialWeight + "g") +
        " · 入柜温 " + esc(it.temp == null ? "—" : it.temp) + "℃ / 湿 " +
        esc(it.humidity == null ? "—" : it.humidity) + "%" +
        (envOk ? "" : ' <b class="red">越界</b>') +
      "</div>" +
      measureRows(it) +
      (j.verdict === "drying" && j.reasons.length ? '<div class="reasons">续干：' + j.reasons.map(esc).join("；") + "</div>" : "") +
      (j.verdict === "recheck" ? '<div class="reasons red">' + j.reasons.map(esc).join("；") + "</div>" : "") +
      (j.verdict === "ready" ? '<div class="reasons ok">复检换人、隔满 24 小时、连续两次失重同档，许可上金粉。</div>' : "") +
      '<div class="actions">' +
        '<button data-act="recheck" data-id="' + esc(it.id) + '">复检登记</button>' +
        (j.verdict === "ready" ? '<button class="violet" data-act="gold" data-id="' + esc(it.id) + '">上金粉</button>' : "") +
        '<button class="warn" data-act="cabinet" data-id="' + esc(it.id) + '">改柜位</button>' +
      "</div>" +
      "</article>";
  }

  // ---------- 三块渲染：待办、在柜列表、存档/交接单 ----------
  function render() {
    var todos = Store.todos();

    function listHtml(arr, emptyText) {
      return arr.length ? arr.map(cardHtml).join("") : '<div class="empty">' + emptyText + "</div>";
    }
    $("#todoRecheck").innerHTML = listHtml(todos.recheck, "无待复检条目");
    $("#todoDrying").innerHTML = listHtml(todos.drying, "无续干条目");
    $("#todoReady").innerHTML = listHtml(todos.ready, "无可上金粉条目");
    $("#cRecheck").textContent = todos.recheck.length;
    $("#cDrying").textContent = todos.drying.length;
    $("#cReady").textContent = todos.ready.length;

    var allActive = todos.recheck.concat(todos.drying, todos.ready);
    $("#activeList").innerHTML = listHtml(allActive, "在柜条目为空");

    // 已上金粉
    var state = Store.getState();
    var goldItems = [];
    state.orders.forEach(function (o) {
      o.items.forEach(function (it) {
        if (it.status === "gold") goldItems.push({ order: o, item: it });
      });
    });
    $("#goldList").innerHTML = goldItems.length ? goldItems.map(function (entry) {
      var it = entry.item;
      return '<div class="goldline">✓ ' + esc(it.workSnapshot.theme) + "（" + esc(it.workSnapshot.base) +
        "）· " + Store.cabinetName(it.cabinetId) + " · 单 " + esc(entry.order.id) + "</div>";
    }).join("") : '<div class="empty">尚无完成条目</div>';

    // 交接单
    $("#orderList").innerHTML = state.orders.slice().reverse().map(function (o) {
      var n = o.items.length;
      var nGold = o.items.filter(function (it) { return it.status === "gold"; }).length;
      var nArch = o.items.filter(function (it) { return it.status === "archived"; }).length;
      var nAct = n - nGold - nArch;
      return '<div class="orderline"><b>' + esc(o.id) + "</b> " +
        fmtDateTime(o.createdAt) + " · 责任人 " + esc(o.person) +
        ' · 条目 ' + n + "（在柜 " + nAct + " / 上金粉 " + nGold + " / 已留档替代 " + nArch + "）" +
        (o.token ? ' · 令牌 <code>' + esc(o.token) + "</code>" : "") +
        (o.note ? ' · <span class="meta">' + esc(o.note) + "</span>" : "") + "</div>";
    }).join("");

    // 留档（旧条目）
    $("#archiveList").innerHTML = state.archive.length ? state.archive.slice().reverse().map(function (a) {
      var it = a.item;
      return '<details class="archive"><summary><b>' + esc(it.workSnapshot.theme) + "</b> · 旧条目 " +
        esc(it.id) + " · 留档于 " + fmtDateTime(a.archivedAt) + "</summary>" +
        '<div class="meta">' + esc(a.reason) + "<br>原柜位：" + Store.cabinetName(it.cabinetId) +
        " " + fmtDateTime(it.start) + "～" + fmtDateTime(it.end) +
        " · 初重 " + (it.initialWeight == null ? "缺" : it.initialWeight + "g") +
        ' · 复检 ' + it.measurements.length + " 次</div></details>";
    }).join("") : '<div class="empty">尚无留档条目</div>';

    renderCounts();
  }

  // 列表 / 待办 / 重载结果一致：计数来自同一 summary()，并与 DOM 实际节点核对
  function renderCounts() {
    var s = Store.summary();
    $("#chipBar").innerHTML =
      chip("", "在柜", s.active) +
      chip("red", "待复检", s.recheck) +
      chip("amber", "续干", s.drying) +
      chip("violet", "可上金粉", s.ready) +
      chip("", "已上金粉", s.gold) +
      chip("", "留档旧条目", s.archived) +
      chip("", "交接单", s.orders);
    var domCounts = {
      recheck: $("#todoRecheck").querySelectorAll(".card").length,
      drying: $("#todoDrying").querySelectorAll(".card").length,
      ready: $("#todoReady").querySelectorAll(".card").length
    };
    var consistent = domCounts.recheck === s.recheck && domCounts.drying === s.drying && domCounts.ready === s.ready;
    $("#consistency").textContent = consistent
      ? "列表 / 待办 / 重载一致 ✓（待办 " + domCounts.recheck + "·" + domCounts.drying + "·" + domCounts.ready + "）"
      : "计数不一致 ✗";
    $("#consistency").className = "consistency " + (consistent ? "ok" : "bad");
  }
  function chip(cls, label, n) {
    return '<span class="chip ' + (cls || "") + '">' + label + " <b>" + n + "</b></span>";
  }

  // ---------- 弹窗 ----------
  var dialog = $("#opDialog");
  var dialogTitle = $("#opTitle");
  var dialogBody = $("#opBody");

  function closeDialog() { dialog.close(); }
  function openRecheck(id) {
    var found = Store.findItem(id);
    if (!found) return;
    dialogTitle.textContent = "复检登记 · " + found.item.workSnapshot.theme;
    dialogBody.innerHTML =
      '<div class="meta">原责任人 ' + esc(found.item.person) + "，复检必须换人。温湿度允许区间 " +
        Rules.BOUNDS.tempMin + "–" + Rules.BOUNDS.tempMax + "℃ / " +
        Rules.BOUNDS.humMin + "–" + Rules.BOUNDS.humMax + "%。</div>" +
      '<form id="recheckForm" class="grid2">' +
        '<label>复检时间<input type="datetime-local" name="at" value="' + localInputValue() + '"></label>' +
        '<label>复检重量 g<input type="number" step="0.1" min="0" name="weight" required autofocus></label>' +
        '<label>复检人（须换人）<input name="inspector" required placeholder="不得为 ' + esc(found.item.person) + '"></label>' +
        '<label>温度 ℃<input type="number" step="0.1" name="temp" value="24" required></label>' +
        '<label>湿度 %<input type="number" step="0.1" name="humidity" value="62" required></label>' +
      "</form>";
    $("#opSubmit").onclick = function () {
      var f = $("#recheckForm");
      if (!f.reportValidity()) return;
      var d = Object.fromEntries(new FormData(f).entries());
      var r = Store.addMeasurement(id, {
        at: d.at, weight: d.weight, inspector: d.inspector, temp: d.temp, humidity: d.humidity
      });
      if (!r.ok) { banner("bad", "复检被拒：" + esc(r.error)); return; }
      banner("ok", "复检已落档：" + (r.judgment.verdict === "ready"
        ? "连续两次失重同档且间隔满 24 小时，可上金粉。"
        : r.judgment.reasons.join("；") || "继续阴干。"));
      closeDialog(); render();
    };
    dialog.showModal();
  }

  function openCabinet(id) {
    var found = Store.findItem(id);
    if (!found) return;
    var it = found.item;
    dialogTitle.textContent = "柜位履历变更 · " + it.workSnapshot.theme;
    dialogBody.innerHTML =
      '<div class="meta red">变更后许可即止：旧条目整体留档，按新柜位/时段重新计算（原复检不计入）。</div>' +
      '<form id="cabinetForm" class="grid2">' +
        "<label>新柜位<select name=cabinetId>" +
          CABINETS.map(function (c) {
            return '<option value="' + c.id + '"' + (c.id === it.cabinetId ? " selected" : "") + ">" + c.name + "</option>";
          }).join("") +
        "</select></label>" +
        '<label>操作人<input name="operator" required placeholder="值班员姓名"></label>' +
        '<label>新起<input type="datetime-local" name="start" value="' + localInputValue() + '" required></label>' +
        '<label>新止<input type="datetime-local" name="end" value="' + localInputValue(new Date(Date.now() + 3 * 86400000)) + '" required></label>' +
      "</form>";
    $("#opSubmit").onclick = function () {
      var f = $("#cabinetForm");
      if (!f.reportValidity()) return;
      var d = Object.fromEntries(new FormData(f).entries());
      var r = Store.changeCabinet(id, d.cabinetId, d.start, d.end, d.operator);
      if (!r.ok) { banner("bad", "柜位变更被拒：" + esc(r.error)); return; }
      banner("ok", "柜位履历已变更：旧条目留档，新条目按新值重算。");
      closeDialog(); render();
    };
    dialog.showModal();
  }

  // ---------- 事件 ----------
  $("#addRow").addEventListener("click", function () {
    drafts.push(emptyDraft());
    renderDrafts();
  });
  $("#draftRows").addEventListener("change", function (e) {
    var t = e.target;
    var i = Number(t.getAttribute("data-i"));
    var k = t.getAttribute("data-k");
    if (k && drafts[i]) drafts[i][k] = t.value;
  });
  $("#draftRows").addEventListener("click", function (e) {
    var t = e.target.closest("[data-act='delRow']");
    if (!t) return;
    drafts.splice(Number(t.getAttribute("data-i")), 1);
    renderDrafts();
  });

  $("#orderForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var d = Object.fromEntries(new FormData(f).entries());
    var res = Store.submitOrder({
      token: d.token, person: d.person, note: d.note,
      entries: drafts.map(function (x) {
        return {
          workId: x.workId, cabinetId: x.cabinetId, start: x.start, end: x.end,
          initialWeight: x.initialWeight, temp: x.temp, humidity: x.humidity
        };
      })
    });
    if (!res.ok) {
      // 冲突整单退回：列出冲突，不留残单
      banner("bad", "整单退回（未写入任何条目）：<br>" + res.conflicts.map(function (c) {
        if (c.type === "与在柜绑定重叠") {
          return "· 第 " + (c.itemIndex + 1) + " 条：" + Store.cabinetName(c.cabinetId) +
            " 与在柜条目 " + esc(c.against) + "（" + fmtDateTime(c.againstStart) + "～" + fmtDateTime(c.againstEnd) + "）时段重叠";
        }
        if (c.type === "单内柜位重叠") {
          return "· 第 " + (c.itemIndex + 1) + " 条与第 " + (c.otherIndex + 1) + " 条同在 " +
            Store.cabinetName(c.cabinetId) + " 且时段重叠";
        }
        return "· " + esc(c.type);
      }).join("<br>"));
      return;
    }
    if (res.duplicate) {
      banner("ok", "重复令牌：读回原单 <b>" + esc(res.order.id) + "</b>（" +
        fmtDateTime(res.order.createdAt) + "），未生成新单。");
    } else {
      var verdicts = res.order.items.map(function (it) { return Rules.judge(it).verdict; });
      banner("ok", "交接单 <b>" + esc(res.order.id) + "</b> 已整单入簿：在柜复检 " +
        verdicts.filter(function (v) { return v === "recheck"; }).length +
        " 件，直接续干 " + verdicts.filter(function (v) { return v !== "recheck"; }).length + " 件。");
      drafts = [emptyDraft()];
      renderDrafts();
      f.reset();
      initForm();
    }
    render();
  });

  document.body.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]");
    if (!t || t.closest("#draftRows")) return;
    var act = t.getAttribute("data-act");
    var id = t.getAttribute("data-id");
    if (act === "recheck") openRecheck(id);
    if (act === "cabinet") openCabinet(id);
    if (act === "gold") {
      var operator = prompt("执行上金粉的值班员：");
      if (operator === null) return;
      var r = Store.markGold(id, operator);
      if (!r.ok) banner("bad", "上金粉被拒：" + esc(r.error));
      else banner("ok", "已上金粉，条目完成。");
      render();
    }
  });
  $("#opCancel").addEventListener("click", closeDialog);

  $("#reloadBtn").addEventListener("click", function () {
    var r = Store.reloadCheck();
    banner(r.ok ? "ok" : "bad",
      "重载结果：" + (r.ok ? "序列化→重新解析→重新推导一致 ✓" : "不一致 ✗") +
      "<br>重载前 " + JSON.stringify(r.before) + "<br>重载后 " + JSON.stringify(r.after));
    render();
  });

  $("#syncBtn").addEventListener("click", function () {
    var changes = Store.syncWorks(prompt("同步操作人：") || "值班员");
    if (!changes.length) banner("ok", "作品库胎体/纹样无变更。");
    else banner("bad", "检测到胎体/纹样变更 " + changes.length +
      " 处：许可即止，旧条目已留档，新条目按新值重算。");
    render();
  });

  $("#exportBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(Store.getState(), null, 2)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-drying-ledger.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  function initForm() {
    var f = $("#orderForm");
    f.elements.token.value = "tok-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  // 启动：沿用作品库；自动同步一次胎体/纹样变更
  drafts = [emptyDraft()];
  renderDrafts();
  initForm();
  var autoChanges = Store.syncWorks("启动同步");
  if (autoChanges.length) {
    banner("bad", "启动时发现作品库胎体/纹样已变更 " + autoChanges.length +
      " 处：许可即止，旧条目留档并按新值重算。");
  }
  render();
})();
