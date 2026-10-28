const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadPage(file, verify) {
  let definition;
  const modals = [];
  const navigation = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    require: (name) => name.includes('identity') ? { verifyAdministrator: verify } : { name: '打卡了吗', description: '', version: '0.2.0' },
    Page: (value) => { definition = value; },
    Date,
    getApp: () => ({ globalData: { runtimeEnv: 'develop', cloudStatus: 'initialized' } }),
    wx: {
      navigateTo: (options) => navigation.push(options.url),
      redirectTo: (options) => navigation.push(options.url),
      showModal: (options) => modals.push(options),
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(data) { Object.assign(this.data, data); } };
  return { page, modals, navigation };
}

test('管理员页面先隐藏内容，等待本次服务端核验通过', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { page } = loadPage('miniprogram/admin/pages/dashboard/index.js', () => pending);
  const request = page.onShow();
  assert.equal(page.data.authorized, false);
  resolve({});
  await request;
  assert.equal(page.data.authorized, true);
  page.onHide();
  assert.equal(page.data.authorized, false);
});

test('管理页核验失败时不展示内容，返回关于页', async () => {
  const { page, modals, navigation } = loadPage('miniprogram/admin/pages/dashboard/index.js', async () => { throw new Error('当前账号没有管理权限'); });
  await page.onShow();
  assert.equal(page.data.authorized, false);
  modals[0].complete();
  assert.deepEqual(navigation, ['/pages/about/index']);
});

test('返回前台后的新核验失败，先前延迟成功不能重新显示管理内容', async () => {
  let firstResolve;
  let calls = 0;
  const first = new Promise((resolve) => { firstResolve = resolve; });
  const { page } = loadPage('miniprogram/admin/pages/dashboard/index.js', () => ++calls === 1 ? first : Promise.reject(new Error('权限失效')));
  const old = page.onShow();
  page.onHide();
  await page.onShow();
  firstResolve({});
  await old;
  assert.equal(page.data.authorized, false);
});

test('关于页三击核验成功才跳转，核验中重复点击不产生第二次请求', async () => {
  let resolve;
  let calls = 0;
  const pending = new Promise((done) => { resolve = done; });
  const { page, navigation } = loadPage('miniprogram/pages/about/index.js', () => { calls++; return pending; });
  page.onShow();
  await page.onVersionTap();
  await page.onVersionTap();
  const third = page.onVersionTap();
  await page.onVersionTap();
  assert.equal(calls, 1);
  assert.equal(navigation.length, 0);
  resolve({});
  await third;
  assert.deepEqual(navigation, ['/admin/pages/dashboard/index']);
});

test('关于页离开后原核验结果不触发隐藏页面跳转', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { page, navigation } = loadPage('miniprogram/pages/about/index.js', () => pending);
  page.onShow();
  await page.onVersionTap();
  await page.onVersionTap();
  const third = page.onVersionTap();
  page.onHide();
  resolve({});
  await third;
  assert.equal(navigation.length, 0);
});
