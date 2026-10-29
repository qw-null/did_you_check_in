const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogHandler } = require('../cloudfunctions/catalog/handler');
const { userIdFor } = require('../cloudfunctions/catalog/rules');
const { businessDate, relationId } = require('../cloudfunctions/catalog/personal');

const APPID = 'wxb7e6889ef5fe7e88';
const uid = userIdFor(APPID, 'isolated-test-user');
const day = '2026-10-29';
function activity(id = 'a_daily', frequency = 'daily') {
  return { _id: id, platform_id: 'p_test', title: `隔离测试活动 ${id}`, frequency, publication_status: 'published',
    first_published_at: new Date('2026-10-01'), verification_status: 'verified', next_verify_at: new Date('2026-12-01'),
    content_restricted: false, validity_type: 'ongoing', participation_steps: [], category: 'points', revision: 1 };
}

function fixture() {
  const names = ['users', 'admin_bindings', 'activities', 'platforms', 'user_activities', 'checkins', 'catalog_requests', 'catalog_snapshots'];
  let tables = Object.fromEntries(names.map((name) => [name, new Map()]));
  tables.users.set(uid, { _id: uid, status: 'active' });
  tables.platforms.set('p_test', { _id: 'p_test', name: '隔离测试平台', status: 'enabled' });
  tables.activities.set('a_daily', activity());
  tables.activities.set('a_once', activity('a_once', 'once'));
  let time = new Date('2026-10-29T04:00:00Z');
  let openId = 'isolated-test-user';
  let queue = Promise.resolve();
  let failure = '';
  let intervention;
  const store = {
    async get(collection, key) { return structuredClone(tables[collection].get(key) || null); },
    async scan(collection, where, after = '', limit = 100) {
      return structuredClone([...tables[collection].values()].filter((row) => row._id > after
        && Object.entries(where).every(([key, value]) => row[key] === value)).sort((a, b) => a._id < b._id ? -1 : 1).slice(0, limit));
    },
    async count(collection, where) { return (await store.scan(collection, where, '', 5000)).length; },
    async create(collection, item) { tables[collection].set(item._id, structuredClone(item)); },
    async history(userId, cursor, size) {
      return structuredClone([...tables.checkins.values()].filter((row) => row.user_id === userId
        && (!cursor || new Date(row.completed_at) < new Date(cursor.time)
          || (new Date(row.completed_at).getTime() === new Date(cursor.time).getTime() && row._id < cursor.id)))
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at) || (a._id > b._id ? -1 : 1)).slice(0, size));
    },
    async transact(work) {
      const result = queue.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const original = structuredClone(tables);
          const candidate = structuredClone(tables);
          const writes = new Map();
          const output = await work({
            async get(collection, key) { return structuredClone(candidate[collection].get(key) || null); },
            async put(collection, key, value) {
              if (collection === failure) throw new Error('isolated transaction failure');
              candidate[collection].set(key, structuredClone({ ...value, _id: key }));
              writes.set(`${collection}:${key}`, [collection, key]);
            },
          });
          if (intervention) { const change = intervention; intervention = null; change(tables); }
          // 模拟快照隔离：只检查写集合冲突，不把普通读取误当作串行锁。
          const changed = [...writes.values()].some(([collection, key]) =>
            JSON.stringify(original[collection].get(key)) !== JSON.stringify(tables[collection].get(key)));
          if (changed) continue;
          for (const [collection, key] of writes.values()) tables[collection].set(key, candidate[collection].get(key));
          return output;
        }
        throw new Error('isolated transaction conflict');
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  const handler = createCatalogHandler({ store, now: () => time,
    getWXContext: () => ({ APPID, OPENID: openId }), logger: { error() {} } });
  let sequence = 0;
  async function call(action, data = {}) {
    return handler({ action, requestId: `test_${++sequence}`, ...data });
  }
  async function ok(action, data = {}) {
    const result = await call(action, data);
    assert.equal(result.ok, true, result.error && `${result.error.code}: ${result.error.message}`);
    return result.data;
  }
  return { call, ok, handler, get tables() { return tables; },
    date(value) { time = new Date(value); }, user(value) { openId = value; }, fail(collection) { failure = collection; },
    beforeCommit(change) { intervention = change; },
    join(id = 'a_daily') { return ok('joinActivity', { id }); },
    complete(id = 'a_daily', extra = {}) { return ok('completeCheckin', { id, expectedDate: businessDate(time), ...extra }); },
    list(view = 'today', filter = 'pending', cursor = '') { return ok('myCheckins', { view, filter, cursor }); },
  };
}

