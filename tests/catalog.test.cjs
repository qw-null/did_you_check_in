const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogHandler } = require('../cloudfunctions/catalog/handler');
const { userIdFor, hash } = require('../cloudfunctions/catalog/rules');

const appId = 'wxb7e6889ef5fe7e88';
const openId = 'test-open-id';
const userId = userIdFor(appId, openId);
const now = new Date('2026-10-29T04:00:00.000Z');

function setup(seed = {}, options = {}) {
  const tables = Object.fromEntries(['users', 'admin_bindings', 'platforms', 'activities', 'activity_views', 'catalog_snapshots', 'catalog_requests', 'audit_logs', 'catalog_images', 'user_activities', 'checkins'].map((name) => [name, new Map()]));
  for (const [collection, rows] of Object.entries(seed)) for (const row of rows) tables[collection].set(row._id, structuredClone(row));
  const store = {
    async get(collection, id) { return tables[collection].get(id) || null; },
    async scan(collection, where = {}, after = '', limit = 100) {
      return [...tables[collection].values()].filter((row) => row._id > after && Object.entries(where).every(([key, value]) => row[key] === value)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit);
    },
    async count(collection, where = {}) { return (await this.scan(collection, where)).length; },
    async create(collection, row) { tables[collection].set(row._id, structuredClone(row)); },
    async transact(work) {
      return work({
        get: this.get.bind(this),
        async put(collection, id, row) { tables[collection].set(id, structuredClone({ ...row, _id: id })); },
      });
    },
  };
  const handler = createCatalogHandler({ store, getWXContext: () => ({ APPID: appId, OPENID: openId }), now: () => now, logger: { error() {} }, ...options });
  return { handler, tables };
}

const user = { _id: userId, status: 'active' };
const platform = { _id: 'p_test', name: '測試平台', status: 'enabled', revision: 1 };
function activity(overrides = {}) {
  return {
    _id: 'a_test', platform_id: platform._id, title: '每日签到活动', category: 'points', frequency: 'daily',
    keywords: '每日 积分', reward_summary: '每日领取积分', eligibility: '所有用户可参加', rules_note: '',
    entry_type: 'instructions', entry_url: '', target_app_id: '', target_page_path: '', target_mini_program_name: '',
    search_keyword: '', participation_steps: ['打开测试平台活动页', '完成签到并手动确认'], validity_type: 'ongoing',
    start_at: null, end_at: null, validity_note: '长期开展', source_reference: 'https://example.com/activity', owner_admin_id: 'binding-test',
    publication_status: 'published', first_published_at: new Date('2026-10-01T00:00:00.000Z'), verification_status: 'verified',
    last_verified_at: new Date('2026-10-29T00:00:00.000Z'), next_verify_at: new Date('2026-11-01T00:00:00.000Z'),
    content_restricted: false, revision: 1, ...overrides,
  };
}
function adminSeed(extra = {}) {
  return { users: [user], admin_bindings: [{ _id: 'binding-test', user_id: userId, role: 'admin', status: 'enabled' }], ...extra };
}

function directUpload(seed = adminSeed(), overrides = {}) {
  const objects = new Map();
  const uploads = [], removed = [];
  let date = now;
  const state = setup(seed, {
    now: () => date,
    getStorageEnv: () => 'test',
    downloadImage: async (fileId) => objects.get(fileId),
    uploadImage: async ({ cloudPath, fileContent }) => {
      const fileId = `cloud://test/${cloudPath}`;
      uploads.push(fileId); objects.set(fileId, fileContent); return fileId;
    },
    getImageUrls: async (files) => Object.fromEntries(files.map((file) => [file, objects.has(file) ? `https://storage.example.com/${hash(file)}` : ''])),
    deleteImage: async (file) => { removed.push(file); objects.delete(file); },
    ...overrides,
  });
  return { ...state, objects, uploads, removed, advance(ms) { date = new Date(now.getTime() + ms); },
    async selected(buffer = Buffer.from([255, 216, 255, 224])) {
      const response = await state.handler({ action: 'prepareStepImageUpload' });
      assert.equal(response.ok, true, response.error && response.error.message);
      const ticket = state.tables.catalog_images.get(response.data.uploadId);
      const fileId = `cloud://test/${response.data.cloudPath}`;
      objects.set(fileId, buffer);
      return { ...response.data, fileId, ticket };
    },
  };
}

