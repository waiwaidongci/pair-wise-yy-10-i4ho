/* Node 端到端冒烟：判定块 + 存档块（页面规则同源）。node /workspace/tmp/test.js */
const Rules = require('/workspace/app/rules.js');

const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
global.crypto = { randomUUID: () => 'u' + Math.random().toString(36).slice(2, 10) };

const { createStore } = require('/workspace/app/store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const H = Rules.HOUR;
const T0 = Date.parse('2026-09-20T08:00:00');

console.log('1) 作品沿用/建档');
const store = createStore();
let snap = store.project(T0);
check('首次启动种子作品 3 件', snap.works.length === 3, snap.works.length);
const w1 = snap.works[0].workId, w2 = snap.works[1].workId, w3 = snap.works[2].workId;

console.log('2) 绑柜单：重叠冲突整单退回，不留残单');
const tok1 = 'token-1';
let r = store.commands.submitOrder(tok1, [
  { workId: w1, cabinet: 'A1', start: T0, end: T0 + 48 * H },
  { workId: w2, cabinet: 'A1', start: T0 + 24 * H, end: T0 + 72 * H } // 同柜重叠
]);
check('整单退回', !r.ok && r.receipt.conflicts.length >= 1, r);
check('退回不产生绑定', store.project(T0).bookings.length === 0);

console.log('3) 重复投递读回原单');
let r2 = store.commands.submitOrder(tok1, [
  { workId: w1, cabinet: 'A1', start: T0, end: T0 + 48 * H }
]);
check('重复 token 读回原退单', r2.duplicate === true && r2.ok === false && r2.receipt.conflicts.length >= 1);
check('仍无绑定', store.project(T0).bookings.length === 0);
const eventsAfterDup = store.project(T0).events.length;
store.commands.submitOrder(tok1, [{ workId: w1, cabinet: 'A1', start: T0, end: T0 + 48 * H }]);
check('重复投递不追加事件', store.project(T0).events.length === eventsAfterDup);

console.log('4) 正常收单 + 区间相接不算重叠 + 作品重叠也拦截');
const b1 = store.commands.submitOrder('t-ok1', [{ workId: w1, cabinet: 'A1', start: T0, end: T0 + 48 * H }]);
check('收单', b1.ok === true);
const booking1 = b1.receipt.items[0].bookingId;
// 首尾相接（end == start）应允许
const adjacent = store.commands.submitOrder('t-ok2', [{ workId: w3, cabinet: 'A1', start: T0 + 48 * H, end: T0 + 72 * H }]);
check('首尾相接允许', adjacent.ok === true, adjacent.receipt && adjacent.receipt.conflicts);
// 同作品时段重叠（即使不同柜）整单退
const workBusy = store.commands.submitOrder('t-bad1', [{ workId: w1, cabinet: 'B2', start: T0 + 1 * H, end: T0 + 2 * H }]);
check('同作品重叠整单退', !workBusy.ok && workBusy.receipt.conflicts.some(c => c.includes('作品')));
// 单内两条冲突也整单退、不留残单
const intra = store.commands.submitOrder('t-bad2', [
  { workId: w2, cabinet: 'C1', start: T0, end: T0 + 10 * H },
  { workId: w2, cabinet: 'C1', start: T0 + 5 * H, end: T0 + 12 * H }
]);
check('单内冲突整单退', !intra.ok);
check('残单数为 0（仅两条有效绑定）', store.project(T0).bookings.length === 2);

console.log('5) 入柜：缺初重/越界只列待复检');
let ci = store.commands.checkIn(booking1, { weight: null, temp: 30, humidity: 80, by: '甲', at: T0 });
check('入柜成功（缺初重+越界也登记）', ci.ok === true, ci);
snap = store.project(T0);
let b = snap.bookings.find(x => x.bookingId === booking1);
check('状态为待复检', b.state === 'recheck', b.state);
check('待办含待复检', snap.todos.some(t => t.kind === 'recheck' && t.bookingId === booking1));
check('异常含缺初重与温湿度越界', b.entryIssues.some(i => i.includes('缺初重')) && b.entryIssues.some(i => i.includes('温度')) && b.entryIssues.some(i => i.includes('湿度')));
// 合规复检也不能上金粉（缺初重）
let rc = store.commands.recheck(booking1, { weight: 100, temp: 22, humidity: 60, by: '乙', at: T0 + 25 * H });
check('缺初重时复检被拒（先补初重）', !rc.ok, rc);
let sup = store.commands.supplyInitial(booking1, 100, '甲', T0 + 2 * H);
check('补初重成功', sup.ok === true, sup);
snap = store.project(T0 + 3 * H);
b = snap.bookings.find(x => x.bookingId === booking1);
check('补初重后仍待复检（入柜温湿度越界未消解）', b.state === 'recheck');

console.log('6) 复检换人 + 廿四小时 + 同档 → 金粉，否则续干');
// 重新入柜一笔干净的：用 w2 新柜位（w2 尚无绑定）
const order2 = store.commands.submitOrder('t-g1', [{ workId: w2, cabinet: 'D1', start: T0, end: T0 + 240 * H }]);
check('w2 收单', order2.ok, order2.receipt && order2.receipt.conflicts);
const booking2 = order2.receipt.items[0].bookingId;
store.commands.checkIn(booking2, { weight: 100, temp: 22, humidity: 60, by: '甲', at: T0 });
// 同人次日复检 → 不合规，续干
store.commands.recheck(booking2, { weight: 99.9, temp: 22, humidity: 60, by: '甲', at: T0 + 25 * H });
snap = store.project(T0 + 26 * H);
b = snap.bookings.find(x => x.bookingId === booking2);
check('未换人→不合规、续干', b.state === 'drying' && b.chain.marks[0].compliant === false, b.chain);
// 换人但未满 24h
store.commands.recheck(booking2, { weight: 99.8, temp: 22, humidity: 60, by: '乙', at: T0 + 30 * H });
snap = store.project(T0 + 31 * H);
b = snap.bookings.find(x => x.bookingId === booking2);
check('未满廿四小时→不合规', b.state === 'drying' && b.chain.marks[1].compliant === false);
// 合规复检链：先由乙重称（上一条乙未满时），再丙、丁依次换人、各隔满廿四小时
store.commands.recheck(booking2, { weight: 99.7, temp: 22, humidity: 60, by: '乙', at: T0 + 60 * H }); // 相对上一条乙：不合规（同人）
store.commands.recheck(booking2, { weight: 99.5, temp: 22, humidity: 60, by: '丙', at: T0 + 90 * H }); // 对乙换人、满时，约0.20% 轻失
store.commands.recheck(booking2, { weight: 99.3, temp: 22, humidity: 60, by: '丁', at: T0 + 120 * H }); // 对丙换人、满时，约0.20% 轻失
snap = store.project(T0 + 121 * H);
b = snap.bookings.find(x => x.bookingId === booking2);
check('连续两次合规且同档→可上金粉', b.state === 'readyGold' && b.chain.canGold === true, b.chain.why);
check('待办含上金粉', snap.todos.some(t => t.kind === 'gold'));
// 不同档 → 续干（另建档作品，避免与 w3 已有预占冲突）
const w4 = store.commands.registerWork({ base: '脱胎瓶', theme: '牡丹', line: '细线', note: '' }).workId;
const order3 = store.commands.submitOrder('t-g2', [{ workId: w4, cabinet: 'D2', start: T0, end: T0 + 240 * H }]);
const booking3 = order3.receipt.items[0].bookingId;
store.commands.checkIn(booking3, { weight: 100, temp: 22, humidity: 60, by: '甲', at: T0 });
store.commands.recheck(booking3, { weight: 99.7, temp: 22, humidity: 60, by: '乙', at: T0 + 25 * H }); // 0.3% 轻失
store.commands.recheck(booking3, { weight: 99.0, temp: 22, humidity: 60, by: '丙', at: T0 + 50 * H }); // ~0.7% 中失
snap = store.project(T0 + 51 * H);
b = snap.bookings.find(x => x.bookingId === booking3);
check('不同档→续干且理由含档名', b.state === 'drying' && b.chain.why.some(w => w.includes('不同档')), b.chain.why);
// 上金粉命令
const gold = store.commands.applyGold(booking2, '戊', T0 + 122 * H);
check('上金粉成功', gold.ok, gold);
check('未通过判定不可上金粉', !store.commands.applyGold(booking3, '丁').ok);

console.log('7) 胎体/纹样变更：许可即止、重算、旧条目留档');
const archivesBefore = store.project().archives.length;
// 在柜作品 w4（booking3）变更胎体
const amend = store.commands.amendWork(w4, { base: '木胎瓶', theme: '牡丹' });
check('变更成功', amend.ok && amend.permitsReset === true, amend);
snap = store.project(T0 + 123 * H);
b = snap.bookings.find(x => x.bookingId === booking2);
check('已上金粉闭环不受变更影响', b.status === 'gilded');
b = snap.bookings.find(x => x.bookingId === booking3);
check('在柜许可版本 +1、称重清空', b.permitVersion === 2 && b.measurements.length === 0, b.permitVersion);
check('旧条目留档', snap.archives.length === archivesBefore + 1, snap.archives.length);
check('留档保存旧称重', snap.archives[0].measurements.length >= 3);
check('留档保存旧胎体', snap.archives.some(a => a.base === '脱胎瓶'));
// 版本失配事件不影响新链：旧时间点的复检事件 version=1 被忽略
snap = store.project(T0 + 124 * H);
b = snap.bookings.find(x => x.bookingId === booking3);
check('状态要求重新登记', b.state === 'reentry', b.state);

console.log('8) 移柜/改时：柜位履历变更许可即止，冲突仍整单拒绝');
const w5 = store.commands.registerWork({ base: '木胎匣', theme: '卷草纹', line: '中线', note: '' }).workId;
const order4 = store.commands.submitOrder('t-m1', [{ workId: w5, cabinet: 'E1', start: T0 + 100 * H, end: T0 + 300 * H }]);
const booking4 = order4.receipt.items[0].bookingId;
store.commands.checkIn(booking4, { weight: 100, temp: 22, humidity: 60, by: '甲', at: T0 + 100 * H });
const move = store.commands.moveCabinet(booking4, 'E2');
check('移柜成功', move.ok, move);
snap = store.project(T0 + 101 * H);
b = snap.bookings.find(x => x.bookingId === booking4);
check('移柜后许可版本 +1', b.permitVersion === 2 && b.cabinet === 'E2');
check('移柜留档', snap.archives.some(a => a.bookingId === booking4 && a.reason.includes('柜位')));
// 改时撞车：先在 E2 占一段，再把 booking4 改进重叠时段
const w6 = store.commands.registerWork({ base: '陶胎盏', theme: '莲瓣', line: '细线', note: '' }).workId;
const blocker = store.commands.submitOrder('t-m2', [{ workId: w6, cabinet: 'E2', start: T0, end: T0 + 10 * H }]);
check('挡单建立', blocker.ok, blocker.receipt && blocker.receipt.conflicts);
const clash = store.commands.rescheduleBooking(booking4, T0 + 1 * H, T0 + 2 * H);
check('改时冲突被拒', !clash.ok, clash);

console.log('9) 判定参数变更按新值重算');
const setr = store.commands.saveSettings({ tempMin: 20, tempMax: 24, humMin: 55, humMax: 65 });
check('参数保存', setr.ok, setr);
const badSet = store.commands.saveSettings({ tempMin: 30, tempMax: 20, humMin: 55, humMax: 65 });
check('非法参数拒绝', !badSet.ok);

console.log('10) 注销与重载一致性');
const cancel = store.commands.cancelBooking(booking4);
check('注销成功', cancel.ok);
check('已注销不可再注销', !store.commands.cancelBooking(booking4).ok);
const reload = store.reload();
check('从存档重算与内存一致', reload.same === true, reload);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
