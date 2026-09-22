/*
 * 页面块：只读投影、发起命令，不含任何判定逻辑。
 * 每次 render() 只做一次 project()，列表、待办、顶栏计数都取自同一份快照，
 * 因此页面展示、待办队列与「从存档重载」结果天然一致。
 */
(function () {
  'use strict';

  const store = Store.createStore();
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  let snapshot = null;
  let token = crypto.randomUUID();
  let workFilter = '';
  let textFilter = '';
  let statusFilter = '';
  let activeTab = 'ledger';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dt = (ms) => ms ? Rules.fmt(ms) : '—';
  const day = (ms) => ms ? new Date(ms).toLocaleDateString('zh-CN') : '—';
  const toLocalInput = (ms) => {
    const d = new Date(ms || Date.now());
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const parseLocal = (v) => {
    const ms = v ? new Date(v).getTime() : NaN;
    return Number.isNaN(ms) ? 0 : ms;
  };

  const stateMeta = {
    reserved: { label: '待入柜', cls: 'badge-violet' },
    inRoom: { label: '在柜', cls: 'badge-teal' },
    gilded: { label: '已上金粉', cls: 'badge-gold' },
    canceled: { label: '已注销', cls: 'badge-muted' },
    reentry: { label: '待重新登记', cls: 'badge-red' },
    recheck: { label: '待复检', cls: 'badge-red' },
    drying: { label: '续干中', cls: 'badge-amber' },
    readyGold: { label: '可上金粉', cls: 'badge-gold' }
  };

  const GROUP_ORDER = [
    ['readyGold', '可上金粉'], ['recheck', '待复检'], ['reentry', '待重新登记'],
    ['drying', '续干中'], ['reserved', '待入柜'], ['gilded', '已上金粉'], ['canceled', '已注销']
  ];

  function render() {
    snapshot = store.project();
    renderTabs();
    renderWorks();
    renderLedger();
    renderTodos();
    renderArchive();
    renderReceiptBox();
    $('#digest').textContent =
      `作品 ${snapshot.works.length} 件 · 在柜 ${snapshot.bookings.filter(b => ['recheck', 'drying', 'readyGold', 'reentry'].includes(b.state)).length} 件 · 待办 ${snapshot.todos.length} 项 · 事件 ${snapshot.events.length} 条`;
  }

  function renderTabs() {
    $$('.tab').forEach((btn) => btn.classList.toggle('on', btn.dataset.tab === activeTab));
    $$('.view').forEach((v) => v.classList.toggle('show', v.id === 'view-' + activeTab));
    $('#tabTodo').textContent = `待办${snapshot.todos.length ? `（${snapshot.todos.length}）` : ''}`;
  }

  function renderWorks() {
    $('#workList').innerHTML = snapshot.works.map((w) => `
      <div class="witem ${workFilter === w.workId ? 'pick' : ''}" data-action="filterWork" data-id="${w.workId}">
        <b>${esc(w.theme)}</b>
        <div class="meta">${esc(w.base)} · ${esc(w.line || '—')}</div>
      </div>`).join('') || `<div class="empty">暂无作品</div>`;
    const opts = snapshot.works.map((w) => `<option value="${w.workId}">${esc(w.theme)} · ${esc(w.base)}</option>`).join('');
    $$('select.workSel').forEach((sel) => {
      const cur = sel.value;
      sel.innerHTML = opts;
      if (cur) sel.value = cur;
    });
  }

  function bookingCard(b) {
    const meta = stateMeta[b.state];
    const issues = b.entryIssues.length
      ? `<div class="flag red">入柜异常：${esc(b.entryIssues.join('；'))}</div>` : '';
    const ci = b.checkIn;
    const ciLine = ci
      ? `初重 ${ci.weight ? ci.weight.toFixed(2) + ' g' : '缺'} · ${ci.temp}℃ / ${ci.humidity}% · 责任人 ${esc(ci.by)} · ${dt(ci.at)}`
      : '尚未登记入柜';
    const rows = b.chain.marks.map((m, i) => {
      const ratio = m.ratio === null || m.ratio === undefined ? '—' : m.ratio.toFixed(3) + '%';
      const band = m.band ? m.band.label : '—';
      return `<tr class="${m.compliant ? '' : 'bad'}">
        <td>${i + 1}</td><td>${dt(m.at)}</td><td>${esc(m.by)}</td>
        <td>${m.weight.toFixed(2)}</td><td>${m.temp ?? '—'}℃/${m.humidity ?? '—'}%</td>
        <td>${ratio}</td><td>${esc(band)}</td>
        <td>${m.compliant ? '合规' : '✗ ' + esc(m.reasons.join('；'))}</td>
      </tr>`;
    }).join('');
    const measureTable = b.chain.marks.length ? `
      <table class="marks">
        <thead><tr><th>#</th><th>时间</th><th>操作人</th><th>重量g</th><th>温湿度</th><th>失重</th><th>档位</th><th>判定</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '';
    const why = b.state === 'drying' && b.chain.why.length ? `<div class="flag amber">${esc(b.chain.why.join('；'))}，续干</div>` : '';
    const goldLine = b.gold ? `<div class="flag gold">已于 ${dt(b.gold.at)} 由 ${esc(b.gold.by)} 上金粉，许可闭环</div>` : '';

    const actions = [];
    if (b.state === 'reserved' || b.state === 'reentry') actions.push(btn('checkin', '入柜登记', 'teal', b.bookingId));
    if (b.state === 'recheck' && !b.measurements.some(m => m.kind === 'initial' && m.weight > 0))
      actions.push(btn('initial', '补初重', 'amber', b.bookingId));
    if (b.state === 'recheck' || b.state === 'drying') actions.push(btn('recheck', '复检登记', 'teal', b.bookingId));
    if (b.state === 'readyGold') actions.push(btn('gold', '上金粉', 'gold', b.bookingId));
    if (b.status === 'reserved' || b.status === 'inRoom') {
      actions.push(btn('move', '移柜', 'violet', b.bookingId));
      actions.push(btn('resched', '改时', 'violet', b.bookingId));
      actions.push(btn('cancel', '注销', 'danger', b.bookingId));
    }
    actions.push(btn('editWork', '改作品', 'secondary', b.workId));

    return `<article class="card">
      <div class="card-head">
        <div><b>${esc(b.workLabel)}</b> <span class="badge ${meta.cls}">${meta.label}</span></div>
        <div class="meta">单号 ${esc(b.orderNo)} · 柜位 ${esc(b.cabinet)} · ${day(b.start)} 至 ${day(b.end)} · 许可版本 v${b.permitVersion}</div>
      </div>
      <div class="meta in">${ciLine}</div>
      ${issues}${why}${goldLine}${measureTable}
      <div class="card-actions">${actions.join('')}</div>
    </article>`;
  }

  function btn(action, label, cls, id) {
    return `<button class="${cls}" data-action="${action}" data-id="${id}">${label}</button>`;
  }

  function renderLedger() {
    let list = snapshot.bookings;
    if (workFilter) list = list.filter((b) => b.workId === workFilter);
    if (statusFilter) list = list.filter((b) => b.state === statusFilter);
    if (textFilter.trim()) {
      const q = textFilter.trim();
      list = list.filter((b) => b.workLabel.includes(q) || b.cabinet.includes(q) || b.orderNo.includes(q));
    }
    const groups = GROUP_ORDER.map(([key, label]) => {
      const cards = list.filter((b) => b.state === key);
      return `<section class="group ${cards.length ? '' : 'hide'}">
        <h3><span>${label}</span><span>${cards.length}</span></h3>
        <div class="cards">${cards.map(bookingCard).join('')}</div>
      </section>`;
    }).join('');
    $('#ledgerBody').innerHTML = list.length ? groups : `<div class="empty">没有符合条件的绑定，先用左侧「投递绑柜单」</div>`;
  }

  function renderTodos() {
    const body = $('#todoBody');
    if (!snapshot.todos.length) {
      body.innerHTML = `<div class="empty">当前没有待办：入柜、复检、上金粉都已跟上。</div>`;
      return;
    }
    body.innerHTML = snapshot.todos.map((t) => {
      const label = { checkin: '入柜', recheck: '复检', gold: '上金粉' }[t.kind];
      const action = { checkin: 'checkin', recheck: 'recheck', gold: 'gold' }[t.kind];
      return `<div class="todo-row">
        <div><span class="badge ${t.kind === 'gold' ? 'badge-gold' : 'badge-red'}">${label}</span>
        <b>${esc(t.text)}</b><div class="meta">节点 ${dt(t.dueAt)}</div></div>
        ${btn(action, '去处理', t.kind === 'gold' ? 'gold' : 'teal', t.bookingId)}
      </div>`;
    }).join('');
  }

  function renderArchive() {
    $('#archiveBody').innerHTML = snapshot.archives.length ? snapshot.archives.map((a) => `
      <article class="card archived">
        <div class="card-head">
          <div><b>${esc(a.workLabel)}</b> <span class="badge badge-muted">旧许可 v${a.version}</span></div>
          <div class="meta">${esc(a.reason)} · ${dt(a.at)}</div>
        </div>
        <div class="meta">原柜位 ${esc(a.cabinet)}（${day(a.start)} 至 ${day(a.end)}）· 单号 ${esc(a.orderNo)}
        ${a.checkIn ? ` · 入柜初重 ${a.checkIn.weight ? a.checkIn.weight.toFixed(2) + 'g' : '缺'}，${a.checkIn.temp}℃/${a.checkIn.humidity}%，责任人 ${esc(a.checkIn.by)}` : ''}</div>
        <div class="meta">留档称重 ${a.measurements.length} 次${a.measurements.length ? '（仅作履历，不参与新许可判定）' : ''}</div>
      </article>`).join('') : `<div class="empty">尚无作废留档（胎体/纹样/柜位变更后会在此存档）</div>`;

    $('#receiptBody').innerHTML = snapshot.receipts.length ? snapshot.receipts.slice(0, 12).map((r) => `
      <div class="receipt ${r.accepted ? 'ok' : 'no'}">
        <div><b>${r.accepted ? '✓ 已收单' : '✗ 整单退回'}</b> ${esc(r.orderNo)} <span class="meta">${dt(r.at)}</span></div>
        <div class="meta">${r.items.map((i) => `${esc(i.workLabel)}→柜位${esc(i.cabinet)}`).join('；')}</div>
        ${r.conflicts && r.conflicts.length ? `<div class="flag red">${r.conflicts.map(esc).join('；')}</div>` : '<div class="meta">无冲突，绑定已建立</div>'}
        <div class="meta">投递回执 token：${esc(r.token.slice(0, 8))}…（重复投递读回本单）</div>
      </div>`).join('') : `<div class="empty">尚无投递回执</div>`;

    $('#eventBody').innerHTML = snapshot.events.map((e) => `
      <tr><td>${dt(e.at)}</td><td>${esc(eventLabel(e.type))}</td><td>${esc(e.id.slice(4))}</td><td class="meta">${esc(eventBrief(e))}</td></tr>
    `).join('');
  }

  function eventLabel(type) {
    return {
      workRegistered: '作品建档', workAmended: '作品变更', orderAccepted: '收单',
      orderRejected: '退单', bookingRescheduled: '改时', bookingMoved: '移柜',
      bookingCanceled: '注销', checkedIn: '入柜', initialSupplied: '补初重',
      rechecked: '复检', goldApplied: '上金粉'
    }[type] || type;
  }

  function eventBrief(e) {
    switch (e.type) {
      case 'orderAccepted': return `${e.orderNo}：${e.items.length} 条绑定`;
      case 'orderRejected': return `${e.orderNo}：${e.conflicts.join('；')}`;
      case 'checkedIn': return `初重 ${e.weight ?? '缺'}，${e.temp}℃/${e.humidity}%，${e.by}`;
      case 'rechecked': return `${e.weight}g，${e.by}，${e.compliant ? '合规' : '不合规'}`;
      default: return e.reason || e.base || e.oldCabinet ? `${e.reason || ''} ${e.oldCabinet ? e.oldCabinet + '→' + (e.newCabinet || '') : ''}` : '';
    }
  }

  function renderReceiptBox() {
    const r = snapshot.receipts[0];
    if (!r) { $('#lastReceipt').innerHTML = `<div class="empty">投递后在此显示回执；重复提交同一单读回原单。</div>`; return; }
    $('#lastReceipt').innerHTML = `
      <div class="receipt ${r.accepted ? 'ok' : 'no'}">
        <b>${r.accepted ? '✓ 已收单' : '✗ 整单退回'}</b> ${esc(r.orderNo)}
        <div class="meta">${dt(r.at)}</div>
        ${r.conflicts && r.conflicts.length ? `<div class="flag red">${r.conflicts.map(esc).join('；')}</div>` : ''}
      </div>`;
  }

  // ---------- 投递单 ----------
  function orderRow() {
    const now = Date.now();
    return `<div class="orow">
      <select class="workSel" required></select>
      <input class="cab" list="cabList" required placeholder="柜位 A1">
      <input class="st" type="datetime-local" required value="${toLocalInput(now)}">
      <input class="en" type="datetime-local" required value="${toLocalInput(now + 3 * 86400000)}">
      <button type="button" class="danger delrow" data-action="delRow">×</button>
    </div>`;
  }
  function addRow() {
    $('#orderRows').insertAdjacentHTML('beforeend', orderRow());
    renderWorks();
  }

  function submitOrder() {
    const rows = $$('#orderRows .orow');
    const items = rows.map((row) => ({
      workId: row.querySelector('.workSel').value,
      cabinet: row.querySelector('.cab').value,
      start: parseLocal(row.querySelector('.st').value),
      end: parseLocal(row.querySelector('.en').value)
    }));
    const res = store.commands.submitOrder(token, items);
    const box = $('#submitResult');
    if (res.ok) {
      box.innerHTML = `<div class="banner ok">✓ 收单 ${esc(res.receipt.orderNo)}：${res.receipt.items.length} 条绑定已建立</div>`;
    } else if (res.duplicate) {
      box.innerHTML = `<div class="banner ok">↩ 重复投递：读回原单 ${esc(res.receipt.orderNo)}（${res.receipt.accepted ? '原单已收，未重复建绑' : '原单整单退回'}），未产生新条目</div>`;
    } else {
      box.innerHTML = `<div class="banner no">✗ 整单退回，不留残单：<br>${res.receipt.conflicts.map(esc).join('<br>')}</div>`;
    }
    if (res.ok) {
      token = crypto.randomUUID();
      $('#orderRows').innerHTML = orderRow() + orderRow();
      renderWorks();
    }
    render();
  }

  // ---------- 对话框 ----------
  const dialog = $('#dlg');
  function openDialog(html) {
    $('#dlgBody').innerHTML = html;
    dialog.showModal();
  }
  function closeDialog() { dialog.close(); }

  function dlgCheckin(b) {
    openDialog(`
      <h3>入柜登记 · ${esc(b.workLabel)}</h3>
      <div class="meta">柜位 ${esc(b.cabinet)} · 责任人需实名；温湿度越界或缺初重将只列待复检</div>
      <label>初重（g，缺初重请留空）<input id="f_weight" type="number" step="0.01" min="0" placeholder="留空 = 缺初重"></label>
      <div class="grid2">
        <label>温度 ℃<input id="f_temp" type="number" step="0.1" value="22" required></label>
        <label>湿度 %<input id="f_hum" type="number" step="1" value="60" required></label>
      </div>
      <div class="grid2">
        <label>责任人<input id="f_by" required placeholder="入柜责任人姓名"></label>
        <label>入柜时间<input id="f_at" type="datetime-local" value="${toLocalInput(Date.now())}"></label>
      </div>
      <div class="dlg-actions"><button id="f_ok">写入入柜</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.checkIn(b.bookingId, {
        weight: $('#f_weight').value, temp: $('#f_temp').value, humidity: $('#f_hum').value,
        by: $('#f_by').value, at: parseLocal($('#f_at').value)
      });
      if (!r.ok) return alert(r.errors.join('；'));
      const issues = Rules.entryAnomalies({
        weight: $('#f_weight').value === '' ? null : Number($('#f_weight').value),
        temp: Number($('#f_temp').value), humidity: Number($('#f_hum').value)
      }, snapshot.settings);
      closeDialog(); render();
      alert(issues.length ? `已入柜，但：${issues.join('；')}。已列入待复检。` : '入柜正常，进入续干观察。');
    };
  }

  function dlgInitial(b) {
    openDialog(`
      <h3>补录初重 · ${esc(b.workLabel)}</h3>
      <div class="meta">初重补齐后从该重量起计算复检失重比例</div>
      <div class="grid2"><label>初重 g<input id="f_weight" type="number" step="0.01" min="0.01" required></label>
      <label>责任人<input id="f_by" required></label></div>
      <label>称重时间<input id="f_at" type="datetime-local" value="${toLocalInput(Date.now())}"></label>
      <div class="dlg-actions"><button id="f_ok">补初重</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.supplyInitial(b.bookingId, $('#f_weight').value, $('#f_by').value, parseLocal($('#f_at').value));
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
    };
  }

  function dlgRecheck(b) {
    const last = b.measurements[b.measurements.length - 1];
    openDialog(`
      <h3>复检登记 · ${esc(b.workLabel)}</h3>
      <div class="meta">复检须换人，距上次称重隔满廿四小时；连续两次失重比例同档才可上金粉，否则续干。</div>
      ${last ? `<div class="meta">上次称重：${dt(last.at)} · ${esc(last.by)} · ${last.weight.toFixed(2)}g</div>` : ''}
      <div class="grid2"><label>本次重量 g<input id="f_weight" type="number" step="0.01" min="0.01" required></label>
      <label>复检人（须与上次不同）<input id="f_by" required></label></div>
      <div class="grid2"><label>温度 ℃<input id="f_temp" type="number" step="0.1" value="22" required></label>
      <label>湿度 %<input id="f_hum" type="number" step="1" value="60" required></label></div>
      <label>复检时间<input id="f_at" type="datetime-local" value="${toLocalInput(Date.now())}"></label>
      <div class="dlg-actions"><button id="f_ok">写入复检</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.recheck(b.bookingId, {
        weight: $('#f_weight').value, temp: $('#f_temp').value, humidity: $('#f_hum').value,
        by: $('#f_by').value, at: parseLocal($('#f_at').value)
      });
      if (!r.ok) return alert(r.errors.join('；'));
      const m = r.mark;
      closeDialog(); render();
      const nb = store.project().bookings.find((x) => x.bookingId === b.bookingId);
      alert(nb.state === 'readyGold'
        ? '复检合规且与上次同档：可上金粉。'
        : `本次${m.compliant ? '合规' : '不合规（' + m.reasons.join('；') + '）'}：${nb.chain.why.join('；') || '续干'}。`);
    };
  }

  function dlgGold(b) {
    openDialog(`
      <h3>上金粉 · ${esc(b.workLabel)}</h3>
      <div class="meta">判定已通过：复检换人、隔满廿四小时、连续两次失重比例同档（${esc(b.chain.marks[b.chain.marks.length - 1].band.label)}）。</div>
      <label>操作人<input id="f_by" required></label>
      <div class="dlg-actions"><button class="gold" id="f_ok">确认上金粉</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.applyGold(b.bookingId, $('#f_by').value);
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
    };
  }

  function dlgMove(b) {
    openDialog(`
      <h3>移柜 · ${esc(b.workLabel)}</h3>
      <div class="meta">柜位履历变更：许可即止、按新柜位重算，原入柜与称重记录留档。</div>
      <label>新柜位<input id="f_cab" list="cabList" value="${esc(b.cabinet)}" required></label>
      <div class="dlg-actions"><button id="f_ok">确认移柜</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.moveCabinet(b.bookingId, $('#f_cab').value);
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
    };
  }

  function dlgResched(b) {
    openDialog(`
      <h3>改时段 · ${esc(b.workLabel)}</h3>
      <div class="meta">时段履历变更：已入柜者许可即止、按新时段重算；未入柜者仅更新预占。</div>
      <div class="grid2"><label>开始<input id="f_st" type="datetime-local" value="${toLocalInput(b.start)}"></label>
      <label>结束<input id="f_en" type="datetime-local" value="${toLocalInput(b.end)}"></label></div>
      <div class="dlg-actions"><button id="f_ok">确认改时</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.rescheduleBooking(b.bookingId, parseLocal($('#f_st').value), parseLocal($('#f_en').value));
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
    };
  }

  function dlgEditWork(w) {
    openDialog(`
      <h3>变更作品档案 · ${esc(w.theme)}</h3>
      <div class="meta">胎体或纹样变更：在柜许可即止，按新值重算，旧条目留档。</div>
      <div class="grid2"><label>胎体材质<input id="f_base" value="${esc(w.base)}"></label>
      <label>纹样主题<input id="f_theme" value="${esc(w.theme)}"></label></div>
      <div class="grid2"><label>线条粗细<select id="f_line">
        ${['细线', '中线', '粗线', '混合线'].map((l) => `<option ${w.line === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label><label>备注<input id="f_note" value="${esc(w.note)}"></label></div>
      <div class="dlg-actions"><button id="f_ok">保存变更</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.amendWork(w.workId, {
        base: $('#f_base').value, theme: $('#f_theme').value, line: $('#f_line').value, note: $('#f_note').value
      });
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
      if (r.permitsReset) alert('胎体/纹样已变更：相关在柜许可即止并按新值重算，旧条目已留档。');
    };
  }

  function dlgRegister() {
    openDialog(`
      <h3>新增作品</h3>
      <div class="grid2"><label>胎体材质<input id="f_base" required placeholder="脱胎漆器"></label>
      <label>纹样主题<input id="f_theme" required placeholder="缠枝莲"></label></div>
      <div class="grid2"><label>线条粗细<select id="f_line"><option>细线</option><option>中线</option><option>粗线</option><option>混合线</option></select></label>
      <label>备注<input id="f_note"></label></div>
      <div class="dlg-actions"><button id="f_ok">建档</button><button class="secondary" data-action="closeDlg">取消</button></div>`);
    $('#f_ok').onclick = () => {
      const r = store.commands.registerWork({ base: $('#f_base').value, theme: $('#f_theme').value, line: $('#f_line').value, note: $('#f_note').value });
      if (!r.ok) return alert(r.errors.join('；'));
      closeDialog(); render();
    };
  }

  function findBooking(id) { return snapshot.bookings.find((b) => b.bookingId === id); }
  function findWork(id) { return snapshot.works.find((w) => w.workId === id); }

  // ---------- 事件绑定 ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    const b = id ? findBooking(id) : null;
    const w = id ? findWork(id) : null;
    switch (action) {
      case 'tab': activeTab = el.dataset.tab; render(); break;
      case 'addWork': dlgRegister(); break;
      case 'addRow': addRow(); break;
      case 'delRow': if ($$('#orderRows .orow').length > 1) el.closest('.orow').remove(); break;
      case 'submitOrder': submitOrder(); break;
      case 'checkin': b && dlgCheckin(b); break;
      case 'initial': b && dlgInitial(b); break;
      case 'recheck': b && dlgRecheck(b); break;
      case 'gold': b && dlgGold(b); break;
      case 'move': b && dlgMove(b); break;
      case 'resched': b && dlgResched(b); break;
      case 'cancel':
        if (b && confirm(`注销 ${b.workLabel} 在柜位 ${b.cabinet} 的绑定？`)) { store.commands.cancelBooking(id); render(); }
        break;
      case 'editWork': w && dlgEditWork(w); break;
      case 'filterWork': workFilter = workFilter === id ? '' : id; render(); break;
      case 'closeDlg': closeDialog(); break;
      case 'saveSettings': {
        const r = store.commands.saveSettings({
          tempMin: $('#setTempMin').value, tempMax: $('#setTempMax').value,
          humMin: $('#setHumMin').value, humMax: $('#setHumMax').value
        });
        alert(r.ok ? '判定参数已更新，全部条目按新值重算。' : r.errors.join('；'));
        render();
        break;
      }
      case 'reload': {
        const r = store.reload();
        $('#reloadResult').innerHTML = r.same
          ? `<div class="banner ok">✓ 从存档重算完成：列表、待办、计数与重载前一致（事件 ${r.after.eventCount} 条，绑定 ${r.after.bookingCount} 件，待办 ${r.after.todoCount} 项）。</div>`
          : `<div class="banner no">✗ 重算结果与内存不一致，请导出存档核查。</div>`;
        render();
        break;
      }
      case 'exportData': {
        const blob = new Blob([store.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'lacquer-thread-ledger.json';
        a.click();
        URL.revokeObjectURL(a.href);
        break;
      }
      case 'resetData':
        if (confirm('清空并重载为示例数据？当前事件日志将被覆盖，建议先导出。')) {
          store.commands.resetAll();
          token = crypto.randomUUID();
          render();
        }
        break;
    }
  });

  $('#importFile').addEventListener('change', (e) => {    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = JSON.parse(reader.result);
      const r = store.commands.importAll(data);
      if (!r.ok) return alert(r.errors.join('；'));
      token = crypto.randomUUID();
      render();
      alert('存档已导入并重算。');
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#textFilter').addEventListener('input', (e) => { textFilter = e.target.value; renderLedger(); });
  $('#statusFilter').addEventListener('change', (e) => { statusFilter = e.target.value; renderLedger(); });
  $('#clearFilter').addEventListener('click', () => {
    workFilter = ''; textFilter = ''; $('#textFilter').value = ''; $('#statusFilter').value = '';
    render();
  });

  // 初始化：判定参数表单、筛选器、两行投递单
  $('#orderForm').addEventListener('submit', (e) => e.preventDefault());
  const s = store.project().settings;
  $('#setTempMin').value = s.tempMin; $('#setTempMax').value = s.tempMax;
  $('#setHumMin').value = s.humMin; $('#setHumMax').value = s.humMax;
  $('#statusFilter').innerHTML = `<option value="">全部状态</option>` +
    GROUP_ORDER.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#orderRows').innerHTML = orderRow() + orderRow();

  render();
})();
