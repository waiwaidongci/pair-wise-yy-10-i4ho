/*
 * 存档块：只追加的事件日志（localStorage 持久化）。
 * 所有写操作都是命令 → 校验 → 追加事件 → 重算投影；页面永不直接改状态。
 * 关键性质：
 *  - 提交按 token 幂等：重复投递直接读回原单（无论原单被收还是被退）。
 *  - 冲突整单退回：一单只落一条 orderRejected，不产生任何绑定残单。
 *  - 胎体/纹样/柜位履历变更：permitInvalidated 快照旧条目留档，许可版本 +1，按新值重算。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./rules.js'));
  }
  root.Store = factory(root.Rules);
})(typeof self !== 'undefined' ? self : this, function (Rules) {
  'use strict';

  const STORAGE_KEY = 'zfl42LedgerV1';
  const LEGACY_KEY = 'zfl42Works';

  function uid() {
    return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function freshState() {
    return { settings: Object.assign({}, Rules.DEFAULTS), events: [] };
  }

  // 首次启动沿用当前作品：从旧版工坊应用迁移作品静态档案；没有旧数据则种三件示例作品。
  function bootstrapState() {
    const state = freshState();
    const push = (ev) => state.events.push(Object.assign({ id: uid(), at: Date.now() }, ev));
    const legacy = readJSON(localStorage.getItem(LEGACY_KEY));
    const works = Array.isArray(legacy) ? legacy : null;
    if (works) {
      works.forEach((w) => push({
        type: 'workRegistered',
        workId: w.id || uid(),
        base: w.base || '', theme: w.theme || '', line: w.line || '', note: w.note || '',
        migrated: true
      }));
    } else {
      [
        { base: '木胎香盒', theme: '海水江崖', line: '细线', note: '边线需保持低浮雕感' },
        { base: '脱胎盘', theme: '折枝梅', line: '混合线', note: '客户要求金粉偏暗' },
        { base: '竹胎笔筒', theme: '云雷纹', line: '中线', note: '' }
      ].forEach((w) => push(Object.assign({ type: 'workRegistered', workId: uid() }, w)));
    }
    return state;
  }

  function readJSON(text) {
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }

  function snapshotBooking(b, reason, evId, at) {
    return {
      archiveId: evId, bookingId: b.bookingId, orderNo: b.orderNo, reason,
      version: b.permitVersion, at,
      workId: b.workId, workLabel: b.workLabel, base: b.base, theme: b.theme,
      cabinet: b.cabinet, start: b.start, end: b.end,
      checkIn: b.checkIn ? Object.assign({}, b.checkIn) : null,
      measurements: b.measurements.map((m) => Object.assign({}, m))
    };
  }

  function project(events, settings, now) {
    now = now || Date.now();
    const works = new Map();
    const bookings = new Map();
    const receipts = new Map();
    const archives = [];

    function invalidate(b, reason, evId, at, opts) {
      opts = opts || {};
      if (b.checkIn || b.measurements.length) archives.push(snapshotBooking(b, reason, evId, at));
      b.permitVersion += 1;
      b.checkIn = null;
      b.measurements = [];
      if (opts.toReserved) b.status = 'reserved';
      b.chain = null;
    }

    events.forEach((ev) => {
      switch (ev.type) {
        case 'workRegistered':
          works.set(ev.workId, {
            workId: ev.workId, base: ev.base, theme: ev.theme, line: ev.line, note: ev.note
          });
          break;
        case 'workAmended': {
          const w = works.get(ev.workId);
          if (w) Object.assign(w, ev.changes);
          bookings.forEach((b) => {
            if (b.workId !== ev.workId || b.canceled || b.status === 'gilded') return;
            invalidate(b, ev.reason, ev.id, ev.at);
            b.base = ev.changes.base !== undefined ? ev.changes.base : b.base;
            b.theme = ev.changes.theme !== undefined ? ev.changes.theme : b.theme;
          });
          break;
        }
        case 'orderAccepted': {
          ev.items.forEach((it) => {
            const w = works.get(it.workId);
            bookings.set(it.bookingId, {
              bookingId: it.bookingId, itemId: it.itemId, orderNo: ev.orderNo, token: ev.token,
              workId: it.workId, cabinet: it.cabinet, start: it.start, end: it.end,
              workLabel: it.workLabel, base: it.base, theme: it.theme,
              permitVersion: 1, status: 'reserved', checkIn: null, measurements: [], chain: null,
              createdAt: ev.at
            });
          });
          receipts.set(ev.token, {
            token: ev.token, orderNo: ev.orderNo, accepted: true, at: ev.at,
            items: ev.items.map((it) => ({
              itemId: it.itemId, workLabel: it.workLabel, cabinet: it.cabinet,
              start: it.start, end: it.end, bookingId: it.bookingId
            }))
          });
          break;
        }
        case 'orderRejected':
          receipts.set(ev.token, {
            token: ev.token, orderNo: ev.orderNo, accepted: false, at: ev.at,
            items: ev.items.map((it) => ({
              itemId: it.itemId, workLabel: it.workLabel, cabinet: it.cabinet,
              start: it.start, end: it.end
            })),
            conflicts: ev.conflicts
          });
          break;
        case 'bookingRescheduled': {
          const b = bookings.get(ev.bookingId);
          if (!b) break;
          // 仅已取得的在柜许可需要即止；未入柜的预占直接更新时段
          if (b.checkIn || b.measurements.length) invalidate(b, '柜位时段履历变更，许可即止', ev.id, ev.at);
          b.start = ev.start; b.end = ev.end;
          break;
        }
        case 'bookingMoved': {
          const b = bookings.get(ev.bookingId);
          if (!b) break;
          if (b.checkIn || b.measurements.length) invalidate(b, '柜位履历变更，许可即止', ev.id, ev.at);
          b.cabinet = ev.newCabinet;
          break;
        }
        case 'bookingCanceled': {
          const b = bookings.get(ev.bookingId);
          if (!b) break;
          if (b.checkIn || b.measurements.length) archives.push(snapshotBooking(b, '退柜注销，旧许可留档', ev.id, ev.at));
          b.canceled = true; b.status = 'canceled';
          break;
        }
        case 'checkedIn': {
          const b = bookings.get(ev.bookingId);
          if (!b || b.canceled || b.status === 'gilded') break;
          if (ev.version !== b.permitVersion) break;
          b.status = 'inRoom';
          b.checkIn = { weight: ev.weight, temp: ev.temp, humidity: ev.humidity, by: ev.by, at: ev.at };
          if (ev.weight > 0) b.measurements.push({ kind: 'initial', weight: ev.weight, temp: ev.temp, humidity: ev.humidity, by: ev.by, at: ev.at });
          break;
        }
        case 'initialSupplied': {
          const b = bookings.get(ev.bookingId);
          if (!b || b.canceled || ev.version !== b.permitVersion) break;
          b.measurements = b.measurements.filter((m) => m.kind !== 'initial');
          b.measurements.unshift({ kind: 'initial', weight: ev.weight, temp: null, humidity: null, by: ev.by, at: ev.at });
          break;
        }
        case 'rechecked': {
          const b = bookings.get(ev.bookingId);
          if (!b || b.canceled || b.status === 'gilded' || ev.version !== b.permitVersion) break;
          b.measurements.push({ kind: 'recheck', weight: ev.weight, temp: ev.temp, humidity: ev.humidity, by: ev.by, at: ev.at });
          break;
        }
        case 'goldApplied': {
          const b = bookings.get(ev.bookingId);
          if (!b || b.canceled || ev.version !== b.permitVersion) break;
          b.status = 'gilded';
          b.gold = { by: ev.by, at: ev.at };
          break;
        }
      }
    });

    // 派生判定：列表、待办、重算共用同一份结果
    const bookingList = [];
    const todos = [];
    bookings.forEach((b) => {
      const view = deriveBooking(b, settings, now);
      bookingList.push(view);
      if (view.state === 'reserved') todos.push({ kind: 'checkin', bookingId: view.bookingId, text: `待入柜：${view.workLabel} → 柜位 ${view.cabinet}`, dueAt: view.start });
      if (view.state === 'reentry') todos.push({ kind: 'checkin', bookingId: view.bookingId, text: `履历变更后待重新登记入柜：${view.workLabel}（柜位 ${view.cabinet}）`, dueAt: now });
      if (view.state === 'recheck') todos.push({ kind: 'recheck', bookingId: view.bookingId, text: `待复检：${view.workLabel}（${view.entryIssues.join('；') || view.chain.why.join('；')}）`, dueAt: now });
      if (view.state === 'drying' && view.chain.nextDueAt !== null && view.chain.nextDueAt <= now) {
        todos.push({ kind: 'recheck', bookingId: view.bookingId, text: `复检到期：${view.workLabel}（柜位 ${view.cabinet}）`, dueAt: view.chain.nextDueAt });
      }
      if (view.state === 'readyGold') todos.push({ kind: 'gold', bookingId: view.bookingId, text: `可上金粉：${view.workLabel}（连续两次同档：${view.chain.marks[view.chain.marks.length - 1].band.label}）`, dueAt: now });
    });
    todos.sort((a, b) => a.dueAt - b.dueAt);

    bookingList.sort((a, b) => b.createdAt - a.createdAt);
    const receiptList = Array.from(receipts.values()).sort((a, b) => b.at - a.at);

    return {
      works: Array.from(works.values()),
      bookings: bookingList,
      receipts: receiptList,
      archives: archives.sort((a, b) => b.at - a.at),
      events,
      settings,
      todos,
      digest: digest(bookingList, works.size, todos.length, events.length)
    };
  }

  function deriveBooking(b, settings, now) {
    const issues = [];
    let chain = { marks: [], canGold: false, why: [], nextDueAt: null };

    if (b.canceled) return Object.assign({}, b, { chain, entryIssues: issues, state: 'canceled' });
    if (b.status === 'gilded') return Object.assign({}, b, { chain, entryIssues: issues, state: 'gilded' });
    if (b.status === 'reserved') return Object.assign({}, b, { chain, entryIssues: issues, state: 'reserved' });

    // inRoom，当前许可版本
    if (!b.checkIn) {
      return Object.assign({}, b, { chain, entryIssues: ['履历已重算，请重新登记初重/温湿度/责任人'], state: 'reentry' });
    }
    const initial = b.measurements.find((m) => m.kind === 'initial') || null;
    if (!(b.checkIn.weight > 0)) issues.push('缺初重');
    const envReading = lastReading(b.measurements) || b.checkIn;
    if (!(envReading.temp >= settings.tempMin && envReading.temp <= settings.tempMax)) {
      issues.push(`温度越界（允许 ${settings.tempMin}～${settings.tempMax}℃，最近实测 ${envReading.temp ?? '空'}℃）`);
    }
    if (!(envReading.humidity >= settings.humMin && envReading.humidity <= settings.humMax)) {
      issues.push(`湿度越界（允许 ${settings.humMin}～${settings.humMax}%，最近实测 ${envReading.humidity ?? '空'}%）`);
    }
    chain = Rules.evaluateChain(b.measurements, settings);

    let state;
    if (issues.length) state = 'recheck';
    else if (chain.canGold) state = 'readyGold';
    else state = 'drying';
    return Object.assign({}, b, { chain, entryIssues: issues, state });
  }

  function lastReading(ms) {
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i].temp !== null && ms[i].temp !== undefined) return ms[i];
    }
    return null;
  }

  function digest(bookingList, workCount, todoCount, eventCount) {
    const sig = bookingList.map((b) => [
      b.bookingId, b.permitVersion, b.status, b.state,
      b.checkIn ? 1 : 0, b.measurements.length,
      b.chain.canGold ? 1 : 0, b.canceled ? 1 : 0
    ].join(':')).join('|');
    return { workCount, todoCount, eventCount, bookingCount: bookingList.length, sig };
  }

  function createStore() {
    let state = readJSON(localStorage.getItem(STORAGE_KEY));
    let seeded = false;
    if (!state || !Array.isArray(state.events)) {
      state = bootstrapState();
      seeded = true;
      persist();
    } else {
      state.settings = Object.assign({}, Rules.DEFAULTS, state.settings || {});
    }

    function persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function append(ev) {
      const full = Object.assign({ id: uid(), at: Date.now() }, ev);
      state.events.push(full);
      return full;
    }

    function activeIntervals(now) {
      return project(state.events, state.settings, now).bookings
        .filter((b) => b.status === 'reserved' || b.status === 'inRoom')
        .map((b) => ({
          bookingId: b.bookingId, workId: b.workId, cabinet: b.cabinet,
          start: b.start, end: b.end, label: `${b.workLabel}（单号 ${b.orderNo}）`
        }));
    }

    const commands = {
      registerWork(input) {
        const workId = uid();
        append({ type: 'workRegistered', workId, base: input.base.trim(), theme: input.theme.trim(), line: input.line, note: (input.note || '').trim() });
        persist();
        return { ok: true, workId };
      },

      amendWork(workId, changes) {
        const current = project(state.events, state.settings).works.find((w) => w.workId === workId);
        if (!current) return { ok: false, errors: ['作品不存在'] };
        const next = {
          base: changes.base !== undefined ? changes.base.trim() : current.base,
          theme: changes.theme !== undefined ? changes.theme.trim() : current.theme,
          line: changes.line !== undefined ? changes.line : current.line,
          note: changes.note !== undefined ? changes.note.trim() : current.note
        };
        if (!next.base || !next.theme) return { ok: false, errors: ['胎体材质与纹样主题不能为空'] };
        const diff = {};
        ['base', 'theme', 'line', 'note'].forEach((k) => { if (next[k] !== current[k]) diff[k] = next[k]; });
        if (!Object.keys(diff).length) return { ok: true, changed: false };
        const permitHit = ('base' in diff || 'theme' in diff) &&
          project(state.events, state.settings).bookings.some((b) => b.workId === workId && !b.canceled && b.status !== 'gilded');
        append({
          type: 'workAmended', workId, changes: diff, oldSnapshot: Object.assign({}, current),
          reason: ('base' in diff || 'theme' in diff) ? '胎体/纹样变更，许可即止' : '作品资料修订'
        });
        persist();
        return { ok: true, changed: true, permitsReset: !!permitHit };
      },

      // 投递绑柜单：token 相同 → 读回原单；冲突整单退回。
      submitOrder(token, rawItems) {
        const prior = state.events.find((e) => (e.type === 'orderAccepted' || e.type === 'orderRejected') && e.token === token);
        if (prior) {
          const receipt = project(state.events, state.settings).receipts.find((r) => r.token === token);
          return { ok: receipt.accepted, duplicate: true, receipt };
        }
        const now = Date.now();
        const works = project(state.events, state.settings, now).works;
        const items = rawItems.map((it) => {
          const w = works.find((x) => x.workId === it.workId);
          return {
            itemId: uid(),
            workId: it.workId,
            cabinet: (it.cabinet || '').trim(),
            start: it.start, end: it.end,
            workLabel: w ? `${w.theme}·${w.base}` : '已删作品',
            base: w ? w.base : '', theme: w ? w.theme : ''
          };
        });
        const check = Rules.validateOrder(items, activeIntervals(now));
        const orderNo = 'B' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' +
          String(state.events.filter((e) => e.type === 'orderAccepted' || e.type === 'orderRejected').length + 1).padStart(3, '0');

        if (!check.ok) {
          append({
            type: 'orderRejected', token, orderNo, at: now,
            items: items.map(({ itemId, workId, cabinet, start, end, workLabel, base, theme }) => ({
              itemId, workId, cabinet, start, end, workLabel, base, theme
            })),
            conflicts: check.conflicts.map((c) => Rules.conflictText(c, items))
          });
          persist();
          return { ok: false, duplicate: false, receipt: project(state.events, state.settings, now).receipts.find((r) => r.token === token) };
        }
        const withIds = items.map((it) => Object.assign({}, it, { bookingId: uid() }));
        append({
          type: 'orderAccepted', token, orderNo, at: now,
          items: withIds
        });
        persist();
        return { ok: true, duplicate: false, receipt: project(state.events, state.settings, now).receipts.find((r) => r.token === token) };
      },

      rescheduleBooking(bookingId, start, end) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled || b.status === 'gilded') return { ok: false, errors: ['当前绑定不能改时'] };
        if (!(start > 0) || !(end > 0) || start >= end) return { ok: false, errors: ['时间区间无效'] };
        const clash = activeIntervals().find((a) => a.bookingId !== bookingId && a.cabinet === b.cabinet && Rules.overlap({ start, end }, a));
        if (clash) return { ok: false, errors: [`柜位时段重叠：${clash.label}`] };
        append({ type: 'bookingRescheduled', bookingId, start, end, oldStart: b.start, oldEnd: b.end, permitReset: !!(b.checkIn || b.measurements.length) });
        persist();
        return { ok: true };
      },

      moveCabinet(bookingId, newCabinet) {
        newCabinet = (newCabinet || '').trim();
        if (!newCabinet) return { ok: false, errors: ['未填新柜位'] };
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled || b.status === 'gilded') return { ok: false, errors: ['当前绑定不能移柜'] };
        const clash = activeIntervals().find((a) => a.bookingId !== bookingId && a.cabinet === newCabinet && Rules.overlap(b, a));
        if (clash) return { ok: false, errors: [`新柜位时段重叠：${clash.label}`] };
        append({ type: 'bookingMoved', bookingId, oldCabinet: b.cabinet, newCabinet });
        persist();
        return { ok: true };
      },

      cancelBooking(bookingId) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled) return { ok: false, errors: ['绑定不存在或已注销'] };
        append({ type: 'bookingCanceled', bookingId });
        persist();
        return { ok: true };
      },

      checkIn(bookingId, input) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled || b.status === 'gilded') return { ok: false, errors: ['绑定不存在或已结束'] };
        if (!input.by || !input.by.trim()) return { ok: false, errors: ['责任人必填'] };
        const temp = Number(input.temp), humidity = Number(input.humidity);
        if (Number.isNaN(temp) || Number.isNaN(humidity)) return { ok: false, errors: ['温湿度无效'] };
        const weight = input.weight === '' || input.weight === null ? null : Number(input.weight);
        if (weight !== null && (!(weight > 0) || Number.isNaN(weight))) return { ok: false, errors: ['初重须为正数；如缺初重请留空，列待复检'] };
        append({
          type: 'checkedIn', bookingId, weight, temp, humidity, by: input.by.trim(), at: input.at || Date.now(),
          version: b.permitVersion
        });
        persist();
        return { ok: true };
      },

      supplyInitial(bookingId, weight, by, at) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled || b.status !== 'inRoom') return { ok: false, errors: ['当前状态不能补初重'] };
        const w = Number(weight);
        if (!(w > 0)) return { ok: false, errors: ['初重须为正数'] };
        if (!by || !by.trim()) return { ok: false, errors: ['责任人必填'] };
        append({ type: 'initialSupplied', bookingId, weight: w, by: by.trim(), at: at || Date.now(), version: b.permitVersion });
        persist();
        return { ok: true };
      },

      recheck(bookingId, input) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.canceled || b.status !== 'inRoom') return { ok: false, errors: ['当前状态不能复检'] };
        if (!b.measurements.some((m) => m.kind === 'initial' && m.weight > 0)) {
          return { ok: false, errors: ['尚缺初重，请先补录初重'] };
        }
        const weight = Number(input.weight), temp = Number(input.temp), humidity = Number(input.humidity);
        if (!(weight > 0) || Number.isNaN(temp) || Number.isNaN(humidity)) return { ok: false, errors: ['复检记录无效'] };
        if (!input.by || !input.by.trim()) return { ok: false, errors: ['复检人必填'] };
        const at = input.at || Date.now();
        const trial = Rules.evaluateChain(
          b.measurements.concat([{ kind: 'recheck', weight, temp, humidity, by: input.by.trim(), at }]),
          state.settings
        );
        append({
          type: 'rechecked', bookingId, weight, temp, humidity, by: input.by.trim(), at,
          compliant: trial.marks[trial.marks.length - 1].compliant,
          version: b.permitVersion
        });
        persist();
        return { ok: true, mark: trial.marks[trial.marks.length - 1] };
      },

      applyGold(bookingId, by, at) {
        const p = project(state.events, state.settings);
        const b = p.bookings.find((x) => x.bookingId === bookingId);
        if (!b || b.state !== 'readyGold') return { ok: false, errors: ['判定未通过，不可上金粉'] };
        if (!by || !by.trim()) return { ok: false, errors: ['操作人必填'] };
        append({ type: 'goldApplied', bookingId, by: by.trim(), at: at || Date.now(), version: b.permitVersion });
        persist();
        return { ok: true };
      },

      saveSettings(next) {
        const s = Object.assign({}, state.settings);
        ['tempMin', 'tempMax', 'humMin', 'humMax'].forEach((k) => {
          const v = Number(next[k]);
          if (!Number.isNaN(v)) s[k] = v;
        });
        if (s.tempMin >= s.tempMax || s.humMin >= s.humMax) return { ok: false, errors: ['阈值下限须小于上限'] };
        state.settings = s;
        persist();
        return { ok: true, settings: s };
      },

      importAll(next) {
        if (!next || !Array.isArray(next.events)) return { ok: false, errors: ['文件格式不正确'] };
        state = { settings: Object.assign({}, Rules.DEFAULTS, next.settings || {}), events: next.events };
        persist();
        return { ok: true };
      },

      resetAll() {
        state = bootstrapState();
        persist();
        return { ok: true };
      }
    };

    return {
      commands,
      get raw() { return state; },
      get seeded() { return seeded; },
      project: (now) => project(state.events, state.settings, now),
      reload() {
        const before = project(state.events, state.settings).digest;
        const disk = readJSON(localStorage.getItem(STORAGE_KEY));
        if (disk && Array.isArray(disk.events)) state = disk;
        const after = project(state.events, state.settings).digest;
        return { same: before.sig === after.sig && before.eventCount === after.eventCount, before, after };
      },
      exportJSON() {
        return JSON.stringify({ app: 'zfl-42-ledger', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, events: state.events }, null, 2);
      }
    };
  }

  return { createStore, STORAGE_KEY, project, uid };
});
