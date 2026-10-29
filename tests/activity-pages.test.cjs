const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadPage(file, dependencies = {}, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8'), {
    Page: (page) => { definition = page; }, wx,
    require: (name) => dependencies[name] || {},
  });
  return { ...definition, data: structuredClone(definition.data), _visible: true, _loginVersion: 1,
    setData(update) {
      for (const [key, value] of Object.entries(update)) {
        const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const part of keys.slice(0, -1)) target = target[part];
        target[keys.at(-1)] = value;
      }
    },
  };
}

function editor(catalog = {}, wx = {}, uploads = {}) {
  return loadPage('admin/pages/activity-editor/index.js', {
    '../../../services/identity': { verifyAdministrator: uploads.verifyAdministrator || (async () => {}) },
    '../../../services/catalog': { displayDate: (value) => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10), ...catalog },
    '../../services/step-images': { prepareStepImage: async () => ({ filePath: '/compressed.jpg', cleanup() {} }), ...uploads },
    '../../services/step-upload': { uploadStepFile: async () => ({ fileId: 'cloud://test/image', url: 'https://example.com/image' }), ...uploads },
  }, wx);
}

test('广场分页保持顺序并去重，刷新替换旧列表', async () => {
  const responses = [
    { items: [{ id: 'a_1' }], cursor: 'next' },
    { items: [{ id: 'a_1' }, { id: 'a_2' }], cursor: '' },
    { items: [{ id: 'a_3' }], cursor: '' },
  ];
  const cursors = [];
  const page = loadPage('pages/square/index.js', {
    '../../services/login-page': { createLoginPage: (options) => options },
    '../../services/catalog': {
      callCatalog: async (_, input) => { cursors.push(input.cursor || ''); return responses.shift(); },
      displayDate: () => '',
    },
  });
  page.data.authenticated = true;
  await page.loadActivities(true);
  const firstPage = page.data.items;
  await page.loadActivities(false);
  assert.equal(page.data.items.map((item) => item.id).join(','), 'a_1,a_2');
  assert.equal(firstPage.length, 1);
  assert.equal(page.data.hasMore, false);
  await page.loadActivities(true);
  assert.equal(page.data.items.map((item) => item.id).join(','), 'a_3');
  assert.deepEqual(cursors, ['', 'next', '']);
});

test('编辑页合并多页平台，添加步骤保留旧内容和独立图片数组', async () => {
  const page = editor({ callCatalog: async (_, input) => input.cursor
    ? { items: [{ _id: 'p_2', name: '平台二' }], cursor: '' }
    : { items: [{ _id: 'p_1', name: '平台一' }], cursor: 'next' } });
  page.onLoad({});
  await page.onShow();
  assert.equal(page.data.platforms.map((item) => item._id).join(','), 'p_1,p_2');
  const original = page.data.activity.participation_steps;
  original[0].text = '原步骤';
  page.onAddStep();
  const steps = page.data.activity.participation_steps;
  assert.equal(original.length, 1);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, '原步骤');
  steps[1].images.push('cloud://test/new');
  assert.equal(steps[0].images.length, 0);
});

test('编辑页选项同步正确索引；非固定期限清空结束日期；日期清除不改动开始日期', () => {
  const page = editor();
  page.data.activity.end_at = '2026-11-01T23:59:59+08:00';
  page.data.endDate = '2026-11-01';
  page.onOptionChange({ currentTarget: { dataset: { field: 'entry_type' } }, detail: { value: '1' } });
  assert.equal(page.data.entryTypeIndex, 1);
  assert.equal(page.data.activity.entry_type, 'mini_program');
  page.onOptionChange({ currentTarget: { dataset: { field: 'validity_type' } }, detail: { value: '2' } });
  assert.equal(page.data.validityTypeIndex, 2);
  assert.equal(page.data.activity.end_at, '');
  assert.equal(page.data.endDate, '');
  page.onDateChange({ currentTarget: { dataset: { field: 'start_at' } }, detail: { value: '2026-10-29' } });
  page.onClearDate({ currentTarget: { dataset: { field: 'end_at' } } });
  assert.equal(page.data.activity.start_at, '2026-10-29T00:00:00+08:00');
});

