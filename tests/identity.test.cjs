const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityHandler } = require('../cloudfunctions/identity/handler');

const APPID = 'wxb7e6889ef5fe7e88';

function setup(options = {}) {
  const tables = { users: new Map(), admin_bindings: new Map(), user_activities: new Map(), activity_views: new Map(), checkins: new Map() };
  const db = {
    collection(name) {
      if (!tables[name]) throw new Error('collection unavailable');
      return {
        where(query) {
          const matches = () => [...tables[name].values()]
            .filter((doc) => Object.entries(query).every(([key, value]) => doc[key] === value));
          return {
            count: async () => ({ total: matches().length }),
            limit: (count) => ({
              get: async () => ({
                data: structuredClone(matches().slice(0, count)),
              }),
            }),
          };
        },
        doc(id) {
          return {
            update: async ({ data }) => {
              if (!tables[name].has(id)) return { stats: { updated: 0 } };
              Object.assign(tables[name].get(id), structuredClone(data));
              return { stats: { updated: 1 } };
            },
          };
        },
        aggregate() {
          let rows = [...tables[name].values()];
          let field;
          const chain = {
            match(query) {
              rows = rows.filter((doc) => Object.entries(query).every(([key, value]) => doc[key] === value));
              return chain;
            },
            group(query) { field = query._id.slice(1); return chain; },
            count(key) {
              const total = new Set(rows.map((doc) => doc[field])).size;
              return { end: async () => ({ list: total ? [{ [key]: total }] : [] }) };
            },
          };
          return chain;
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
    ...options.services,
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
  assert.deepEqual(Object.keys(result.data.user).sort(), ['avatarUrl', 'displayName', 'id']);
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

test('绑定使用数据库生成的独立 _id 时按 user_id 核验，停用和恢复均生效', async () => {
  const { handler, tables } = setup();
  const login = await handler({ action: 'login' });
  const id = login.data.user.id;
  const bindingId = 'auto-generated-binding-id';
  tables.admin_bindings.set(bindingId, { _id: bindingId, user_id: id, role: 'admin', status: 'enabled' });

  const result = await handler({ action: 'checkAdmin' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.admin, { bindingId, role: 'admin' });
  tables.admin_bindings.get(bindingId).status = 'disabled';
  assert.equal((await handler({ action: 'checkAdmin' })).error.code, 'FORBIDDEN');
  tables.admin_bindings.get(bindingId).status = 'enabled';
  assert.equal((await handler({ action: 'checkAdmin' })).ok, true);
});

test('重复绑定无论状态与记录顺序如何均拒绝授权', async () => {
  for (const statuses of [['enabled', 'enabled'], ['disabled', 'enabled'], ['enabled', 'disabled']]) {
    const { handler, tables } = setup();
    const login = await handler({ action: 'login' });
    const id = login.data.user.id;
    statuses.forEach((status, index) => {
      const bindingId = `binding-${index}`;
      tables.admin_bindings.set(bindingId, { _id: bindingId, user_id: id, role: 'admin', status });
    });
    const result = await handler({ action: 'checkAdmin' });
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.equal(result.data, undefined);
  }
});

test('记录 _id 与当前用户相同但 user_id 错误或缺失时不能授权', async () => {
  for (const fields of [{ user_id: 'another-user' }, {}]) {
    const { handler, tables } = setup();
    const login = await handler({ action: 'login' });
    const id = login.data.user.id;
    tables.admin_bindings.set(id, { _id: id, ...fields, role: 'admin', status: 'enabled' });
    assert.equal((await handler({ action: 'checkAdmin' })).error.code, 'FORBIDDEN');
  }
});

test('客户端指定其他用户或管理员角色不能借用他人绑定', async () => {
  const { handler, tables } = setup();
  await handler({ action: 'login' });
  tables.admin_bindings.set('binding-other', {
    _id: 'binding-other', user_id: 'another-user', role: 'admin', status: 'enabled',
  });
  const result = await handler({
    action: 'checkAdmin', user_id: 'another-user', _id: 'binding-other', role: 'admin',
  });
  assert.equal(result.error.code, 'FORBIDDEN');
});

test('绑定的角色或状态缺失和无效时不能授权', async () => {
  for (const fields of [{ role: 'viewer', status: 'enabled' }, { status: 'enabled' }, { role: 'admin' }, { role: 'admin', status: 'unknown' }]) {
    const { handler, tables } = setup();
    const login = await handler({ action: 'login' });
    const id = login.data.user.id;
    tables.admin_bindings.set('binding', { _id: 'binding', user_id: id, ...fields });
    assert.equal((await handler({ action: 'checkAdmin' })).error.code, 'FORBIDDEN');
  }
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

test('个人统计从当前清单和去重后的浏览、完成记录计算', async () => {
  const { handler, tables } = setup();
  const login = await handler({ action: 'login' });
  const user_id = login.data.user.id;
  tables.user_activities.set('joined-a', { user_id, activity_id: 'a', status: 'active' });
  tables.user_activities.set('joined-b', { user_id, activity_id: 'b', status: 'active' });
  tables.user_activities.set('removed-c', { user_id, activity_id: 'c', status: 'removed' });
  tables.activity_views.set('view-a-1', { user_id, activity_id: 'a' });
  tables.activity_views.set('view-a-2', { user_id, activity_id: 'a' });
  tables.activity_views.set('view-b', { user_id, activity_id: 'b' });
  tables.activity_views.set('view-c', { user_id, activity_id: 'c' });
  tables.checkins.set('checkin-a-day1', { user_id, activity_id: 'a' });
  tables.checkins.set('checkin-a-day2', { user_id, activity_id: 'a' });
  const result = await handler({ action: 'summary' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.summary, { joined: 2, browsed: 3, completed: 1 });
});

test('无业务记录返回真实零值，统计集合未创建时返回服务错误', async () => {
  const { handler, tables } = setup();
  await handler({ action: 'login' });
  assert.deepEqual((await handler({ action: 'summary' })).data.summary, { joined: 0, browsed: 0, completed: 0 });
  delete tables.activity_views;
  const result = await handler({ action: 'summary' });
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.data, undefined);
});

test('保存昵称后重新登录恢复资料，保留同一用户身份和账号状态', async () => {
  const { handler, tables } = setup();
  const login = await handler({ action: 'login' });
  const result = await handler({ action: 'saveProfile', displayName: '  一起打卡  ' });
  assert.equal(result.ok, true);
  assert.equal(result.data.user.displayName, '一起打卡');
  assert.equal(result.data.user.id, login.data.user.id);
  assert.equal((await handler({ action: 'current' })).data.user.displayName, '一起打卡');
  assert.equal(tables.users.get(login.data.user.id).status, 'active');
});

test('用户选择的头像通过服务端上传，资料读取时生成临时链接', async () => {
  const uploads = [];
  const deleted = [];
  const { handler, tables } = setup({ services: {
    uploadAvatar: async (options) => { uploads.push(options); return `cloud://synthetic-avatar-${uploads.length}`; },
    getAvatarUrl: async (id) => `https://example.test/avatar/${id.slice('cloud://'.length)}`,
    deleteAvatar: async (id) => { deleted.push(id); },
  } });
  const login = await handler({ action: 'login' });
  const avatarBase64 = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/assets/brand/avatar.png')).toString('base64');
  const result = await handler({ action: 'saveProfile', displayName: '打卡用户', avatarBase64 });
  assert.equal(result.ok, true);
  assert.equal(uploads.length, 1);
  assert(uploads[0].cloudPath.startsWith(`user-avatars/${login.data.user.id}/`));
  assert(uploads[0].cloudPath.endsWith('.png'));
  assert(Buffer.isBuffer(uploads[0].fileContent));
  assert.equal(result.data.user.avatarUrl, 'https://example.test/avatar/synthetic-avatar-1');
  assert.equal(tables.users.get(login.data.user.id).avatar_file_id, 'cloud://synthetic-avatar-1');
  await handler({ action: 'saveProfile', displayName: '打卡用户', avatarBase64 });
  assert.deepEqual(deleted, ['cloud://synthetic-avatar-1']);
});

test('头像存储失败时不修改已有昵称，头像链接过期时仍能恢复身份', async () => {
  const { handler, tables } = setup({ services: {
    uploadAvatar: async () => { throw new Error('storage unavailable'); },
    getAvatarUrl: async () => { throw new Error('url unavailable'); },
  } });
  const login = await handler({ action: 'login' });
  const record = tables.users.get(login.data.user.id);
  record.display_name = '原昵称';
  record.avatar_file_id = 'cloud://old-avatar';
  const avatarBase64 = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/assets/brand/avatar.png')).toString('base64');
  const result = await handler({ action: 'saveProfile', displayName: '新昵称', avatarBase64 });
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  const current = await handler({ action: 'current' });
  assert.equal(current.ok, true);
  assert.equal(current.data.user.displayName, '原昵称');
  assert.equal(current.data.user.avatarUrl, '');
});

test('拒绝空昵称、超长昵称、控制字符与非图片内容，不写入资料', async () => {
  const { handler, tables } = setup();
  const login = await handler({ action: 'login' });
  for (const profile of [
    { displayName: '' }, { displayName: ' '.repeat(5) }, { displayName: '长'.repeat(25) },
    { displayName: '名字\u0000' }, { displayName: '名字', avatarBase64: Buffer.from('not an image').toString('base64') },
    { displayName: '名字', avatarBase64: 'a'.repeat(1400004) },
  ]) {
    assert.equal((await handler({ action: 'saveProfile', ...profile })).error.code, 'INVALID_PROFILE');
  }
  assert.equal(tables.users.get(login.data.user.id).display_name, undefined);
});

test('资料和统计接口拒绝未登录或被停用的用户，统计不受客户端 user_id 影响', async () => {
  const { handler, tables } = setup();
  for (const action of ['summary', 'saveProfile']) {
    assert.equal((await handler({ action, displayName: '名字' })).error.code, 'LOGIN_REQUIRED');
  }
  const login = await handler({ action: 'login' });
  const id = login.data.user.id;
  tables.user_activities.set('other-user-task', { user_id: 'another-user', activity_id: 'a', status: 'active' });
  tables.activity_views.set('other-user-view', { user_id: 'another-user', activity_id: 'a' });
  tables.checkins.set('other-user-checkin', { user_id: 'another-user', activity_id: 'a' });
  assert.deepEqual((await handler({ action: 'summary', user_id: 'another-user' })).data.summary, { joined: 0, browsed: 0, completed: 0 });
  tables.users.get(id).status = 'disabled';
  for (const action of ['summary', 'saveProfile']) {
    assert.equal((await handler({ action, displayName: '名字' })).error.code, 'ACCOUNT_RESTRICTED');
  }
});
