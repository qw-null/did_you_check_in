const { callCatalog } = require('../../services/catalog');
const cloudConfig = require('../../config/cloud');

function uploadFailure(original) {
  const detail = String(original.errMsg || original.message || '');
  const code = String(original.errCode || original.code || 'UNKNOWN');
  let message = '图片云存储上传失败，请检查网络后重试';
  if (/permission|access.?denied|无权限|权限不足|权限拒绝/i.test(detail)) message = '云存储暂存目录没有上传权限，请按部署指引设置云存储安全规则';
  else if (/timeout|超时/i.test(detail)) message = '图片云存储上传超时，请重试';
  console.error('step-image:storage_failed', { code, stage: 'cloud_upload',
    message: detail.replace(/https?:\/\/\S+/g, '[cloud-url]').replace(/(Signature|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 300),
  });
  const error = new Error(`${message}（${/^[\w-]{1,60}$/.test(code) ? code : 'UNKNOWN'}）`);
  error.code = 'IMAGE_STORAGE_UPLOAD_FAILED';
  return error;
}

async function uploadStepFile(filePath, onProgress = () => {}) {
  let ticket;
  let uploaded;
  try {
    if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') throw new Error('微信云存储不可用，请更新微信后重试');
    onProgress('申请上传');
    ticket = await callCatalog('prepareStepImageUpload');
    if (!ticket.cloudPath) throw new Error('云端仍是旧版图片接口，请重新上传并部署 catalog 云函数');
    onProgress('上传中');
    try {
      uploaded = await wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath, config: { env: cloudConfig.envId } });
    } catch (error) { throw uploadFailure(error); }
    if (!uploaded || typeof uploaded.fileID !== 'string' || !uploaded.fileID.startsWith('cloud://')
      || !uploaded.fileID.endsWith(`/${ticket.cloudPath}`)) throw new Error('图片上传环境或文件标识不匹配，请检查云环境配置');
    onProgress('校验中');
    return await callCatalog('completeStepImageUpload', { uploadId: ticket.uploadId, fileId: uploaded.fileID });
  } catch (error) {
    if (ticket) {
      const fileId = uploaded && typeof uploaded.fileID === 'string' && uploaded.fileID.endsWith(`/${ticket.cloudPath}`) ? uploaded.fileID : '';
      try { await callCatalog('cancelStepImageUpload', { uploadId: ticket.uploadId, fileId }); } catch (_) { /* 保留原始失败，暂存文件由维护任务清理。 */ }
    }
    throw error;
  }
}

module.exports = { uploadStepFile };