test('旧活动的日期按北京时间展示，原文字步骤转换为图文；再次显示不覆盖未保存内容', async () => {
  let reads = 0;
  const page = editor({ callCatalog: async (action) => {
    reads++;
    return action === 'platforms' ? { items: [{ _id: 'p_test', name: '平台' }], cursor: '' }
      : { item: { title: '原活动', start_at: '2026-10-28T16:00:00.000Z', reward_summary: '奖励', eligibility: '条件', participation_steps: ['先打开平台'], platform_id: 'p_test' } };
  } });
  page.onLoad({ id: 'a_test' });
  await page.onShow();
  assert.equal(page.data.startDate, '2026-10-29');
  assert.equal(page.data.activity.activity_info, '奖励\n条件');
  assert.equal(page.data.activity.participation_steps[0].text, '先打开平台');
  page.onInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '未保存内容' } });
  page.onHide();
  await page.onShow();
  assert.equal(page.data.activity.title, '未保存内容');
  assert.equal(reads, 2);
  assert.equal(page.data.dirty, true);
});

test('已上传图片保存到对应步骤，移除图片保留步骤文字；未保存修改不能被核验', async () => {
  let verifies = 0;
  const page = editor({ mutate: async () => { verifies++; } });
  page.data.authorized = true;
  page.data.activity.participation_steps[0].text = '打开平台签到';
  await page.onImagesSelected({ detail: { name: 0, file: [{ size: 500 * 1024 * 1024, url: '/test.heic' }] } });
  assert.equal(page.data.activity.participation_steps[0].images[0], 'cloud://test/image');
  assert.equal(page.data.uploading, false);
  page.onDeleteStepImage({ detail: { name: 0, index: 0 } });
  assert.equal(page.data.activity.participation_steps[0].images.length, 0);
  assert.equal(page.data.activity.participation_steps[0].text, '打开平台签到');
  await page.onVerify();
  assert.equal(verifies, 0);
  assert.match(page.data.error, /先保存/);
});

test('上传失败保留缩略图可重试，失败项不允许保存，压缩文件始终清理', async () => {
  let attempts = 0;
  let cleaned = 0;
  const page = editor({}, {}, {
    prepareStepImage: async (_, filePath) => {
      assert.equal(filePath, '/selected.heic');
      return { filePath: '/compressed.jpg', cleanup() { cleaned++; } };
    },
    uploadStepFile: async (filePath, progress) => {
      assert.equal(filePath, '/compressed.jpg');
      progress('校验中');
      if (++attempts === 1) throw new Error('图片文件直传失败（-1）');
      return { fileId: 'cloud://test/retried', url: 'https://example.com/retried' };
    },
  });
  page.data.authorized = true;
  await page.onImagesSelected({ detail: { name: 0, file: { url: '/selected.heic' } } });
  assert.equal(page.data.uploading, false);
  assert.equal(page.data.activity.participation_steps[0].file_list[0].status, 'failed');
  assert.equal(page.data.activity.participation_steps[0].images.length, 0);
  await page.onSave();
  assert.match(page.data.error, /重试或删除/);
  await page.onStepImagePreview({ detail: { name: 0, index: 0 } });
  assert.equal(attempts, 2);
  assert.equal(cleaned, 2);
  assert.equal(page.data.activity.participation_steps[0].images[0], 'cloud://test/retried');
  assert.equal(page.data.activity.participation_steps[0].file_list[0].status, 'done');
});

test('页面卸载时结束压缩不继续上传，且释放临时文件', async () => {
  let finish;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let cleaned = 0;
  let uploaded = 0;
  const page = editor({}, {}, {
    prepareStepImage: () => new Promise((resolve) => { finish = resolve; markStarted(); }),
    uploadStepFile: async () => { uploaded++; },
  });
  page.data.authorized = true;
  const request = page.onImagesSelected({ detail: { name: 0, file: { url: '/selected.heic' } } });
  await started;
  page.onUnload();
  finish({ filePath: '/compressed.jpg', cleanup() { cleaned++; } });
  await request;
  assert.equal(uploaded, 0);
  assert.equal(cleaned, 1);
});

test('相册返回时等待新的管理员核验，保留选图而不被 authorized=false 丢弃', async () => {
  let allow;
  let uploads = 0;
  const page = editor({}, {}, {
    verifyAdministrator: () => new Promise((resolve) => { allow = resolve; }),
    uploadStepFile: async () => { uploads++; return { fileId: 'cloud://test/image', url: 'https://example.com/image' }; },
  });
  page.data.authorized = false;
  const request = page.onImagesSelected({ detail: { name: 0, file: { url: '/selected.heic' } } });
  assert.equal(page.data.uploading, true);
  assert.equal(uploads, 0);
  allow();
  await request;
  assert.equal(uploads, 1);
  assert.equal(page.data.uploading, false);
});

