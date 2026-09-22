/*
 * 判定块（纯函数，无 DOM、无持久化）
 * 负责：柜位时段冲突、入柜异常、失重档位、复检/上金粉资格判定。
 * 页面与存档都只调用这里的规则，保证列表、待办、重算结果同源一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;

  // 判定参数（可在「履历存档」页调整，调整后按新值重算；不触发许可作废）
  const DEFAULTS = {
    tempMin: 18,        // 入柜温度下限 ℃
    tempMax: 26,        // 入柜温度上限 ℃
    humMin: 50,         // 入柜湿度下限 %
    humMax: 70,         // 入柜湿度上限 %
    recheckGapMs: 24 * HOUR, // 复检间隔：隔满廿四小时
    // 失重比例档位（百分比）。连续两次落在同档即视为趋稳。
    bands: [
      { id: 'gain', label: '返潮', test: (r) => r < 0 },
      { id: 'stable', label: '稳定档', test: (r) => r >= 0 && r < 0.2 },
      { id: 'light', label: '轻失档', test: (r) => r >= 0.2 && r < 0.5 },
      { id: 'mid', label: '中失档', test: (r) => r >= 0.5 && r < 1.0 },
      { id: 'fast', label: '急失档', test: (r) => r >= 1.0 }
    ]
  };

  function withDefaults(settings) {
    return Object.assign({}, DEFAULTS, settings || {});
  }

  // 半开区间 [start, end)：首尾相接不算重叠
  function overlap(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  /*
   * 整单校验：任一条目不合格或冲突，整单退回，不留残单。
   * items : [{ workId, cabinet, start(ms), end(ms) }]
   * active: 在柜有效绑定 [{ bookingId, workId, cabinet, start, end, label }]
   * 返回 { ok, conflicts:[{ index, code, against?, label?, start?, end? }] }
   */
  function validateOrder(items, active) {
    const conflicts = [];
    items.forEach((it, i) => {
      if (!it.workId) conflicts.push({ index: i, code: 'EMPTY_WORK' });
      if (!it.cabinet) conflicts.push({ index: i, code: 'EMPTY_CABINET' });
      if (!(it.start > 0) || !(it.end > 0)) {
        conflicts.push({ index: i, code: 'BAD_TIME' });
      } else if (it.start >= it.end) {
        conflicts.push({ index: i, code: 'REVERSED_TIME' });
      }
    });
    if (conflicts.length) return { ok: false, conflicts };

    items.forEach((it, i) => {
      for (let j = i + 1; j < items.length; j++) {
        const o = items[j];
        if (it.cabinet === o.cabinet && overlap(it, o)) {
          conflicts.push({ index: i, code: 'INTRA_CABINET', against: j });
        }
        if (it.workId === o.workId && overlap(it, o)) {
          conflicts.push({ index: i, code: 'INTRA_WORK', against: j });
        }
      }
      active.forEach((a) => {
        if (a.cabinet === it.cabinet && overlap(a, it)) {
          conflicts.push({ index: i, code: 'CABINET_BUSY', against: a.bookingId, label: a.label, start: a.start, end: a.end });
        }
        if (a.workId === it.workId && overlap(a, it)) {
          conflicts.push({ index: i, code: 'WORK_BUSY', against: a.bookingId, label: a.label, start: a.start, end: a.end });
        }
      });
    });
    return { ok: conflicts.length === 0, conflicts };
  }

  function conflictText(c, items) {
    const it = items[c.index] || {};
    switch (c.code) {
      case 'EMPTY_WORK': return `第 ${c.index + 1} 行未选作品`;
      case 'EMPTY_CABINET': return `第 ${c.index + 1} 行未填柜位`;
      case 'BAD_TIME': return `第 ${c.index + 1} 行时间无效`;
      case 'REVERSED_TIME': return `第 ${c.index + 1} 行开始时间须早于结束时间`;
      case 'INTRA_CABINET': return `第 ${c.index + 1} 行与第 ${c.against + 1} 行同柜位「${it.cabinet}」时段重叠`;
      case 'INTRA_WORK': return `第 ${c.index + 1} 行与第 ${c.against + 1} 行为同一作品且时段重叠`;
      case 'CABINET_BUSY':
        return `第 ${c.index + 1} 行柜位「${it.cabinet}」时段重叠：已绑 ${c.label}（${fmt(c.start)} 至 ${fmt(c.end)}）`;
      case 'WORK_BUSY':
        return `第 ${c.index + 1} 行作品该时段已绑其他柜位：${c.label}（${fmt(c.start)} 至 ${fmt(c.end)}）`;
      default: return `第 ${c.index + 1} 行冲突`;
    }
  }

  // 入柜异常：环境越界或缺初重 → 只列待复检
  function entryAnomalies(checkin, settings) {
    const s = withDefaults(settings);
    const out = [];
    if (!(checkin.weight > 0)) out.push('缺初重');
    if (!(checkin.temp >= s.tempMin && checkin.temp <= s.tempMax)) {
      out.push(`温度越界（允许 ${s.tempMin}～${s.tempMax}℃，实测 ${checkin.temp ?? '空'}）`);
    }
    if (!(checkin.humidity >= s.humMin && checkin.humidity <= s.humMax)) {
      out.push(`湿度越界（允许 ${s.humMin}～${s.humMax}%，实测 ${checkin.humidity ?? '空'}）`);
    }
    return out;
  }

  function inBounds(temp, humidity, settings) {
    const s = withDefaults(settings);
    return temp >= s.tempMin && temp <= s.tempMax && humidity >= s.humMin && humidity <= s.humMax;
  }

  // 失重比例（百分比）= (上次重量 - 本次重量) / 上次重量 × 100
  function lossRatio(prevWeight, weight) {
    if (!(prevWeight > 0)) return null;
    return (prevWeight - weight) / prevWeight * 100;
  }

  function bandOf(ratio, settings) {
    if (ratio === null || Number.isNaN(ratio)) return null;
    const s = withDefaults(settings);
    return s.bands.find((b) => b.test(ratio)) || null;
  }

  /*
   * 复检链判定。
   * measurements 按登记顺序：[{ kind:'initial', weight, at, by }, { kind:'recheck', ... }]
   * 规则：复检换人、距上次称重隔满 24h、连续两次失重比例同档 → 可上金粉，否则续干。
   */
  function evaluateChain(measurements, settings) {
    const s = withDefaults(settings);
    const initial = measurements.find((m) => m.kind === 'initial') || null;
    const rechecks = measurements.filter((m) => m.kind === 'recheck');

    const marks = rechecks.map((rc, i) => {
      const prev = i === 0 ? initial : rechecks[i - 1];
      const reasons = [];
      if (!prev || !(prev.weight > 0)) reasons.push('缺初重，无法计算失重比例');
      if (prev && rc.by === prev.by) reasons.push('复检未换人');
      if (prev && rc.at - prev.at < s.recheckGapMs) reasons.push('距上次称重未满廿四小时');
      const ratio = prev ? lossRatio(prev.weight, rc.weight) : null;
      return {
        at: rc.at, by: rc.by, weight: rc.weight, temp: rc.temp, humidity: rc.humidity,
        ratio, band: bandOf(ratio, s), reasons,
        compliant: reasons.length === 0 && ratio !== null
      };
    });

    const why = [];
    if (!initial || !(initial.weight > 0)) why.push('尚缺初重');
    if (rechecks.length < 2) why.push(`连续两次合规复检尚缺 ${Math.max(0, 2 - rechecks.length)} 次`);

    let canGold = false;
    if (rechecks.length >= 2) {
      const a = marks[marks.length - 2];
      const b = marks[marks.length - 1];
      if (!a.compliant || !b.compliant) why.push('最近两次复检含不合规项（换人／廿四小时）');
      if (a.band && b.band && a.band.id !== b.band.id) {
        why.push(`两次失重比例不同档（${a.band.label}／${b.band.label}），续干`);
      }
      canGold = a.compliant && b.compliant && !!a.band && !!b.band && a.band.id === b.band.id;
    }

    const last = measurements[measurements.length - 1];
    return {
      marks, canGold, why,
      nextDueAt: last && last.weight > 0 ? last.at + s.recheckGapMs : null
    };
  }

  function fmt(ms) {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  }

  return {
    DEFAULTS, HOUR, withDefaults, overlap, validateOrder, conflictText,
    entryAnomalies, inBounds, lossRatio, bandOf, evaluateChain, fmt
  };
});