test('原生云上传分配路径，校验后正式图片隔离，重复完成与取消不删除正式文件', async () => {
  const state = directUpload();
  const prepared = await state.selected();
  assert(prepared.cloudPath.startsWith('activity-step-staging/'));
  assert.equal(prepared.ticket.cloud_path, prepared.cloudPath);
  assert.equal(prepared.formData, undefined);
  const event = { action: 'completeStepImageUpload', uploadId: prepared.uploadId, fileId: prepared.fileId };
  const first = await state.handler(event);
  assert.equal(first.ok, true, first.error && first.error.message);
  const fileId = first.data.fileId;
  assert.notEqual(fileId, prepared.fileId);
  assert(fileId.endsWith('.jpg'));
  assert.equal(state.tables.catalog_images.get(hash(fileId)).file_id, fileId);
  assert.equal(state.tables.catalog_images.get(prepared.uploadId).status, 'completed');
  assert(!state.objects.has(prepared.fileId));
  const again = await state.handler(event);
  assert.equal(again.data.fileId, fileId);
  assert.equal(state.uploads.length, 1);
  await state.handler({ action: 'cancelStepImageUpload', uploadId: prepared.uploadId });
  assert(state.objects.has(fileId));
});

test('直传申请、完成和撤销均要求管理员，拒绝冒用与过期上传凭证', async () => {
  const guest = directUpload({ users: [user] });
  for (const action of ['prepareStepImageUpload', 'completeStepImageUpload', 'cancelStepImageUpload']) {
    assert.equal((await guest.handler({ action, uploadId: 'upload_forged' })).error.code, 'FORBIDDEN');
  }
  const state = directUpload();
  const prepared = await state.selected();
  assert.equal((await state.handler({ action: 'completeStepImageUpload', uploadId: 'upload_forged' })).error.code, 'INVALID_UPLOAD');
  const ticket = state.tables.catalog_images.get(prepared.uploadId);
  ticket.uploaded_by = 'another-user';
  assert.equal((await state.handler({ action: 'completeStepImageUpload', uploadId: prepared.uploadId })).error.code, 'INVALID_UPLOAD');
  ticket.uploaded_by = userId;
  state.advance(11 * 60 * 1000);
  assert.equal((await state.handler({ action: 'completeStepImageUpload', uploadId: prepared.uploadId })).error.code, 'UPLOAD_EXPIRED');
  assert.equal(state.uploads.length, 0);
});

test('直传成品校验真实格式与体积，不接受未转换 HEIC 或超限成品', async () => {
  for (const [buffer, code] of [
    [Buffer.from('ftypheic-not-a-jpeg'), 'UNSUPPORTED_IMAGE_FORMAT'],
    [Buffer.alloc(1024 * 1024 + 1), 'INVALID_INPUT'],
  ]) {
    const state = directUpload();
    const prepared = await state.selected(buffer);
    const response = await state.handler({ action: 'completeStepImageUpload', uploadId: prepared.uploadId, fileId: prepared.fileId });
    assert.equal(response.error.code, code);
    assert.equal(state.uploads.length, 0);
    await state.handler({ action: 'cancelStepImageUpload', uploadId: prepared.uploadId });
    assert(!state.objects.has(prepared.fileId));
  }
});

test('上传期间管理员被停用时，登记事务拒绝写入并回收候选文件', async () => {
  const state = directUpload(adminSeed(), {
    downloadImage: async (fileId) => {
      state.tables.admin_bindings.get('binding-test').status = 'disabled';
      return state.objects.get(fileId);
    },
  });
  const prepared = await state.selected();
  const response = await state.handler({ action: 'completeStepImageUpload', uploadId: prepared.uploadId, fileId: prepared.fileId });
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(state.tables.catalog_images.size, 1);
  assert(state.removed.includes(state.uploads[0]));
});