function detail(callCatalog, navigate, extraWx = {}) {
  const page = loadPage('pages/activity-detail/index.js', {
    '../../services/login-page': { createLoginPage: (options) => options },
    '../../services/catalog': { callCatalog },
  }, { navigateToMiniProgram: navigate, canIUse: () => true, ...extraWx });
  page._activityId = 'a_test';
  page.data.item = { executable: true };
  return page;
}

test('详情点击重新核验入口后以 shortLink 跳转；取消跳转反馈明确', async () => {
  let calls = 0;
  const address = '#小程序://影视飓风Club/xRvsl3uWbxEqwYd';
  const page = detail(async (action, input) => {
    assert.equal(action, 'entry');
    assert.equal(input.id, 'a_test');
    return { item: { entry_type: 'mini_program', direct_open_enabled: true, target_address: address } };
  }, (options) => {
    calls++;
    assert.equal(options.shortLink, address);
    assert.equal(options.appId, undefined);
    options.fail({ errMsg: 'navigateToMiniProgram:fail cancel' });
  });
  assert.equal(calls, 0);
  await page.onOpenEntry();
  assert.equal(calls, 1);
  assert.equal(page.data.entryMessage, '已取消打开');
  assert.equal(page.data.opening, false);
});

test('活动入口停用或旧微信不支持短链时不跳转，并保留回退信息', async () => {
  let calls = 0;
  const page = detail(async () => { throw new Error('活动当前不可参与'); }, () => calls++);
  await page.onOpenEntry();
  assert.equal(calls, 0);
  assert.equal(page.data.entryMessage, '活动当前不可参与');
  const oldWechat = detail(async () => ({ item: { entry_type: 'mini_program', direct_open_enabled: true, target_address: '#小程序://名称/token' } }), () => calls++, { canIUse: () => false });
  await oldWechat.onOpenEntry();
  assert.equal(calls, 0);
  assert.match(oldWechat.data.entryMessage, /更新微信或复制入口/);
});

test('详情离开后延迟的入口核验响应不触发外部跳转', async () => {
  let finish;
  let calls = 0;
  const page = detail(() => new Promise((resolve) => { finish = resolve; }), () => calls++);
  const pending = page.onOpenEntry();
  page._visible = false;
  page._loginVersion++;
  finish({ item: { entry_type: 'mini_program', direct_open_enabled: true, target_address: '#小程序://名称/token' } });
  await pending;
  assert.equal(calls, 0);
});

test('步骤缩略图从点击图片开始预览，合并有效图片并保持步骤顺序', () => {
  let preview;
  const page = detail(async () => ({}), () => {}, { previewImage(options) { preview = options; } });
  page.data.item = { participation_steps: [
    { image_urls: ['https://example.test/first.jpg', '', 'https://example.test/second.jpg'] },
    { image_urls: ['https://example.test/first.jpg', null, 'https://example.test/third.jpg'] },
  ] };
  page.onPreviewImage({ currentTarget: { dataset: { url: 'https://example.test/second.jpg' } } });
  assert.equal(preview.current, 'https://example.test/second.jpg');
  assert.equal(preview.urls.join(','), 'https://example.test/first.jpg,https://example.test/second.jpg,https://example.test/third.jpg');
});

test('受限、已离开、图片失效时不打开预览；预览失败提供重试提示', () => {
  let calls = 0;
  const messages = [];
  const page = detail(async () => ({}), () => {}, {
    previewImage(options) { calls++; options.fail(); }, showToast(options) { messages.push(options.title); },
  });
  const event = { currentTarget: { dataset: { url: 'https://example.test/current.jpg' } } };
  page.data.item = null; page.onPreviewImage(event);
  page.data.item = { restricted: true, participation_steps: [{ image_urls: [event.currentTarget.dataset.url] }] };
  page.onPreviewImage(event);
  page.data.item.restricted = false;
  page._visible = false; page.onPreviewImage(event);
  page._visible = true;
  page.onPreviewImage({ currentTarget: { dataset: { url: 'https://example.test/old.jpg' } } });
  assert.equal(calls, 0);
  page.onPreviewImage(event);
  assert.equal(calls, 1); assert.match(messages[0], /刷新详情/);
});
