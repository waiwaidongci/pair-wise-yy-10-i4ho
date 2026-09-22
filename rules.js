/*
 * 漆线雕阴干室交接簿 —— 判定块（纯函数，不碰 DOM 与存档）
 * 页面与存档都只能调用这里的规则，保证列表、待办、重载重算结果一致。
 */
(function (g) {
  "use strict";

  var HOUR = 3600 * 1000;

  // 入柜温湿度允许区间（闭区间，越界即列待复检）
  var BOUNDS = Object.freeze({
    tempMin: 18, tempMax: 28,   // 摄氏度
    humMin: 50, humMax: 75      // 相对湿度 %
  });

  // 失重比例档位（相对初重），半开区间 [lo, hi)
  var TIERS = Object.freeze([
    { key: "A", label: "一档 <1%",    lo: -Infinity, hi: 0.01 },
    { key: "B", label: "二档 1%–3%",  lo: 0.01, hi: 0.03 },
    { key: "C", label: "三档 3%–5%",  lo: 0.03, hi: 0.05 },
    { key: "D", label: "四档 ≥5%",    lo: 0.05, hi: Infinity }
  ]);

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function time(v) {
    if (v == null || v === "") return NaN;
    var t = new Date(v).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  // 半开时段 [start, end) 是否重叠；非法时段一律视为不重叠
  function periodsOverlap(s1, e1, s2, e2) {
    var a = time(s1), b = time(e1), c = time(s2), d = time(e2);
    if ([a, b, c, d].some(function (t) { return !Number.isFinite(t); })) return false;
    if (b <= a || d <= c) return false;
    return a < d && c < b;
  }

  function envInBounds(temp, hum, bounds) {
    var b = bounds || BOUNDS;
    var t = num(temp), h = num(hum);
    return Number.isFinite(t) && Number.isFinite(h) &&
      t >= b.tempMin && t <= b.tempMax &&
      h >= b.humMin && h <= b.humMax;
  }

  // 失重比例 =（初重 - 当前重）/ 初重
  function lossRatio(initialWeight, currentWeight) {
    var i = num(initialWeight), w = num(currentWeight);
    if (!(i > 0) || !Number.isFinite(w)) return null;
    return (i - w) / i;
  }

  function tierOf(ratio) {
    if (!Number.isFinite(ratio)) return null;
    for (var i = 0; i < TIERS.length; i++) {
      if (ratio >= TIERS[i].lo && ratio < TIERS[i].hi) return TIERS[i];
    }
    return null;
  }

  // 柜位冲突：同柜位且时段重叠。draftItems 与在柜绑定查、草稿内部也互查。
  // bindings: [{ itemId, cabinetId, start, end }]
  function findConflicts(items, bindings) {
    var issues = [];
    function sameCab(a, b) { return a.cabinetId && a.cabinetId === b.cabinetId; }

    for (var i = 0; i < items.length; i++) {
      for (var j = i + 1; j < items.length; j++) {
        if (sameCab(items[i], items[j]) &&
            periodsOverlap(items[i].start, items[i].end, items[j].start, items[j].end)) {
          issues.push({
            type: "单内柜位重叠",
            itemIndex: i, otherIndex: j,
            cabinetId: items[i].cabinetId
          });
        }
      }
      for (var k = 0; k < bindings.length; k++) {
        var bd = bindings[k];
        if (sameCab(items[i], bd) &&
            periodsOverlap(items[i].start, items[i].end, bd.start, bd.end)) {
          issues.push({
            type: "与在柜绑定重叠",
            itemIndex: i, cabinetId: items[i].cabinetId,
            against: bd.itemId, againstStart: bd.start, againstEnd: bd.end
          });
        }
      }
    }
    return issues;
  }

  // 单条目判定：
  //   recheck —— 入柜越界或缺初重，只列待复检
  //   ready   —— 复检换人 + 隔满 24h + 连续两次失重同档，可上金粉
  //   drying  —— 尚在阴干（续干），reasons 给出全部卡点
  function judge(item, now) {
    var hasInitial = num(item.initialWeight) > 0;
    var entryEnvOk = envInBounds(item.temp, item.humidity);

    if (!hasInitial || !entryEnvOk) {
      var r0 = [];
      if (!hasInitial) r0.push("缺初重，需复检补录");
      if (!entryEnvOk) r0.push("入柜温湿度越界，需复检确认环境");
      return { verdict: "recheck", reasons: r0 };
    }

    // 胎体/纹样/柜位履历变更后许可即止：resetAt 之前的复检不再计入；
    // 越界复核通过时 dryingStartAt 之后的复检才计入。
    var floor = -Infinity;
    if (item.dryingStartAt) floor = Math.max(floor, time(item.dryingStartAt));
    if (item.resetAt) floor = Math.max(floor, time(item.resetAt));

    var ms = (item.measurements || [])
      .filter(function (m) { return time(m.at) >= floor; })
      .sort(function (a, b) { return time(a.at) - time(b.at); });

    var reasons = [];
    if (ms.length < 2) reasons.push("有效复检不足两次（当前 " + ms.length + " 次）");

    var ready = ms.length >= 2;
    if (ms.length >= 2) {
      var m1 = ms[ms.length - 2], m2 = ms[ms.length - 1];
      var gap = time(m2.at) - time(m1.at);
      var r1 = lossRatio(item.initialWeight, m1.weight);
      var r2 = lossRatio(item.initialWeight, m2.weight);
      var t1 = tierOf(r1), t2 = tierOf(r2);

      if (!m2.inspector || m2.inspector === item.person) {
        ready = false;
        reasons.push("复检须换人（末次复检人仍是责任人 " + item.person + "）");
      }
      if (gap < 24 * HOUR) {
        ready = false;
        reasons.push("两次复检间隔未满 24 小时（当前 " + (gap / HOUR).toFixed(1) + " 小时）");
      }
      if (!(t1 && t2 && t1.key === t2.key)) {
        ready = false;
        reasons.push("连续两次失重比例不同档（" +
          (t1 ? t1.label : "无效") + " / " + (t2 ? t2.label : "无效") + "）");
      }
    }

    return {
      verdict: ready ? "ready" : "drying",
      reasons: reasons,
      qualifying: ms.length
    };
  }

  // 待办：在柜（未上金粉）条目按判定分三类
  function todos(activeItems, now) {
    var out = { recheck: [], drying: [], ready: [] };
    activeItems.forEach(function (entry) {
      var j = judge(entry.item, now);
      out[j.verdict].push({ order: entry.order, item: entry.item, judgment: j });
    });
    return out;
  }

  g.DryingRules = {
    HOUR: HOUR,
    BOUNDS: BOUNDS,
    TIERS: TIERS,
    num: num,
    time: time,
    periodsOverlap: periodsOverlap,
    envInBounds: envInBounds,
    lossRatio: lossRatio,
    tierOf: tierOf,
    findConflicts: findConflicts,
    judge: judge,
    todos: todos
  };
})(typeof window !== "undefined" ? window : globalThis);
