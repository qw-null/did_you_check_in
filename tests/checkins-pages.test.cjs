const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadService(callCatalog, storage = new Map(), overrides = {}) {
  const module = { exports: {} };
  let sequence = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/checkins.js'), 'utf8'), {
    module, require: () => ({ callCatalog, requestId: () => `request_${++sequence}` }),
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
      removeStorageSync: (key) => storage.delete(key), ...overrides,
    },
  });
  return module.exports;
}

function loadPage(file, { read = async () => ({}), write = async () => ({}), confirm = async () => true, wx = {} } = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages', file, 'index.js'), 'utf8'), {
    Page: (page) => { definition = page; }, wx,
    require: (name) => name.endsWith('login-page') ? { createLoginPage: (page) => page }
      : name.endsWith('checkins') ? { writePersonal: write, confirmCompletion: confirm, displayTime: (value) => value }
        : { callCatalog: read, displayDate: (value) => value },
  });
  const page = { ...definition, data: structuredClone(definition.data), _visible: true, _loginVersion: 1,
    setData(update) { Object.assign(this.data, update); } };
  Object.assign(page.data, { authenticated: true, user: { id: 'u_test' }, businessDate: '2026-10-29' });
  return page;
}
const event = (dataset) => ({ currentTarget: { dataset } });
const task = (id, extra = {}) => ({ id, can_complete: true, joined: true, ...extra });
const list = (items, extra = {}) => ({ items, cursor: '', businessDate: '2026-10-29', progress: { pending: items.length, completed: 0, total: items.length }, ...extra });

test('响应丢失后重载服务跨日重试沿用原请求和日期；成功后下次使用新日期', async () => {
  const storage = new Map();
  let first;
  const initial = loadService(async (_, payload) => {
    first = structuredClone(payload);
    throw Object.assign(new Error('连接中断'), { code: 'CLOUD_CALL_FAILED' });
  }, storage);
  await assert.rejects(initial.writePersonal('u_test', 'completeCheckin', 'a_daily', '2026-10-29'));
  assert.equal(storage.size, 1);
  const calls = [];
  const restarted = loadService(async (_, payload) => { calls.push(structuredClone(payload)); return { record: {} }; }, storage);
  await restarted.writePersonal('u_test', 'completeCheckin', 'a_daily', '2026-10-30');
  assert.deepEqual(calls[0], first);
  assert.equal(storage.size, 0);
  await restarted.writePersonal('u_test', 'completeCheckin', 'a_daily', '2026-10-30');
  assert.equal(calls[1].expectedDate, '2026-10-30');
});

test('待确认请求按用户隔离；明确日期拒绝清除原请求，未知失败继续保留', async () => {
  const storage = new Map();
  const calls = [];
  let code;
  const service = loadService(async (_, payload) => {
    calls.push(structuredClone(payload));
    throw Object.assign(new Error('failed'), code ? { code } : {});
  }, storage);
  await assert.rejects(service.writePersonal('u_first', 'completeCheckin', 'a_daily', '2026-10-29'));
  await assert.rejects(service.writePersonal('u_second', 'completeCheckin', 'a_daily', '2026-10-30'));
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.equal(storage.size, 2);
  code = 'DATE_CHANGED';
  await assert.rejects(service.writePersonal('u_first', 'completeCheckin', 'a_daily', '2026-10-30'));
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(storage.size, 1);
  await assert.rejects(service.writePersonal('u_first', 'completeCheckin', 'a_daily', '2026-10-30'));
  assert.equal(calls[3].expectedDate, '2026-10-30');
  assert.notEqual(calls[3].requestId, calls[0].requestId);
});

test('请求无法持久化时不发送；确认弹窗取消或失败均不确认，时间按上海展示', async () => {
  let sent = 0;
  let modal;
  const service = loadService(async () => { sent++; }, new Map(), {
    setStorageSync() { throw new Error('storage full'); }, showModal(options) { modal = options; },
  });
  await assert.rejects(service.writePersonal('u_test', 'joinActivity', 'a_daily'), /storage full/);
  assert.equal(sent, 0);
  const confirmation = service.confirmCompletion('2026-10-29');
  assert.match(modal.title, /2026-10-29/);
  assert.match(modal.content, /不能撤销/);
  modal.success({ confirm: false });
  assert.equal(await confirmation, false);
  const failed = service.confirmCompletion('2026-10-29');
  modal.fail();
  assert.equal(await failed, false);
  assert.equal(service.displayTime('2026-10-29T16:00:00Z'), '2026-10-30 00:00:00');
});

test('我的打卡分页去重，切换全部与筛选使用正确参数，零任务不伪造进度', async () => {
  const calls = [];
  const responses = [list([task('a_1')], { cursor: 'next' }), list([task('a_1'), task('a_2')]), list([]), list([])];
  const page = loadPage('checkins', { read: async (action, input) => { calls.push({ action, ...input }); return responses.shift(); } });
  await page.onAuthenticated();
  await page.onLoadMore();
  assert.equal(page.data.items.map((item) => item.id).join(','), 'a_1,a_2');
  assert.equal(calls[1].cursor, 'next');
  await page.onViewChange(event({ view: 'all' }));
  assert.equal(calls[2].view, 'all');
  assert.equal(calls[2].filter, 'all');
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.progress.total, 0);
  await page.onFilterChange(event({ filter: 'removed' }));
  assert.equal(calls[3].filter, 'removed');
});