test('云函数拒绝跨环境、跨目录和其他上传路径文件，取消不能删除任意文件', async () => {
  const state = directUpload();
  const prepared = await state.selected();
  for (const fileId of [
    `cloud://another-env/${prepared.cloudPath}`,
    'cloud://test/activity-steps/u_test/existing.jpg',
    'cloud://test/activity-step-staging/u_test/another-ticket',
    `https://test/${prepared.cloudPath}`,
    `cloud://test/${prepared.cloudPath}?other=true`,
  ]) {
    for (const action of ['completeStepImageUpload', 'cancelStepImageUpload']) {
      const response = await state.handler({ action, uploadId: prepared.uploadId, fileId });
      assert.equal(response.error.code, 'INVALID_UPLOAD');
    }
  }
  assert.equal(state.uploads.length, 0);
  assert.equal(state.removed.length, 0);
  const cancelled = await state.handler({ action: 'cancelStepImageUpload', uploadId: prepared.uploadId, fileId: prepared.fileId });
  assert.equal(cancelled.ok, true);
  assert(!state.objects.has(prepared.fileId));
});

test('广场搜索、分类和快捷筛选只返回可执行匹配项', async () => {
  const daily = activity();
  const gift = activity({ _id: 'a_gift', category: 'gift', frequency: 'once', title: '礼品兑换' });
  const expiredVerify = activity({ _id: 'a_due', title: '过期核验', next_verify_at: new Date('2026-10-28T00:00:00.000Z') });
  const { handler } = setup({ users: [user], platforms: [platform], activities: [daily, gift, expiredVerify] });
  const all = await handler({ action: 'list' });
  assert.equal(all.ok, true);
  assert.deepEqual(all.data.items.map((item) => item.id), ['a_test', 'a_gift']);
  const result = await handler({ action: 'list', category: 'points', daily: true, query: '測試平台' });
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].id, daily._id);
  assert.equal((await handler({ action: 'list', category: 'gift', daily: true })).data.items.length, 0);
});

test('活动详情访问写入按用户和活动去重的浏览记录', async () => {
  const { handler, tables } = setup({ users: [user], platforms: [platform], activities: [activity()] });
  const detail = await handler({ action: 'detail', id: 'a_test' });
  assert.equal(detail.data.item.executable, true);
  assert.equal((await handler({ action: 'recordView', id: 'a_test' })).data.recorded, true);
  await handler({ action: 'recordView', id: 'a_test' });
  assert.equal(tables.activity_views.size, 1);
});

test('管理员依次保存草稿、核验并发布；变更修订号冲突时拒绝写入', async () => {
  const { handler, tables } = setup(adminSeed({ platforms: [platform] }));
  const input = {
    platform_id: platform._id, title: '每周会员积分', category: 'points', frequency: 'daily', keywords: '会员 积分',
    reward_summary: '签到获得积分', eligibility: '所有会员均可，无额外门槛', rules_note: '', entry_type: 'instructions',
    entry_url: '', target_app_id: '', target_page_path: '', target_mini_program_name: '', search_keyword: '',
    participation_steps: '打开平台首页\n进入会员中心完成签到', validity_type: 'ongoing', start_at: '', end_at: '',
    validity_note: '平台持续运营期间有效', source_reference: 'https://example.com/official-rules',
  };
  const saved = await handler({ action: 'saveActivity', requestId: 'save-1', input });
  assert.equal(saved.ok, true, saved.error && saved.error.message);
  const item = saved.data.item;
  const verified = await handler({ action: 'verifyActivity', requestId: 'verify-1', id: item._id, expectedRevision: item.revision, evidence: '已通过官方规则页面确认每日签到与积分发放条件。' });
  assert.equal(verified.ok, true, verified.error && verified.error.message);
  const published = await handler({ action: 'transitionActivity', requestId: 'publish-1', id: item._id, expectedRevision: verified.data.item.revision, status: 'published', reason: '内容已核验，允许公开展示' });
  assert.equal(published.data.item.publication_status, 'published');
  const stale = await handler({ action: 'saveActivity', requestId: 'stale-1', id: item._id, expectedRevision: item.revision, input: { ...input, title: '过期版本编辑' } });
  assert.equal(stale.error.code, 'CONFLICT');
  assert.equal(tables.audit_logs.size, 3);
});

test('管理请求标识幂等；同一标识的不同载荷冲突', async () => {
  const { handler, tables } = setup(adminSeed());
  const input = { name: '示例平台', description: '', official_url: '' };
  const first = await handler({ action: 'savePlatform', requestId: 'platform-1', input });
  const replay = await handler({ action: 'savePlatform', requestId: 'platform-1', input });
  assert.deepEqual(replay.data, first.data);
  assert.equal(tables.platforms.size, 1);
  const conflict = await handler({ action: 'savePlatform', requestId: 'platform-1', input: { ...input, name: '另一平台' } });
  assert.equal(conflict.error.code, 'REQUEST_CONFLICT');
});

