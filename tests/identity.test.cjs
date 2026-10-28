const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityHandler } = require('../cloudfunctions/identity/handler');

const APPID = 'wxb7e6889ef5fe7e88';

function setup(options = {}) {
  const tables = { users: new Map(), admin_bindings: new Map() };
  const db = {
    collection(name) {
      if (!tables[name]) throw new Error('collection unavailable');
      return {
        where(query) {
          return { limit: () => ({ get: async () => ({ data: [...tables[name].values()].filter((doc) => doc._id === query._id) }) }) };
        },
        async add({ data }) {
          if (tables[name].has(data._id)) {
            const error = new Error('duplicate');
            error.code = 'DUPLICATE';
            throw error;
          }
          tables[name].set(data._id, structuredClone(data));
          return { _id: data._id };
        },
      };
    },
  };
  const handler = createIdentityHandler({
    db,
    getWXContext: () => ({ OPENID: 'test-wechat-user', APPID, ...options.context }),
    now: () => new Date('2026-10-28T16:01:00.000Z'),
    logger: { error() {} },
  });
  return { handler, tables, db };
}

test('游客恢复身份不隐式创建账号', async () => {
  const { handler, tables } = setup();
  const response = await handler({ action: 'current' });
  assert.equal(response.ok, true);
  assert.equal(response.data.user, null);
  assert.equal(tables.users.size, 0);
  assert.equal(response.data.businessDate, '2026-10-29');
});

test('首次登录只返回内部用户资料，不返回微信标识或默认管理权限', async () => {
  const { handler, tables } = setup();
  const result = await handler({ action: 'login' });
  assert.equal(result.ok, true);
  assert.equal(tables.users.size, 1);
  assert.deepEqual(Object.keys(result.data.user).sort(), ['displayName', 'id']);
  assert.equal(result.data.admin, undefined);
  assert.equal(JSON.stringify(result).includes('test-wechat-user'), false);
});

test('并发首次登录保持同一账号，重复请求不增加记录', async () => {
  const { handler, tables } = setup();
  const responses = await Promise.all(Array.from({ length: 8 }, () => handler({ action: 'login' })));
  assert(responses.every((result) => result.ok));
  assert.equal(new Set(responses.map((result) => result.data.user.id)).size, 1);
  assert.equal(tables.users.size, 1);
});

test('缺少云端微信身份或 AppID 不匹配时不创建账号', async () => {
  for (const context of [{ OPENID: '' }, { APPID: 'another-app' }]) {
    const { handler, tables } = setup({ context });
    const response = await handler({ action: 'login' });
    assert.equal(response.error.code, 'IDENTITY_UNAVAILABLE');
    assert.equal(tables.users.size, 0);
  }
});

test('普通账号无管理员绑定时拒绝进入管理页', async () => {
  const { handler } = setup();
  await handler({ action: 'login' });
  const result = await handler({ action: 'checkAdmin' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN');
});

test('未登录的管理核验不会创建身份', async () => {
  const { handler, tables } = setup();
  const result = await handler({ action: 'checkAdmin' });
  assert.equal(result.error.code, 'LOGIN_REQUIRED');
  assert.equal(tables.users.size, 0);
});

test('有效绑定通过核验；停用后下一次请求立即拒绝', async () => {
  const { handler, tables } = setup();
  const login = await handler({ action: 'login' });
  const id = login.data.user.id;
  tables.admin_bindings.set(id, { _id: id, user_id: id, role: 'admin', status: 'enabled' });
  assert.equal((await handler({ action: 'checkAdmin' })).ok, true);
  tables.admin_bindings.get(id).status = 'disabled';
  assert.equal((await handler({ action: 'checkAdmin' })).error.code, 'FORBIDDEN');
});

test('停用、注销中与未知账号状态不能通过登录、恢复或管理核验', async () => {
  for (const status of ['disabled', 'deleting', 'deleted', 'unknown']) {
    const { handler, tables } = setup();
    const login = await handler({ action: 'login' });
    tables.users.get(login.data.user.id).status = status;
    for (const action of ['login', 'current', 'checkAdmin']) {
      assert.equal((await handler({ action })).error.code, 'ACCOUNT_RESTRICTED');
    }
  }
});

test('数据库异常不伪造成功、不向客户端返回内部异常', async () => {
  const handler = createIdentityHandler({
    db: { collection() { throw new Error('private database failure detail'); } },
    getWXContext: () => ({ OPENID: 'test-wechat-user', APPID }),
    logger: { error() {} },
  });
  const result = await handler({ action: 'login' });
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private database'), false);
});
