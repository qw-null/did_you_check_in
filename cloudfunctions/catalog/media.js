const { fail } = require('./rules');

function readImage(base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('图片内容无效或未完成自动压缩，请重新上传');
  const buffer = Buffer.from(base64, 'base64');
  return readImageBuffer(buffer);
}

function readImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('图片内容为空，请重新上传');
  if (buffer.length > 1024 * 1024) fail('图片未完成自动压缩，请重新上传');
  const extension = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'jpg'
      : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
  if (!extension) fail('图片格式不支持，HEIC/HEIF 请先转换为 JPG/PNG 后上传', 'UNSUPPORTED_IMAGE_FORMAT');
  return { buffer, extension };
}

module.exports = { readImage, readImageBuffer };