const shortLink = '#小程序://影视飓风Club/xRvsl3uWbxEqwYd';
function simpleInput(extra = {}) {
  return { platform_id: platform._id, title: '积分活动', category: 'points', frequency: 'daily', keywords: '',
    activity_info: '签到可领取积分，会员参与，无需付费。', entry_type: 'mini_program', target_address: shortLink,
    search_keyword: '', participation_steps: [{ text: '打开活动小程序，进入会员中心完成签到', images: [] }],
    validity_type: 'ongoing', start_at: '', end_at: '', ...extra };
}

test('精简活动字段无需旧来源与门槛字段，可核验发布短链并在编辑后关闭直达', async () => {
  const { handler } = setup(adminSeed({ platforms: [platform] }));
  const saved = await handler({ action: 'saveActivity', requestId: 'simple-save', input: simpleInput() });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.equal(saved.data.item.activity_info, simpleInput().activity_info);
  assert.equal(saved.data.item.direct_open_enabled, false);
  const verified = await handler({ action: 'verifyActivity', requestId: 'simple-verify', id: saved.data.item._id, expectedRevision: 1, evidence: '在真机打开小程序并核实参与步骤及活动期限。', entryTested: true });
  assert.equal(verified.ok, true, JSON.stringify(verified.error));
  assert.equal(verified.data.item.direct_open_enabled, true);
  await handler({ action: 'transitionActivity', requestId: 'simple-publish', id: saved.data.item._id, expectedRevision: 2, status: 'published', reason: '核验通过后发布活动' });
  const entry = await handler({ action: 'entry', id: saved.data.item._id });
  assert.equal(entry.data.item.target_address, shortLink);
  const changed = await handler({ action: 'saveActivity', requestId: 'simple-change', id: saved.data.item._id, expectedRevision: 3, input: simpleInput({ activity_info: '新的活动规则需要重新核验。' }) });
  assert.equal(changed.data.item.direct_open_enabled, false);
  assert.equal((await handler({ action: 'entry', id: saved.data.item._id })).error.code, 'NOT_EXECUTABLE');
});

test('目标地址和日期按入口/期限校验，拒绝损坏短链及错误期限', async () => {
  const { handler } = setup(adminSeed({ platforms: [platform] }));
  for (const extra of [
    { target_address: 'https://example.com' }, { target_address: '#小程序://名称/' },
    { entry_type: 'web', target_address: 'http://example.com' },
    { end_at: '2026-11-01T23:59:59+08:00' },
    { validity_type: 'fixed', start_at: '2026-11-02T00:00:00+08:00', end_at: '2026-11-01T23:59:59+08:00' },
  ]) {
    const result = await handler({ action: 'saveActivity', requestId: 'invalid', input: simpleInput(extra) });
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(extra));
  }
});

test('图片只允许管理员上传，校验文件内容，保存图文步骤并刷新临时链接', async () => {
  const fileId = 'cloud://test/activity-steps/example.png';
  let uploads = 0;
  const media = { uploadImage: async () => { uploads++; return fileId; }, getImageUrls: async (files) => Object.fromEntries(files.map((file) => [file, 'https://example.com/temporary.png'])) };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
  const guest = setup({ users: [user] }, media);
  assert.equal((await guest.handler({ action: 'uploadStepImage', base64: png })).error.code, 'FORBIDDEN');
  assert.equal(uploads, 0);
  const { handler, tables } = setup(adminSeed({ platforms: [platform] }), media);
  assert.equal((await handler({ action: 'uploadStepImage', base64: Buffer.from('not an image').toString('base64') })).error.code, 'UNSUPPORTED_IMAGE_FORMAT');
  const uploaded = await handler({ action: 'uploadStepImage', base64: png });
  assert.equal(uploaded.data.fileId, fileId);
  assert.equal(tables.catalog_images.size, 1);
  const saved = await handler({ action: 'saveActivity', requestId: 'image-save', input: simpleInput({ participation_steps: [{ text: '按图片找到签到入口，进入活动完成每日签到', images: [fileId] }] }) });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.deepEqual(saved.data.item.participation_steps[0].images, [fileId]);
  assert.equal(saved.data.item.participation_steps[0].image_urls, undefined);
  const detail = await handler({ action: 'adminDetail', id: saved.data.item._id });
  assert.deepEqual(detail.data.item.participation_steps[0].image_urls, [uploaded.data.url]);
});