test('取消完成不写入，待服务端成功后才刷新进度且拦截重复点击', async () => {
  let finish;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  let confirms = false;
  let writes = 0;
  const page = loadPage('checkins', {
    confirm: async () => confirms,
    write: (_, action, id, date) => {
      assert.equal(action, 'completeCheckin'); assert.equal(id, 'a_daily'); assert.equal(date, '2026-10-29');
      writes++; started(); return new Promise((resolve) => { finish = resolve; });
    },
    read: async () => list([], { progress: { pending: 0, completed: 1, total: 1 } }),
  });
  page.data.items = [task('a_daily')];
  await page.onComplete(event({ id: 'a_daily' }));
  assert.equal(writes, 0); assert.equal(page.data.working, false);
  confirms = true;
  const pending = page.onComplete(event({ id: 'a_daily' }));
  await didStart;
  await page.onComplete(event({ id: 'a_daily' }));
  assert.equal(writes, 1); assert.equal(page.data.items[0].can_complete, true);
  finish({ record: { checkin_date: '2026-10-29' } });
  await pending;
  assert.equal(page.data.progress.completed, 1); assert.equal(page.data.working, false);
});

test('跨日被拒绝后仅刷新日期并提示，必须由用户再次确认才提交', async () => {
  let writes = 0;
  const dates = [];
  const page = loadPage('checkins', {
    confirm: async (date) => { dates.push(date); return true; },
    write: async (_, action, id, date) => {
      if (++writes === 1) throw Object.assign(new Error('日期已变化，请重新确认'), { code: 'DATE_CHANGED' });
      return { record: { checkin_date: date } };
    },
    read: async () => list([task('a_daily')], { businessDate: '2026-10-30' }),
  });
  page.data.items = [task('a_daily')];
  await page.onComplete(event({ id: 'a_daily' }));
  assert.equal(writes, 1); assert.equal(page.data.businessDate, '2026-10-30');
  assert.match(page.data.error, /日期已变化/);
  await page.onComplete(event({ id: 'a_daily' }));
  assert.equal(writes, 2); assert.deepEqual(dates, ['2026-10-29', '2026-10-30']);
});

test('清单读取或完成失败保留真实状态，不伪造完成数，隐藏页忽略延迟结果', async () => {
  let finish;
  const page = loadPage('checkins', {
    read: () => new Promise((resolve) => { finish = resolve; }),
    write: async () => { throw Object.assign(new Error('网络异常'), { code: 'CLOUD_CALL_FAILED' }); },
  });
  page.data.items = [task('a_daily')];
  await page.onComplete(event({ id: 'a_daily' }));
  assert.equal(page.data.items[0].can_complete, true); assert.equal(page.data.progress, null);
  assert.equal(page.data.error, '网络异常');
  const request = page.loadList(true);
  page._visible = false; page._loginVersion++; page.onHide();
  finish(list([task('private')]));
  await request;
  assert.equal(page.data.items.length, 0); assert.equal(page.data.progress, null);
});

test('移除需确认并说明保留历史；成功重新读取，不在本地删除完成记录', async () => {
  let modal;
  let writes = 0;
  const page = loadPage('checkins', {
    wx: { showModal(options) { modal = options; } },
    write: async (_, action) => { assert.equal(action, 'removeActivity'); writes++; }, read: async () => list([]),
  });
  let pending = page.onRemove(event({ id: 'a_daily' }));
  assert.match(modal.content, /已完成记录会保留/);
  modal.success({ confirm: false }); await pending; assert.equal(writes, 0);
  pending = page.onRemove(event({ id: 'a_daily' }));
  modal.success({ confirm: true }); await pending;
  assert.equal(writes, 1); assert.match(page.data.notice, /历史记录已保留/);
});

test('历史分页保留快照及顺序，账号切换后不显示先前账号的迟到响应', async () => {
  let count = 0;
  let finish;
  const page = loadPage('checkin-history', { read: async () => {
    if (++count === 1) return { items: [{ id: 'c_2', title: '完成时快照' }], cursor: 'next' };
    if (count === 2) return { items: [{ id: 'c_2' }, { id: 'c_1' }], cursor: '' };
    return new Promise((resolve) => { finish = resolve; });
  } });
  await page.onAuthenticated(); await page.onLoadMore();
  assert.equal(page.data.items.map((item) => item.id).join(','), 'c_2,c_1');
  assert.equal(page.data.items[0].title, '完成时快照');
  const pending = page.loadHistory(true);
  page._loginVersion++; page.onHide();
  finish({ items: [{ id: 'private' }], cursor: '' }); await pending;
  assert.equal(page.data.items.length, 0);
});

test('详情加入与完成分别调用写操作，打开入口不会自动完成', async () => {
  const writes = [];
  const reads = [];
  const page = loadPage('activity-detail', {
    wx: { navigateToMiniProgram(options) { options.success(); }, canIUse: () => true },
    write: async (...args) => { writes.push(args); return { record: { checkin_date: '2026-10-29' } }; },
    read: async (action) => { reads.push(action); return { item: { executable: true, entry_type: 'mini_program', direct_open_enabled: true, target_address: '#小程序://测试/token', participation_steps: [], personal: { can_complete: true } }, businessDate: '2026-10-29' }; },
  });
  page.onLoad({ id: 'a_daily' });
  await page.onAuthenticated();
  await page.onOpenEntry();
  assert.equal(writes.length, 0);
  await page.onJoinActivity();
  assert.equal(writes.length, 1); assert.equal(writes[0][1], 'joinActivity');
  await page.onComplete();
  assert.equal(writes.length, 2); assert.equal(writes[1][1], 'completeCheckin');
  assert.equal(writes[1][3], '2026-10-29');
  assert.match(page.data.personalMessage, /已记录/); assert(reads.includes('recordView'));
});