test('加入去重、每日完成与移除重加沿用关系和完成记录', async () => {
  const f = fixture();
  await Promise.all([f.join(), f.join()]);
  assert.equal(f.tables.user_activities.size, 1);
  const first = f.tables.user_activities.get(relationId(uid, 'a_daily')).first_joined_at;
  assert.deepEqual((await f.list()).progress, { pending: 1, completed: 0, total: 1 });
  const results = await Promise.all([f.complete(), f.complete()]);
  assert.equal(results[0].record.id, results[1].record.id);
  assert.equal(f.tables.checkins.size, 1);
  await f.ok('removeActivity', { id: 'a_daily' });
  assert.deepEqual((await f.list()).progress, { pending: 0, completed: 1, total: 1 });
  assert.equal((await f.list('all', 'removed')).items.length, 1);
  await f.join();
  assert.equal(f.tables.user_activities.size, 1);
  assert.equal(f.tables.checkins.size, 1);
  assert.equal(f.tables.user_activities.get(relationId(uid, 'a_daily')).first_joined_at.getTime(), first.getTime());
  const all = await f.list('all', 'ongoing');
  assert.equal(all.items[0].status_label, '今日已完成');
  assert.equal(all.items[0].can_complete, false);
});

test('上海日期日切、旧日期拒绝、跨日成功请求重放不误增新记录', async () => {
  const f = fixture();
  f.date('2026-10-29T15:59:59Z');
  await f.join();
  const original = await f.complete('a_daily', { requestId: 'lost_response' });
  f.date('2026-10-29T16:00:01Z');
  const stale = await f.call('completeCheckin', { id: 'a_daily', expectedDate: day, requestId: 'stale_screen' });
  assert.equal(stale.error.code, 'DATE_CHANGED');
  assert.equal(f.tables.checkins.size, 1);
  const replay = await f.ok('completeCheckin', { id: 'a_daily', expectedDate: day, requestId: 'lost_response' });
  assert.equal(replay.record.id, original.record.id);
  assert.equal(replay.record.checkin_date, day);
  assert.equal((await f.list()).businessDate, '2026-10-30');
  assert.deepEqual((await f.list()).progress, { pending: 1, completed: 0, total: 1 });
  await f.complete();
  assert.equal(f.tables.checkins.size, 2);
});

test('一次性跨日、重新登录和重新加入均不重置完成周期', async () => {
  const f = fixture();
  await f.join('a_once');
  const first = await f.complete('a_once');
  f.date('2026-10-30T05:00:00Z');
  assert.deepEqual((await f.list()).progress, { pending: 0, completed: 0, total: 0 });
  await f.ok('removeActivity', { id: 'a_once' });
  await f.join('a_once');
  const twice = await f.complete('a_once');
  assert.equal(twice.record.id, first.record.id);
  assert.equal(twice.record.period_key, 'once');
  assert.equal(f.tables.checkins.size, 1);
  assert.equal((await f.list('all', 'once_completed')).items.length, 1);
  assert.equal((await f.list('all', 'ongoing')).items.length, 0);
});

test('暂停、核验到期、尚未开始、平台停用、结束时均阻止新加入及新确认', async () => {
  const changes = [
    (f) => { f.tables.activities.get('a_daily').publication_status = 'paused'; },
    (f) => { f.tables.activities.get('a_daily').next_verify_at = new Date('2026-10-29T04:00:00Z'); },
    (f) => { f.tables.activities.get('a_daily').start_at = new Date('2026-10-30'); },
    (f) => { f.tables.platforms.get('p_test').status = 'disabled'; },
    (f) => { f.tables.activities.get('a_daily').publication_status = 'ended'; },
    (f) => { f.tables.activities.get('a_daily').end_at = new Date('2026-10-29T04:00:00Z'); },
  ];
  for (const change of changes) {
    const f = fixture();
    await f.join(); change(f);
    assert.equal((await f.call('completeCheckin', { id: 'a_daily', expectedDate: day })).error.code, 'NOT_EXECUTABLE');
    assert.equal((await f.call('joinActivity', { id: 'a_daily' })).error.code, 'NOT_EXECUTABLE');
    assert.equal((await f.list()).progress.total, 0);
    assert.equal((await f.list('all', 'blocked')).items.length, 1);
    assert.equal(f.tables.checkins.size, 0);
  }
});

test('已完成后暂停或移除不丢失当天进度，重放成功记录仍有效', async () => {
  const f = fixture();
  await f.join();
  const first = await f.complete('a_daily', { requestId: 'original' });
  f.tables.activities.get('a_daily').publication_status = 'paused';
  await f.ok('removeActivity', { id: 'a_daily' });
  const replay = await f.complete('a_daily', { requestId: 'original' });
  assert.equal(replay.record.id, first.record.id);
  const list = await f.list('today', 'completed');
  assert.deepEqual(list.progress, { pending: 0, completed: 1, total: 1 });
  assert.equal(list.items[0].executable, false);
  assert.equal(list.items[0].joined, false);
});

test('内容受限后清单、历史、详情与成功请求重放均屏蔽不安全快照', async () => {
  const f = fixture();
  await f.join();
  await f.complete('a_daily', { requestId: 'original' });
  f.tables.activities.get('a_daily').content_restricted = true;
  const results = [await f.list('today', 'completed'), await f.ok('checkinHistory'),
    await f.complete('a_daily', { requestId: 'original' }), await f.ok('detail', { id: 'a_daily' })];
  for (const result of results) {
    assert(!JSON.stringify(result).includes('隔离测试活动'));
    assert(JSON.stringify(result).includes('活动信息已限制展示'));
  }
});

