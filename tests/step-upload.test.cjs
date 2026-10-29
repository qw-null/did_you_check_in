const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('实际 Vant 组件在 iPhone 用 chooseMedia、桌面用 chooseImage，并传递压缩参数', async () => {
  for (const platform of ['ios', 'mac']) {
    const calls = [];
    const wx = {
      getSystemInfoSync: () => ({ platform, SDKVersion: '3.17.6' }),
      chooseMedia(options) {
        calls.push('chooseMedia');
        assert.equal(options.sizeType[0], 'compressed');
        options.success({ tempFiles: [{ tempFilePath: '/ios-compressed.jpg', size: 100 }] });
      },
      chooseImage(options) {
        calls.push('chooseImage');
        assert.equal(options.sizeType[0], 'compressed');
        options.success({ tempFiles: [{ path: '/desktop.jpg', size: 100 }] });
      },
    };
    const context = vm.createContext({ wx, setTimeout, clearTimeout });
    const cache = new Map();
    function load(file) {
      if (cache.has(file)) return cache.get(file).exports;
      const module = { exports: {} };
      cache.set(file, module);
      const evaluate = vm.runInContext(`(function(require, module, exports) {${fs.readFileSync(file, 'utf8')}\n})`, context);
      evaluate((name) => load(path.resolve(path.dirname(file), `${name}.js`)), module, module.exports);
      return module.exports;
    }
    const picker = load(path.join(__dirname, '../miniprogram/admin/vendor/vant/uploader/utils.js'));
    const files = await picker.chooseFile({ accept: 'image', multiple: true, maxCount: 3, capture: ['album'], sizeType: ['compressed'] });
    assert.deepEqual(calls, [platform === 'ios' ? 'chooseMedia' : 'chooseImage']);
    assert.equal(files[0].url, platform === 'ios' ? '/ios-compressed.jpg' : '/desktop.jpg');
    assert.equal(files[0].type, 'image');
  }
});

function uploadService(callCatalog, uploadFile) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/admin/services/step-upload.js'), 'utf8'), {
    module, exports: module.exports,
    require: (name) => name.endsWith('/catalog') ? { callCatalog } : { envId: 'test-environment' },
    wx: { cloud: { uploadFile }, uploadFile() { throw new Error('must use wx.cloud.uploadFile'); } }, console: { error() {} },
  });
  return module.exports;
}

test('云存储规则只允许本人暂存文件写入，拒绝正式目录和其他用户文件', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../cloudfunctions/catalog/storage.rules.json'), 'utf8'));
  assert.equal(rules.read, false);
  const scenarios = [
    [{ openid: 'test-user' }, { openid: 'test-user', path: 'activity-step-staging/u_test/file' }, true],
    [{ openid: 'test-user' }, { openid: 'another-user', path: 'activity-step-staging/u_test/file' }, false],
    [{ openid: 'test-user' }, { openid: 'test-user', path: 'activity-steps/u_test/file.jpg' }, false],
    [{ openid: 'test-user' }, { openid: 'test-user', path: 'user-avatars/u_test/file.jpg' }, false],
    [{ openid: 'test-user' }, { openid: 'test-user', path: 'other/activity-step-staging/file' }, false],
    [null, { openid: 'test-user', path: 'activity-step-staging/u_test/file' }, false],
  ];
  for (const [auth, resource, expected] of scenarios) assert.equal(vm.runInNewContext(rules.write, { auth, resource }), expected);
});

test('文件通过云存储原生接口上传到指定环境，无需业务域名或整图云函数请求', async () => {
  const actions = [], progress = [];
  const service = uploadService(async (action, payload) => {
    actions.push(action);
    if (action === 'prepareStepImageUpload') {
      assert.equal(payload, undefined);
      return { uploadId: 'upload_test', cloudPath: 'activity-step-staging/user/test' };
    }
    assert.equal(payload.uploadId, 'upload_test');
    assert.equal(payload.fileId, 'cloud://test/activity-step-staging/user/test');
    assert.equal(payload.base64, undefined);
    return { fileId: 'cloud://test/final', url: 'https://storage.example.com/final' };
  }, async (options) => {
    assert.equal(options.cloudPath, 'activity-step-staging/user/test');
    assert.equal(options.config.env, 'test-environment');
    assert.equal(options.filePath, '/compressed.jpg');
    assert.equal(options.url, undefined);
    assert.equal(options.formData, undefined);
    return { fileID: 'cloud://test/activity-step-staging/user/test' };
  });
  const result = await service.uploadStepFile('/compressed.jpg', (value) => progress.push(value));
  assert.equal(result.fileId, 'cloud://test/final');
  assert.deepEqual(actions, ['prepareStepImageUpload', 'completeStepImageUpload']);
  assert.deepEqual(progress, ['申请上传', '上传中', '校验中']);
});

test('云存储权限、超时和未知错误分别提示并撤销暂存上传', async () => {
  for (const [failure, expected] of [
    [{ errMsg: 'cloud.uploadFile:fail permission denied' }, /云存储安全规则/],
    [{ errMsg: 'cloud.uploadFile:fail timeout' }, /云存储上传超时/],
    [{ errCode: -1, errMsg: 'cloud.uploadFile:fail' }, /云存储上传失败.*-1/],
  ]) {
    const actions = [];
    const service = uploadService(async (action) => {
      actions.push(action);
      return { uploadId: 'upload_test', cloudPath: 'activity-step-staging/user/test' };
    }, async () => { throw failure; });
    await assert.rejects(service.uploadStepFile('/compressed.jpg'), expected);
    assert.deepEqual(actions, ['prepareStepImageUpload', 'cancelStepImageUpload']);
  }
});

test('校验失败和撤销异常时保留原始错误，不伪装成格式成功', async () => {
  const service = uploadService(async (action) => {
    if (action === 'prepareStepImageUpload') return { uploadId: 'upload_test', cloudPath: 'activity-step-staging/user/test' };
    throw new Error(action === 'completeStepImageUpload' ? '图片格式不支持' : 'cancel failed');
  }, async () => ({ fileID: 'cloud://test/activity-step-staging/user/test' }));
  await assert.rejects(service.uploadStepFile('/compressed.jpg'), /图片格式不支持/);
});

test('云环境不匹配时不登记图片，旧版接口明确提示重新部署', async () => {
  for (const ticket of [
    { uploadId: 'upload_test', cloudPath: 'activity-step-staging/user/test' },
    { uploadId: 'upload_test', url: 'https://legacy.example.com', formData: {} },
  ]) {
    const actions = [];
    const service = uploadService(async (action) => { actions.push(action); return ticket; }, async () => ({ fileID: 'cloud://another-environment/staging' }));
    await assert.rejects(service.uploadStepFile('/compressed.jpg'), ticket.cloudPath ? /环境或文件标识不匹配/ : /重新上传并部署/);
    assert.deepEqual(actions, ['prepareStepImageUpload', 'cancelStepImageUpload']);
  }
});
