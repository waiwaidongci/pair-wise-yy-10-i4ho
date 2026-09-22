/*
 * 漆线雕阴干室交接簿 —— 存档块
 * 单一事实来源：state 一次写存（save 一次 localStorage），
 * 冲突整单退回、不产生任何残单；重复令牌读回原单。
 */
(function (g) {
  "use strict";

  var R = g.DryingRules;
  var KEY = "zfl42DryingLedger";
  var WORK_KEY = "zfl42Works";

  var CABINETS = Object.freeze([
    { id: "gui-A", name: "甲柜（控温区）" },
    { id: "gui-B", name: "乙柜（常温区）" },
    { id: "gui-C", name: "丙柜（备用区）" }
  ]);

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function uid(n, tag) {
    return "e" + n + (tag || "-") + Math.random().toString(36).slice(2, 8);
  }
  function isoAt(localDateTime) {
    if (!localDateTime) return null;
    var t = new Date(localDateTime).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  function loadWorks() {
    try { return JSON.parse(g.localStorage.getItem(WORK_KEY) || "[]") || []; }
    catch (e) { return []; }
  }

  // ---- 演示初始交接簿（仅首次使用时落档），沿用作品库中的三件作品 ----
  function seedState(works) {
    var byTheme = {};
    works.forEach(function (w) { byTheme[w.theme] = w; });
    var now = Date.now();
    var state = {
      schema: 1,
      counter: 10,
      createdAt: new Date(now).toISOString(),
      orders: [],
      archive: [],
      seenTokens: {}
    };

    function makeItem(n, entry) {
      return Object.assign({
        id: uid(n),
        workId: null,
        workSnapshot: null,
        cabinetId: "",
        start: "",
        end: "",
        person: "",
        initialWeight: null,
        temp: null,
        humidity: null,
        measurements: [],
        dryingStartAt: null,
        resetAt: null,
        status: "active",
        events: []
      }, entry);
    }

    var w1 = byTheme["折枝梅"] || works[1] || works[0];
    var t1 = new Date(now - 2 * 86400000).toISOString();
    var item1 = makeItem(1, {
      workId: w1.id,
      workSnapshot: { base: w1.base, theme: w1.theme },
      cabinetId: "gui-A",
      start: t1,
      end: new Date(now + 5 * 86400000).toISOString(),
      person: "陈师傅",
      initialWeight: 300, temp: 24.2, humidity: 62,
      dryingStartAt: t1,
      measurements: [
        { at: new Date(now - 48 * 3600000).toISOString(), weight: 291, temp: 24.0, humidity: 61, inspector: "林师傅" },
        { at: new Date(now - 23.5 * 3600000).toISOString(), weight: 288, temp: 24.4, humidity: 63, inspector: "林师傅" }
      ],
      events: ["演示：入柜登记初重/温湿度/责任人"]
    });

    var w2 = byTheme["海水江崖"] || works[0];
    var t2 = new Date(now - 6 * 3600000).toISOString();
    var item2 = makeItem(2, {
      workId: w2.id,
      workSnapshot: { base: w2.base, theme: w2.theme },
      cabinetId: "gui-B",
      start: t2,
      end: new Date(now + 6 * 86400000).toISOString(),
      person: "陈师傅",
      initialWeight: 420, temp: 31.5, humidity: 60,
      events: ["演示：入柜温度越界，列待复检"]
    });

    var w3 = byTheme["云雷纹"] || works[2] || works[0];
    var t3 = new Date(now - 2 * 3600000).toISOString();
    var item3 = makeItem(3, {
      workId: w3.id,
      workSnapshot: { base: w3.base, theme: w3.theme },
      cabinetId: "gui-C",
      start: t3,
      end: new Date(now + 7 * 86400000).toISOString(),
      person: "赵师傅",
      initialWeight: null, temp: 22.0, humidity: 58,
      events: ["演示：缺初重，列待复检"]
    });

    state.orders.push(
      {
        id: "o1", token: "seed-token-01", createdAt: t1, person: "陈师傅",
        status: "accepted", note: "演示交接单（含可上金粉条目）",
        items: [item1]
      },
      {
        id: "o2", token: "seed-token-02", createdAt: t2, person: "陈师傅",
        status: "accepted", note: "演示交接单（待复检）",
        items: [item2]
      },
      {
        id: "o3", token: "seed-token-03", createdAt: t3, person: "赵师傅",
        status: "accepted", note: "演示交接单（缺初重）",
        items: [item3]
      }
    );
    ["seed-token-01", "seed-token-02", "seed-token-03"].forEach(function (t, i) {
      state.seenTokens[t] = "o" + (i + 1);
    });
    return state;
  }

  var state = null;

  function hydrate() {
    var works = loadWorks();
    var raw = g.localStorage.getItem(KEY);
    if (raw) {
      try { state = JSON.parse(raw); } catch (e) { state = null; }
    }
    if (!state || state.schema !== 1) {
      state = seedState(works);
      save();
    }
    return state;
  }

  function save() {
    g.localStorage.setItem(KEY, JSON.stringify(state));
  }

  function serialize() { return JSON.stringify(state); }
  function reload() {
    var s = serialize();
    state = JSON.parse(s);
    return s === JSON.stringify(state);
  }

  function activeBindings() {
    var out = [];
    state.orders.forEach(function (o) {
      if (o.status !== "accepted") return;
      o.items.forEach(function (it) {
        if (it.status === "active") {
          out.push({ itemId: it.id, cabinetId: it.cabinetId, start: it.start, end: it.end });
        }
      });
    });
    return out;
  }

  function findOrder(orderId) {
    return state.orders.find(function (o) { return o.id === orderId; });
  }
  function findItem(itemId) {
    for (var i = 0; i < state.orders.length; i++) {
      var f = state.orders[i].items.find(function (x) { return x.id === itemId; });
      if (f) return { order: state.orders[i], item: f };
    }
    return null;
  }
  function activeEntries() {
    var out = [];
    state.orders.forEach(function (o) {
      if (o.status !== "accepted") return;
      o.items.forEach(function (it) {
        if (it.status === "active") out.push({ order: o, item: it });
      });
    });
    return out;
  }
  function cabinetName(id) {
    var c = CABINETS.find(function (x) { return x.id === id; });
    return c ? c.name : id;
  }
  function archiveItem(order, it, reason) {
    state.archive.push({
      archivedAt: new Date().toISOString(),
      orderId: order.id,
      item: clone(it),
      reason: reason
    });
    it.status = "archived";
  }

  // ---- 整单投递：冲突整单退回；重复令牌读回原单；通过才一次写存 ----
  function submitOrder(req) {
    var token = (req.token || "").trim();
    if (token && Object.prototype.hasOwnProperty.call(state.seenTokens, token)) {
      return { ok: true, duplicate: true, order: clone(findOrder(state.seenTokens[token])) };
    }

    if (!req.entries || !req.entries.length) {
      return { ok: false, rejected: true, conflicts: [{ type: "空单" }] };
    }
    if (!req.person || !String(req.person).trim()) {
      return { ok: false, rejected: true, conflicts: [{ type: "缺责任人" }] };
    }

    var works = loadWorks();
    var drafts = req.entries.map(function (e, i) {
      var w = works.find(function (x) { return x.id === e.workId; });
      if (!w) return { error: "第 " + (i + 1) + " 条作品不存在" };
      if (!e.cabinetId || !CABINETS.some(function (c) { return c.id === e.cabinetId; })) {
        return { error: "第 " + (i + 1) + " 条柜位无效" };
      }
      var s = R.time(e.start), en = R.time(e.end);
      if (!s || !en || en <= s) return { error: "第 " + (i + 1) + " 条柜位时段无效" };
      return {
        index: i,
        workId: w.id,
        workSnapshot: { base: w.base, theme: w.theme },
        cabinetId: e.cabinetId,
        start: new Date(s).toISOString(),
        end: new Date(en).toISOString()
      };
    });
    var bad = drafts.find(function (d) { return d.error; });
    if (bad) return { ok: false, rejected: true, conflicts: [{ type: bad.error }] };

    // 柜位时段重叠只绑一件：与在柜绑定查、草稿互查
    var conflicts = R.findConflicts(drafts, activeBindings());
    if (conflicts.length) {
      return { ok: false, rejected: true, conflicts: conflicts }; // 整单退回，不动存档
    }

    // 校验全部通过后才构造条目并一次性写存（不留残单）
    state.counter += 1;
    var at = new Date().toISOString();
    var person = String(req.person).trim();
    var order = {
      id: "o" + state.counter,
      token: token || null,
      createdAt: at,
      person: person,
      status: "accepted",
      note: req.note || "",
      items: drafts.map(function (d) {
        var e = req.entries[d.index];
        var initial = R.num(e.initialWeight);
        var temp = R.num(e.temp);
        var hum = R.num(e.humidity);
        var hasInitial = initial > 0;
        var envOk = R.envInBounds(temp, hum); // 越界或缺初重只列待复检，不影响同单其他条目入柜
        return {
          id: uid(state.counter),
          workId: d.workId,
          workSnapshot: clone(d.workSnapshot),
          cabinetId: d.cabinetId,
          start: d.start,
          end: d.end,
          person: person,
          initialWeight: hasInitial ? initial : null,
          temp: Number.isFinite(temp) ? temp : null,
          humidity: Number.isFinite(hum) ? hum : null,
          measurements: [],
          dryingStartAt: hasInitial && envOk ? d.start : null,
          resetAt: null,
          status: "active",
          events: [at + " 入柜：" +
            (hasInitial ? "初重 " + initial + "g" : "缺初重") +
            "，温 " + (Number.isFinite(temp) ? temp : "—") + "℃ / 湿 " +
            (Number.isFinite(hum) ? hum : "—") + "%，责任人 " + person +
            (envOk ? "" : "（温湿度越界，列待复检）") +
            (hasInitial ? "" : "（缺初重，列待复检）")]
        };
      })
    };

    state.orders.push(order);
    if (token) state.seenTokens[token] = order.id;
    save();
    return { ok: true, duplicate: false, order: clone(order) };
  }

  // ---- 复检：换人；补初重/环境纠正后才进入阴干计时 ----
  function addMeasurement(itemId, m) {
    var found = findItem(itemId);
    if (!found) return { ok: false, error: "条目不存在或已归档" };
    var it = found.item;
    var weight = R.num(m.weight), temp = R.num(m.temp), hum = R.num(m.humidity);
    if (!(weight > 0)) return { ok: false, error: "复检重量必须为正数" };
    if (!m.inspector || !String(m.inspector).trim()) return { ok: false, error: "复检责任人必填" };
    var inspector = String(m.inspector).trim();
    if (inspector === it.person) return { ok: false, error: "复检必须换人，不得由原责任人 " + it.person + " 操作" };
    if (!R.envInBounds(temp, hum)) {
      return { ok: false, error: "复检环境温湿度仍越界，先调整阴干室环境" };
    }
    var at = isoAt(m.at) || new Date().toISOString();
    it.measurements.push({ at: at, weight: weight, temp: temp, humidity: hum, inspector: inspector });
    var notes = [];
    if (it.initialWeight == null) {
      it.initialWeight = weight;
      notes.push("补录初重 " + weight + "g（该次读数作初重，不计失重档）");
    }
    if (!R.envInBounds(it.temp, it.humidity)) {
      it.temp = temp; it.humidity = hum;
      it.dryingStartAt = at;
      notes.push("环境纠正，自此进入阴干计时");
    }
    it.events.push(at + " 复检：" + weight + "g，温 " + temp + "℃ / 湿 " + hum + "%，复检人 " +
      inspector + (notes.length ? "；" + notes.join("；") : ""));
    save();
    return { ok: true, item: clone(it), judgment: R.judge(it) };
  }

  // ---- 上金粉：判定须为 ready，落档后条目完成 ----
  function markGold(itemId, operator) {
    var found = findItem(itemId);
    if (!found) return { ok: false, error: "条目不存在或已归档" };
    var j = R.judge(found.item);
    if (j.verdict !== "ready") {
      return { ok: false, error: "判定未通过：" + (j.reasons.join("；") || "尚在阴干，继续晾干") };
    }
    var at = new Date().toISOString();
    found.item.status = "gold";
    found.item.events.push(at + " 判定通过，由 " + (operator || "值班员") + " 执行上金粉");
    save();
    return { ok: true, item: clone(found.item) };
  }

  // ---- 柜位履历变更：许可即止，旧条目留档，按新值重算 ----
  function changeCabinet(itemId, nextCabinetId, nextStart, nextEnd, operator) {
    var found = findItem(itemId);
    if (!found) return { ok: false, error: "条目不存在或已归档" };
    if (!CABINETS.some(function (c) { return c.id === nextCabinetId; })) return { ok: false, error: "柜位无效" };
    var s = R.time(nextStart), e = R.time(nextEnd);
    if (!s || !e || e <= s) return { ok: false, error: "新时段无效" };

    var others = activeBindings().filter(function (b) { return b.itemId !== itemId; });
    var probe = [{ cabinetId: nextCabinetId, start: nextStart, end: nextEnd }];
    var conflicts = R.findConflicts(probe, others);
    if (conflicts.length) return { ok: false, error: "新柜位时段与在柜绑定重叠，变更被拒" };

    var it = found.item;
    var at = new Date().toISOString();
    var reason = "柜位履历变更：" + cabinetName(it.cabinetId) + " " + it.start + "～" + it.end +
      " → " + cabinetName(nextCabinetId) + " " + new Date(s).toISOString() + "～" + new Date(e).toISOString() +
      "（操作人 " + (operator || "值班员") + "）；许可即止，旧条目留档，按新值重算";
    archiveItem(found.order, it, reason);

    var fresh = clone(it);
    fresh.id = uid(state.counter, "-r");
    fresh.cabinetId = nextCabinetId;
    fresh.start = new Date(s).toISOString();
    fresh.end = new Date(e).toISOString();
    fresh.status = "active";
    fresh.measurements = [];
    fresh.dryingStartAt = fresh.start;
    fresh.resetAt = at;
    fresh.events = [at + " " + reason];
    found.order.items.push(fresh);
    save();
    return { ok: true, item: clone(fresh), judgment: R.judge(fresh) };
  }

  // ---- 胎体或纹样变更：同步作品库后许可即止、按新值重算，旧条目留档 ----
  function syncWorks(operator) {
    var works = loadWorks();
    var changes = [];
    // 先冻结本次要处理的在柜条目：处理中会归档旧条目并追加新条目，不能边遍历边变化
    var snapshot = activeEntries().map(function (e) { return e.item; });
    snapshot.forEach(function (it) {
      var w = works.find(function (x) { return x.id === it.workId; });
      if (!w || it.status !== "active") return;
      var found = findItem(it.id);
      if (!found) return;
      var order = found.order;
      var snap = it.workSnapshot || {};
      if (snap.base !== w.base || snap.theme !== w.theme) {
        var at = new Date().toISOString();
        var reason = "胎体/纹样变更：" + (snap.base || "?") + "·" + (snap.theme || "?") +
          " → " + w.base + "·" + w.theme + "（操作人 " + (operator || "值班员") +
          "）；许可即止，旧条目留档，按新值重算";
        archiveItem(order, it, reason);
        var fresh = clone(it);
        fresh.id = uid(state.counter, "-v");
        fresh.workSnapshot = { base: w.base, theme: w.theme };
        fresh.status = "active";
        fresh.measurements = [];
        fresh.dryingStartAt = fresh.start;
        fresh.resetAt = at;
        fresh.events = [at + " " + reason];
        order.items.push(fresh);
        changes.push({ itemId: it.id, nextId: fresh.id, reason: reason });
      }
    });
    if (changes.length) save();
    return changes;
  }

  // ---- 列表 / 待办 / 重载共用同一份推导 ----
  function countByItemStatus(st) {
    var n = 0;
    state.orders.forEach(function (o) {
      o.items.forEach(function (it) { if (it.status === st) n++; });
    });
    return n;
  }
  function summary() {
    var t = R.todos(activeEntries());
    return {
      active: t.recheck.length + t.drying.length + t.ready.length,
      recheck: t.recheck.length,
      drying: t.drying.length,
      ready: t.ready.length,
      gold: countByItemStatus("gold"),
      archived: state.archive.length,
      orders: state.orders.length
    };
  }

  // 模拟整页重载：序列化 → 重新解析 → 重新推导，三方计数须一致
  function reloadCheck() {
    var before = summary();
    var ok = reload();
    var after = summary();
    var same = JSON.stringify(before) === JSON.stringify(after);
    return { ok: ok && same, before: before, after: after, serialized: serialize() };
  }

  hydrate();

  g.DryingStore = {
    KEY: KEY,
    CABINETS: CABINETS,
    isoAt: isoAt,
    getState: function () { return state; },
    loadWorks: loadWorks,
    activeEntries: activeEntries,
    activeBindings: activeBindings,
    findItem: findItem,
    submitOrder: submitOrder,
    addMeasurement: addMeasurement,
    markGold: markGold,
    changeCabinet: changeCabinet,
    syncWorks: syncWorks,
    summary: summary,
    todos: function () { return R.todos(activeEntries()); },
    reloadCheck: reloadCheck,
    cabinetName: cabinetName,
    _seed: seedState,
    _reset: function (s) { state = s || seedState(loadWorks()); save(); return state; }
  };
})(typeof window !== "undefined" ? window : globalThis);