test('完成历史保留完成时标题和平台快照，20 条稳定分页且隔离账号', async () => {
  const f = fixture();
  await f.join();
  for (let index = 1; index <= 25; index++) {
    f.date(`2026-11-${String(index).padStart(2, '0')}T03:00:00Z`);
    await f.complete();
  }
  f.tables.activities.get('a_daily').title = '更名后标题';
  const first = await f.ok('checkinHistory');
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].checkin_date, '2026-11-25');
  assert.equal(first.items[0].title, '隔离测试活动 a_daily');
  const second = await f.ok('checkinHistory', { cursor: first.cursor });
  assert.equal(second.items.length, 5);
  assert.equal(second.items[4].checkin_date, '2026-11-01');
  assert.equal(new Set(first.items.concat(second.items).map((item) => item.id)).size, 25);
  f.user('other-isolated-user');
  f.tables.users.set(userIdFor(APPID, 'other-isolated-user'), { status: 'active' });
  assert.equal((await f.ok('checkinHistory', { cursor: first.cursor })).items.length, 0);
  assert.equal((await f.ok('myCheckins', { user_id: uid })).items.length, 0);
});

test('清单 20 条分页、日期切换使旧游标失效，变更后重算总数', async () => {
  const f = fixture();
  for (let index = 0; index < 23; index++) {
    const id = `a_task_${String(index).padStart(2, '0')}`;
    f.tables.activities.set(id, activity(id));
    await f.join(id);
  }
  const first = await f.list();
  const second = await f.list('today', 'pending', first.cursor);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 3);
  assert.equal(first.progress.total, 23);
  assert.equal(new Set(first.items.concat(second.items).map((item) => item.id)).size, 23);
  await f.ok('removeActivity', { id: first.items[0].id });
  assert.equal((await f.list()).progress.total, 22);
  f.date('2026-10-30T03:00:00Z');
  assert.equal((await f.call('myCheckins', { cursor: first.cursor })).error.code, 'CURSOR_EXPIRED');
});

test('事务失败不留下关系、完成记录或幂等成功，不能给其他账号写入', async () => {
  const f = fixture();
  const before = await f.call('completeCheckin', { id: 'a_daily', expectedDate: day });
  assert.equal(before.error.code, 'NOT_JOINED');
  f.fail('catalog_requests');
  assert.equal((await f.call('joinActivity', { id: 'a_daily' })).ok, false);
  assert.equal(f.tables.user_activities.size, 0);
  f.fail('');
  await f.join();
  f.fail('catalog_requests');
  assert.equal((await f.call('completeCheckin', { id: 'a_daily', expectedDate: day })).ok, false);
  assert.equal(f.tables.checkins.size, 0);
  f.fail('');
  f.tables.users.get(uid).status = 'disabled';
  assert.equal((await f.call('joinActivity', { id: 'a_once' })).error.code, 'ACCOUNT_RESTRICTED');
  f.user('unregistered-isolated-user');
  assert.equal((await f.call('myCheckins')).error.code, 'LOGIN_REQUIRED');
});

test('请求标识冲突拒绝改写目标或日期，不能伪造历史完成时间', async () => {
  const f = fixture();
  await f.join();
  await f.complete('a_daily', { requestId: 'stable', completed_at: '1990-01-01', user_id: 'other' });
  assert.equal([...f.tables.checkins.values()][0].completed_at.toISOString(), '2026-10-29T04:00:00.000Z');
  const changed = await f.call('completeCheckin', { id: 'a_daily', expectedDate: '2026-10-28', requestId: 'stable' });
  assert.equal(changed.error.code, 'REQUEST_CONFLICT');
  assert.equal((await f.call('joinActivity', { id: 'a_once', requestId: 'stable' })).error.code, 'REQUEST_CONFLICT');
});

test('快照读取后并发暂停、平台停用、移除或账号停用，写冲突重试后拒绝完成', async () => {
  const changes = [
    ['NOT_EXECUTABLE', (tables) => { tables.activities.get('a_daily').publication_status = 'paused'; }],
    ['NOT_EXECUTABLE', (tables) => { tables.platforms.get('p_test').status = 'disabled'; }],
    ['NOT_JOINED', (tables) => { tables.user_activities.get(relationId(uid, 'a_daily')).status = 'removed'; }],
    ['ACCOUNT_RESTRICTED', (tables) => { tables.users.get(uid).status = 'disabled'; }],
  ];
  for (const [code, change] of changes) {
    const f = fixture();
    await f.join();
    f.beforeCommit(change);
    const result = await f.call('completeCheckin', { id: 'a_daily', expectedDate: day });
    assert.equal(result.error && result.error.code, code);
    assert.equal(f.tables.checkins.size, 0);
    assert.equal(f.tables.activities.get('a_daily').revision, 1);
  }
});
