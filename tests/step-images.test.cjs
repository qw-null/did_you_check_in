const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 10, 74, 70, 73, 70, 0, 0]).buffer;
const heic = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]).buffer;

function loadImages(wx) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/admin/services/step-images.js'), 'utf8'), {
    module, exports: module.exports, wx, setTimeout, clearTimeout,
  });
  return module.exports;
}

function device({ native = 'heic', decodeFails = false, sizes = [100], width = 4032, height = 3024 } = {}) {
  const exports = [], reads = [], deleted = [], decoded = [];
  const canvas = { width: 1, height: 1,
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    createImage() {
      const image = { width, height };
      Object.defineProperty(image, 'src', { set(src) {
        decoded.push(src);
        if (decodeFails) image.onerror(); else image.onload();
      } });
      return image;
    },
  };
  const query = { in() { return this; }, select() { return this; }, fields() { return this; }, exec(done) { done([{ node: canvas }]); } };
  const wx = {
    getFileSystemManager: () => ({
      stat(options) {
        assert.notEqual(options.path, '/original.heic', 'never gate the original file size');
        const index = Number((options.path.match(/export-(\d+)/) || [])[1]);
        options.success({ stats: { size: Number.isNaN(index) ? 500 : sizes[Math.min(index, sizes.length - 1)] } });
      },
      readFile(options) {
        reads.push(options.filePath);
        assert.equal(options.encoding, undefined, 'file upload must not read Base64');
        assert.equal(options.position, 0);
        assert(options.length <= 12, 'read the header only');
        options.success({ data: options.filePath === '/native' && native === 'heic' ? heic : jpeg });
      },
      unlink(options) { deleted.push(options.filePath); },
    }),
    compressImage(options) {
      if (native === 'fail') options.fail({ errMsg: 'unsupported' });
      else options.success({ tempFilePath: '/native' });
    },
    createSelectorQuery: () => query,
    canvasToTempFilePath(options) {
      assert.equal(options.fileType, 'jpg');
      const tempFilePath = `/export-${exports.length}.jpg`;
      exports.push({ width: options.destWidth, height: options.destHeight, quality: options.quality });
      options.success({ tempFilePath });
    },
  };
  return { wx, canvas, exports, reads, deleted, decoded };
}

test('iPhone 原生压缩已生成合规图片时直接上传文件，避免再次 Canvas 解码', async () => {
  const state = device({ native: 'jpeg' });
  const image = await loadImages(state.wx).prepareStepImage({}, '/original.heic');
  assert.equal(image.filePath, '/native');
  assert.equal(state.exports.length, 0);
  assert.deepEqual(state.reads, ['/native']);
  assert.deepEqual(state.deleted, []);
  image.cleanup(); image.cleanup();
  assert.deepEqual(state.deleted, ['/native']);
});

test('原生压缩仍是 HEIC 时通过真实文件头识别并回退 Canvas JPEG', async () => {
  const state = device();
  const image = await loadImages(state.wx).prepareStepImage({}, '/original.heic');
  assert.equal(image.filePath, '/export-0.jpg');
  assert.deepEqual(state.decoded, ['/native']);
  assert.deepEqual(state.exports[0], { width: 2560, height: 1920, quality: 0.85 });
  assert.equal(state.canvas.width, 1);
  assert.deepEqual(state.deleted, ['/native']);
  image.cleanup();
  assert.deepEqual(state.deleted, ['/native', '/export-0.jpg']);
});

test('原生失败后可处理原图，小图片也经过转码且不放大', async () => {
  const state = device({ native: 'fail', width: 160, height: 90 });
  const image = await loadImages(state.wx).prepareStepImage({}, '/original.heic');
  assert.deepEqual(state.decoded, ['/original.heic']);
  assert.deepEqual(state.exports, [{ width: 160, height: 90, quality: 0.85 }]);
  assert(!state.reads.includes('/original.heic'));
  image.cleanup();
  assert(!state.deleted.includes('/original.heic'));
});

test('大图先降低质量再降采样，超目标成品不读取文件内容', async () => {
  const state = device({ sizes: [2000000, 1800000, 1500000, 800000] });
  const image = await loadImages(state.wx).prepareStepImage({}, '/original.heic');
  assert.equal(state.exports.length, 4);
  assert.deepEqual(state.exports.slice(0, 3).map((item) => item.width), [2560, 2560, 2560]);
  assert.deepEqual(state.exports.slice(0, 3).map((item) => item.quality), [0.85, 0.68, 0.5]);
  assert.equal(state.exports[3].width, 2048);
  assert.deepEqual(state.reads, ['/native', '/export-3.jpg']);
  assert(!state.deleted.includes(image.filePath));
  image.cleanup();
  assert.equal(state.deleted.length, 5);
});

test('三次后继续压缩，始终不读原图、不要求用户手动裁剪', async () => {
  const state = device({ sizes: [2000000, 1900000, 1800000, 1600000, 1400000, 1100000, 950000, 700000] });
  const image = await loadImages(state.wx).prepareStepImage({}, '/original.heic');
  assert.equal(state.exports.length, 8);
  assert.equal(state.exports.at(-1).width, 768);
  image.cleanup();
});

test('解码失败保留格式提示并释放 Canvas 和原生中间文件', async () => {
  const state = device({ decodeFails: true });
  await assert.rejects(loadImages(state.wx).prepareStepImage({}, '/original.heic'), /HEIC\/HEIF.*JPG\/PNG/);
  assert.equal(state.canvas.width, 1);
  assert.deepEqual(state.deleted, ['/native']);
});

test('持续超目标时有限重试，删除所有失败成品', async () => {
  const state = device({ sizes: [2000000] });
  await assert.rejects(loadImages(state.wx).prepareStepImage({}, '/original.heic'), /自动压缩未完成/);
  assert.equal(state.exports.length, 9);
  assert.equal(state.deleted.length, 10);
  assert(!state.deleted.includes('/original.heic'));
});