test('拒绝跨来源图片和超量图文，不允许客户端注入任意云文件或临时 URL', async () => {
  const { handler } = setup(adminSeed({ platforms: [platform] }));
  for (const steps of [
    [{ text: '参与步骤文字', images: ['https://example.com/image.png'] }],
    [{ text: '参与步骤文字', images: ['cloud://unknown/private-file'] }],
    [{ text: '参与步骤文字', images: Array(4).fill('cloud://test/image') }],
    Array(21).fill({ text: '步骤', images: [] }),
    [{ text: '字'.repeat(2001), images: [] }],
  ]) {
    const result = await handler({ action: 'saveActivity', requestId: 'bad-image', input: simpleInput({ participation_steps: steps }) });
    assert.equal(result.error.code, 'INVALID_INPUT');
  }
});

test('平台停用/活动暂停/核验过期后，不返回图文和小程序直达配置', async () => {
  for (const extra of [{ publication_status: 'paused' }, { next_verify_at: new Date('2026-10-28') }, { platformDisabled: true }]) {
    const item = activity({ target_address: shortLink, entry_type: 'mini_program', direct_open_enabled: true,
      participation_steps: [{ text: '说明', images: ['cloud://private/image'] }], ...extra });
    const { handler } = setup({ users: [user], platforms: [{ ...platform, status: extra.platformDisabled ? 'disabled' : 'enabled' }], activities: [item] });
    const result = await handler({ action: 'detail', id: item._id });
    assert.deepEqual(result.data.item.participation_steps, []);
    assert.equal(result.data.item.target_address, '');
    assert.equal(result.data.item.direct_open_enabled, false);
    assert.equal((await handler({ action: 'entry', id: item._id })).error.code, 'NOT_EXECUTABLE');
  }
});

test('未登记真机跳转验证不会启用直达；图片链接故障不阻止文字详情展示', async () => {
  const { handler } = setup(adminSeed({ platforms: [platform] }));
  const saved = await handler({ action: 'saveActivity', requestId: 'no-tested-save', input: simpleInput() });
  const verified = await handler({ action: 'verifyActivity', requestId: 'no-tested-verify', id: saved.data.item._id, expectedRevision: 1, evidence: '仅核实活动内容，尚未在真机验证小程序跳转。' });
  assert.equal(verified.data.item.direct_open_enabled, false);
  const item = activity({ participation_steps: [{ text: '依照这些文字步骤参加活动', images: ['cloud://test/image'] }] });
  const unavailable = setup({ users: [user], platforms: [platform], activities: [item] }, { getImageUrls: async () => { throw new Error('storage unavailable'); } });
  const result = await unavailable.handler({ action: 'detail', id: item._id });
  assert.equal(result.ok, true);
  assert.equal(result.data.item.participation_steps[0].text, '依照这些文字步骤参加活动');
  assert.deepEqual(result.data.item.participation_steps[0].image_urls, ['']);
});

test('图片登记失败会回收刚上传的文件；超大图片不能触发上传', async () => {
  let uploads = 0;
  const deleted = [];
  const { handler } = setup(adminSeed(), {
    uploadImage: async () => { uploads++; return 'cloud://test/new-image'; },
    deleteImage: async (file) => deleted.push(file), getImageUrls: async () => ({}),
  });
  assert.equal((await handler({ action: 'uploadStepImage', base64: 'a'.repeat(1400004) })).error.code, 'INVALID_INPUT');
  assert.equal(uploads, 0);
  const result = await handler({ action: 'uploadStepImage', base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') });
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  assert.deepEqual(deleted, ['cloud://test/new-image']);
});

test('原始 HEIC 返回明确格式错误，不尝试上传不受支持的文件', async () => {
  let uploads = 0;
  const { handler } = setup(adminSeed(), { uploadImage: async () => { uploads++; }, getImageUrls: async () => ({}) });
  const result = await handler({ action: 'uploadStepImage', base64: Buffer.from('\0\0\0\x18ftypheic\0\0\0\0heicmif1', 'binary').toString('base64') });
  assert.equal(result.error.code, 'UNSUPPORTED_IMAGE_FORMAT');
  assert.match(result.error.message, /HEIC\/HEIF.*JPG\/PNG/);
  assert.equal(uploads, 0);
});
