const TARGET_IMAGE_BYTES = 900 * 1024;
const COMPRESSION_PASSES = [
  { edge: 2560, quality: 0.85 }, { edge: 2560, quality: 0.68 }, { edge: 2560, quality: 0.5 },
  { edge: 2048, quality: 0.6 }, { edge: 1600, quality: 0.5 }, { edge: 1280, quality: 0.4 },
  { edge: 1024, quality: 0.3 }, { edge: 768, quality: 0.25 }, { edge: 512, quality: 0.2 },
];

function supported(buffer) {
  const bytes = new Uint8Array(buffer);
  return (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    || (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
      && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP');
}

function removeTemp(filePath) {
  const manager = wx.getFileSystemManager();
  if (typeof manager.unlink === 'function') manager.unlink({ filePath, fail() {} });
}

async function compressedSize(filePath) {
  const size = await new Promise((resolve, reject) => wx.getFileSystemManager().stat({
    path: filePath, success: (result) => resolve(result.stats.size), fail: reject,
  }));
  // 仅检查压缩成品，文件上传不需要把图片读入 Base64。
  if (size > TARGET_IMAGE_BYTES) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  const buffer = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath, position: 0, length: Math.min(12, size), success: (result) => resolve(result.data), fail: reject,
  }));
  return supported(buffer) ? size : null;
}

function findCanvas(page) {
  return new Promise((resolve, reject) => {
    if (typeof wx.createSelectorQuery !== 'function') { reject(new Error('图片转换组件不可用，请更新微信或改用 JPG/PNG 图片')); return; }
    wx.createSelectorQuery().in(page).select('#step-image-canvas').fields({ node: true }).exec((results) => {
      const canvas = results && results[0] && results[0].node;
      if (!canvas) reject(new Error('图片转换组件不可用，请更新微信或改用 JPG/PNG 图片'));
      else resolve(canvas);
    });
  });
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    const timer = setTimeout(() => reject(new Error('图片解码超时，请改用 JPG/PNG 图片')), 15000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('当前微信无法解码此图片；HEIC/HEIF 请先转换为 JPG/PNG 后上传')); };
    try { image.src = src; } catch (_) { clearTimeout(timer); reject(new Error('当前微信无法解码此图片；HEIC/HEIF 请先转换为 JPG/PNG 后上传')); }
  });
}

async function canvasJpeg(page, src) {
  const canvas = await findCanvas(page);
  try {
    const image = await loadCanvasImage(canvas, src);
    if (!image.width || !image.height) throw new Error('图片尺寸无效，请重新选择图片');
    const context = canvas.getContext('2d');
    for (const { edge, quality } of COMPRESSION_PASSES) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas, fileType: 'jpg', quality, destWidth: canvas.width, destHeight: canvas.height,
        success: resolve, fail: reject,
      }));
      try {
        const size = await compressedSize(result.tempFilePath);
        if (size) return { filePath: result.tempFilePath, size };
      } catch (error) {
        removeTemp(result.tempFilePath);
        throw error;
      }
      removeTemp(result.tempFilePath);
    }
    throw new Error('图片自动压缩未完成，请重新选择图片后重试');
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function prepareStepImage(page, filePath) {
  let convertedPath = filePath;
  let output;
  if (typeof wx.compressImage === 'function') {
    try {
      const result = await new Promise((resolve, reject) => wx.compressImage({
        src: filePath, quality: 80, success: resolve, fail: reject,
      }));
      if (typeof result.tempFilePath === 'string' && result.tempFilePath) convertedPath = result.tempFilePath;
    } catch (_) { /* 原生压缩不支持此格式时，由 Canvas 继续处理原图。 */ }
  }
  try {
    if (convertedPath !== filePath) {
      try {
        const size = await compressedSize(convertedPath);
        if (size) output = { filePath: convertedPath, size };
      } catch (_) { /* 原生结果无法读取时，继续由 Canvas 解码转码。 */ }
    }
    if (!output) output = await canvasJpeg(page, convertedPath);
    let cleaned = false;
    return { filePath: output.filePath, size: output.size, cleanup() {
      if (!cleaned && output.filePath !== filePath) removeTemp(output.filePath);
      cleaned = true;
    } };
  } catch (error) {
    if (error instanceof Error && /^(?:图片|当前微信)/.test(error.message)) throw error;
    throw new Error('图片转换失败；HEIC/HEIF 请先转换为 JPG/PNG 后上传');
  } finally {
    if (convertedPath !== filePath && (!output || output.filePath !== convertedPath)) removeTemp(convertedPath);
  }
}

module.exports = { prepareStepImage };
