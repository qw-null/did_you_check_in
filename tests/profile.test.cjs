const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadService(callFunction) {
  const module = { exports: {} };
  const wx = { cloud: { callFunction } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/identity.js'), 'utf8'), {
    module, exports: module.exports, require: () => ({ envId: 'test-environment' }), wx,
  });
  return module.exports;
}

const user = { id: 'u_synthetic-test-user', displayName: '测试用户', avatarUrl: '' };

test('启动与页面同时登录共享一次云请求，无需头像昵称授权弹窗', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let calls = 0;
  const service = loadService(({ data }) => {
    assert.equal(data.action, 'login');
    calls++;
    return pending;
  });
  const first = service.ensureIdentity();
  const second = service.ensureIdentity();
  assert.equal(calls, 1);
  resolve({ result: { ok: true, data: { user } } });
  assert.equal(await first, user);
  assert.equal(await second, user);
  assert.equal(await service.ensureIdentity(), user);
  assert.equal(calls, 1);
});

test('登录网络失败后可以重试，成功结果通知当前页面', async () => {
  let calls = 0;
  const service = loadService(async () => {
    if (++calls === 1) throw new Error('network unavailable');
    return { result: { ok: true, data: { user } } };
  });
  const updates = [];
  const unsubscribe = service.subscribeIdentity((value) => updates.push(value));
  await assert.rejects(service.ensureIdentity(), { code: 'CLOUD_CALL_FAILED' });
  assert.equal(service.getCachedUser(), null);
  assert.equal(await service.ensureIdentity(), user);
  assert.equal(updates.at(-1), user);
  unsubscribe();
  service.clearIdentity();
  assert.equal(updates.at(-1), user);
});

function loadLoginPage(ensureIdentity) {
  const module = { exports: {} };
  const subscribers = new Set();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/login-page.js'), 'utf8'), {
    module, exports: module.exports,
    require: () => ({
      ensureIdentity,
      subscribeIdentity: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    }),
  });
  const definition = module.exports.createLoginPage();
  return {
    ...definition, data: { ...definition.data },
    setData(value) { Object.assign(this.data, value); },
  };
}

test('登录进行中保持活动区关闭，成功后显示，失败时允许重新登录', async () => {
  let done;
  let calls = 0;
  const page = loadLoginPage(() => ++calls === 1
    ? Promise.reject(new Error('连接失败'))
    : new Promise((resolve) => { done = resolve; }));
  await page.onShow();
  assert.equal(page.data.authenticated, false);
  assert.equal(page.data.loginLoading, false);
  assert.equal(page.data.loginError, '连接失败');
  const request = page.onLogin();
  assert.equal(page.data.authenticated, false);
  assert.equal(page.data.loginLoading, true);
  done(user);
  await request;
  assert.equal(page.data.authenticated, true);
  assert.equal(page.data.user, user);
});

test('切换 tab 后较早登录结果不更新已隐藏的页面', async () => {
  let done;
  const page = loadLoginPage(() => new Promise((resolve) => { done = resolve; }));
  const request = page.onShow();
  page.onHide();
  done(user);
  await request;
  assert.equal(page.data.authenticated, false);
  assert.equal(page.data.user, null);
});

test('清除身份后较早的云端成功响应不能重新恢复账号', async () => {
  let done;
  const service = loadService(() => new Promise((resolve) => { done = resolve; }));
  const request = service.ensureIdentity();
  service.clearIdentity();
  done({ result: { ok: true, data: { user } } });
  await assert.rejects(request, { code: 'IDENTITY_CHANGED' });
  assert.equal(service.getCachedUser(), null);
});

test('刷新登录重新检查被停用的账号并清空旧资料', async () => {
  let calls = 0;
  const service = loadService(async () => ++calls === 1
    ? { result: { ok: true, data: { user } } }
    : { result: { ok: false, error: { code: 'ACCOUNT_RESTRICTED' } } });
  await service.ensureIdentity();
  await assert.rejects(service.ensureIdentity({ refresh: true }), { code: 'ACCOUNT_RESTRICTED' });
  assert.equal(service.getCachedUser(), null);
});

