const { ensureIdentity } = require('./identity');
const cloudConfig = require('../config/cloud');

function callFailure(action, original) {
  const code = String(original.errCode || original.code || 'UNKNOWN');
  const detail = String(original.errMsg || original.message || '');
  const safeCode = /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : 'UNKNOWN';
  const subject = ({ prepareStepImageUpload: '图片上传凭证申请', completeStepImageUpload: '图片云端校验', cancelStepImageUpload: '图片上传清理', uploadStepImage: '图片上传' })[action] || '活动服务';
  let message = `${subject}调用失败，请稍后重试或查看云函数日志`;
  if (/FUNCTION_NOT_FOUND|function.*(?:not found|not exist)|云函数不存在/i.test(detail)) message = 'catalog 云函数不存在，请在当前云环境重新部署';
  else if (/timeout|timed out|超时/i.test(detail)) message = `${subject}超时，请稍后重试`;
  else if (/network|网络|connection|offline/i.test(detail)) message = '网络连接失败，请检查网络后重试';
  else if (/payload.*large|request.*(?:too large|exceed)|请求.*(?:过大|超出)/i.test(detail)) message = '图片自动压缩未满足传输要求，请重新选择图片后重试';
  const error = new Error(`${message}（${safeCode}）`);
  error.code = 'CLOUD_CALL_FAILED';
  error.cloudCode = safeCode;
  return error;
}

async function callCatalog(action, payload = {}) {
  await ensureIdentity();
  if (!cloudConfig.envId.trim() || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    throw new Error('云环境不可用，请检查小程序环境配置');
  }
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'catalog', data: { ...payload, action } });
  } catch (error) {
    console.error('catalog:call_failed', { action, code: String(error.errCode || error.code || 'UNKNOWN'), message: String(error.errMsg || error.message || '').slice(0, 500) });
    throw callFailure(action, error);
  }
  const result = response.result;
  if (!result || result.ok !== true || !result.data) {
    const known = {
      LOGIN_REQUIRED: '请先登录', ACCOUNT_RESTRICTED: '当前账号不可使用', FORBIDDEN: '当前账号没有管理权限',
      NOT_FOUND: '活动或平台不存在', NOT_EXECUTABLE: '活动当前不可参与', CONFLICT: '内容已被其他操作更新，请刷新后重试',
      REQUEST_CONFLICT: '请求标识冲突，请重新操作', CURSOR_EXPIRED: '活动列表已过期，请刷新',
      INVALID_INPUT: result && result.error && result.error.message,
      UNSUPPORTED_IMAGE_FORMAT: '图片格式不支持，HEIC/HEIF 请先转换为 JPG/PNG 后上传',
      INVALID_UPLOAD: '图片上传凭证无效，请重新上传', UPLOAD_EXPIRED: '图片上传凭证已过期，请重新上传',
      DATE_CHANGED: '北京时间日期已变化，请刷新后重新确认', NOT_JOINED: '请先加入活动再标记完成',
    };
    const backend = result && result.error;
    const staleUploadApi = /^(prepare|complete|cancel)StepImageUpload$/.test(action) && backend && backend.code === 'INVALID_INPUT' && backend.message === '不支持的活动操作';
    const error = new Error(staleUploadApi ? '云端仍是旧版图片接口，请重新上传并部署 catalog 云函数' : known[backend && backend.code] || (backend && backend.message) || '活动服务异常，请稍后重试');
    error.code = result && result.error && result.error.code || 'INVALID_RESPONSE';
    throw error;
  }
  return result.data;
}

function requestId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function displayDate(value) {
  if (!value) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

async function mutate(action, payload) {
  return callCatalog(action, { ...payload, requestId: requestId() });
}

module.exports = { callCatalog, mutate, displayDate, requestId };
