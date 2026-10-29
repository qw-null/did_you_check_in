const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function service(callFunction) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/catalog.js'), 'utf8'), {
    module, exports: module.exports, console: { error() {} },
    wx: { cloud: { callFunction } },
    require: (name) => name === './identity' ? { ensureIdentity: async () => {} } : { envId: 'test-environment' },
  });
  return module.exports;
}

test('图片上传网络与超时错误不再误报未部署，保留安全错误码', async () => {
  for (const [errMsg, expected] of [['network offline', /网络连接失败/], ['request timeout', /图片上传超时/], ['Function execution failed', /图片上传调用失败/]]) {
    const catalog = service(async () => { throw { errCode: -504003, errMsg }; });
    await assert.rejects(catalog.callCatalog('uploadStepImage', { base64: 'private-data' }), (error) => {
      assert.match(error.message, expected);
      assert.match(error.message, /-504003/);
      assert.doesNotMatch(error.message, /未部署|是否已部署|private-data/);
      assert.equal(error.code, 'CLOUD_CALL_FAILED');
      return true;
    });
  }
});

test('仅明确不存在函数时提示重新部署；服务端格式错误明确说明 HEIC 转换', async () => {
  const absent = service(async () => { throw { errCode: -501000, errMsg: 'FUNCTION_NOT_FOUND' }; });
  await assert.rejects(absent.callCatalog('list'), /云函数不存在/);
  const format = service(async () => ({ result: { ok: false, error: { code: 'UNSUPPORTED_IMAGE_FORMAT' } } }));
  await assert.rejects(format.callCatalog('uploadStepImage'), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_IMAGE_FORMAT');
    assert.match(error.message, /HEIC\/HEIF.*JPG\/PNG/);
    return true;
  });
});