function loadProfile({ summary = async () => ({ summary: { joined: 0, browsed: 0, completed: 0 } }), save } = {}) {
  let definition;
  let currentUser = user;
  const subscribers = new Set();
  const saved = [];
  const copied = [];
  const identity = {
    ensureIdentity: async () => currentUser,
    getCachedUser: () => currentUser,
    getPersonalSummary: summary,
    subscribeIdentity: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    saveProfile: async (profile) => {
      saved.push(profile);
      if (save) await save(profile);
      currentUser = { ...currentUser, displayName: profile.displayName };
      for (const listener of subscribers) listener(currentUser);
      return currentUser;
    },
  };
  const loginModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/login-page.js'), 'utf8'), {
    module: loginModule, require: () => identity,
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    require: (name) => name.endsWith('login-page') ? loginModule.exports : identity,
    Page: (value) => { definition = value; },
    wx: { showToast() {}, navigateTo() {}, setClipboardData: (value) => copied.push(value.data) },
  });
  return {
    page: { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } },
    saved, copied,
  };
}

test('我的页面展示当前用户及真实零值，底部复制完整 ID', async () => {
  const { page, copied } = loadProfile();
  await page.onShow();
  assert.equal(page.data.authenticated, true);
  assert.equal(page.data.user.displayName, '测试用户');
  assert.equal(page.data.summary.joined, 0);
  assert.equal(page.data.summary.browsed, 0);
  assert.equal(page.data.summary.completed, 0);
  assert.notEqual(page.data.shortUserId, user.id);
  page.onCopyUserId();
  assert.deepEqual(copied, [user.id]);
});

test('统计失败不填伪造零值且不影响用户已登录状态', async () => {
  const { page } = loadProfile({ summary: async () => { throw new Error('missing collection'); } });
  await page.onShow();
  assert.equal(page.data.authenticated, true);
  assert.equal(page.data.summary, null);
  assert.equal(page.data.summaryLoading, false);
  assert(page.data.summaryError.includes('重试'));
});

test('较早的统计请求完成时不覆盖重新显示页面后的新统计', async () => {
  let resolve;
  let markStarted;
  const started = new Promise((done) => { markStarted = done; });
  let calls = 0;
  const { page } = loadProfile({ summary: () => ++calls === 1
    ? new Promise((done) => { resolve = done; markStarted(); })
    : Promise.resolve({ summary: { joined: 3, browsed: 5, completed: 2 } }) });
  const old = page.onShow();
  await started;
  page.onHide();
  await page.onShow();
  resolve({ summary: { joined: 1, browsed: 1, completed: 1 } });
  await old;
  assert.equal(page.data.summary.joined, 3);
  assert.equal(page.data.summary.browsed, 5);
});

test('资料可取消，昵称单独保存后立即显示新资料', async () => {
  const { page, saved } = loadProfile();
  await page.onShow();
  page.onEditProfile();
  assert.equal(page.data.editorOpen, true);
  page.onCloseEditor();
  assert.equal(saved.length, 0);
  page.onEditProfile();
  await page.onSaveProfile({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].displayName, '新昵称');
  assert.equal(saved[0].avatarBase64, undefined);
  assert.equal(page.data.user.displayName, '新昵称');
  assert.equal(page.data.editorOpen, false);
});

test('资料保存失败时保留编辑界面并允许重试', async () => {
  const { page } = loadProfile({ save: async () => { throw new Error('上传失败'); } });
  await page.onShow();
  page.onEditProfile();
  await page.onSaveProfile({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(page.data.profileError, '上传失败');
  assert.equal(page.data.profileSaving, false);
  assert.equal(page.data.editorOpen, true);
  assert.equal(page.data.user.displayName, '测试用户');
});

test('昵称按 Unicode 字符计数，24 个补充平面字符可保存，25 个拒绝', async () => {
  const { page, saved } = loadProfile();
  await page.onShow();
  page.onEditProfile();
  const character = '\u{20BB7}';
  await page.onSaveProfile({ detail: { value: { nickname: character.repeat(25) } } });
  assert.equal(saved.length, 0);
  assert.equal(page.data.editorOpen, true);
  await page.onSaveProfile({ detail: { value: { nickname: character.repeat(24) } } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].displayName, character.repeat(24));
});
