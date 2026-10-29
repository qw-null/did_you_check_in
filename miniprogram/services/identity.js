const cloudConfig = require('../config/cloud');

let cachedUser = null;
let loginRequest = null;
let identityVersion = 0;
const listeners = new Set();

function setUser(user) {
  cachedUser = user;
  for (const listener of listeners) listener(user);
}

function clearIdentity() {
  identityVersion += 1;
  setUser(null);
}

function subscribeIdentity(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getCachedUser() {
  return cachedUser;
}

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function callIdentity(action, payload = {}) {
  const version = identityVersion;
  if (!cloudConfig.envId.trim()) {
    throw identityError('CLOUD_UNCONFIGURED', '请先配置云环境');
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    throw identityError('CLOUD_UNSUPPORTED', '当前微信版本暂不支持云开发');
  }

  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'identity', data: { ...payload, action } });
  } catch (error) {
    // 网络失败不能等同于无权限，不返回服务端原始堆栈。
    throw identityError('CLOUD_CALL_FAILED', '身份服务调用失败，请检查网络及 identity 云函数是否已部署');
  }

  const result = response.result;
  if (version !== identityVersion) {
    throw identityError('IDENTITY_CHANGED', '登录状态已变化，请重试');
  }
  if (!result || result.ok !== true || !result.data) {
    const code = result && result.error && result.error.code;
    const known = {
      LOGIN_REQUIRED: '请先登录',
      ACCOUNT_RESTRICTED: '当前账号不可使用，请联系项目支持',
      IDENTITY_UNAVAILABLE: '无法核实当前微信身份，请重试',
      FORBIDDEN: '当前账号没有管理权限',
      BACKEND_UNAVAILABLE: '身份服务暂不可用，请检查云函数和数据库配置',
      INVALID_PROFILE: '昵称需为 1–24 个字，头像请选择不超过 1MB 的 JPG、PNG 或 WebP 图片',
    };
    if (action === 'login' || action === 'current' || code === 'LOGIN_REQUIRED' || code === 'ACCOUNT_RESTRICTED' || code === 'IDENTITY_UNAVAILABLE') clearIdentity();
    throw identityError(known[code] ? code : 'INVALID_RESPONSE', known[code] || '身份服务返回异常，请稍后重试');
  }

  const user = result.data.user;
  if (user !== null && (!user || typeof user.id !== 'string' || !user.id)) {
    throw identityError('INVALID_RESPONSE', '身份服务返回异常，请稍后重试');
  }
  if (action !== 'current' && !user) {
    throw identityError('INVALID_RESPONSE', '身份服务未返回有效用户');
  }
  if (action === 'checkAdmin' && (!result.data.admin || result.data.admin.role !== 'admin')) {
    throw identityError('INVALID_RESPONSE', '管理员核验结果无效');
  }

  // 统计请求不更新已保存的个人资料，避免较早的统计响应覆盖刚保存的昵称头像。
  if (action !== 'summary') setUser(user);
  return result.data;
}

function restoreIdentity() {
  return callIdentity('current');
}

function ensureIdentity({ refresh = false } = {}) {
  if (loginRequest) return loginRequest;
  if (cachedUser && !refresh) return Promise.resolve(cachedUser);

  loginRequest = callIdentity('login').then((data) => data.user).catch((error) => {
    clearIdentity();
    throw error;
  }).finally(() => { loginRequest = null; });

  return loginRequest;
}

function getPersonalSummary() {
  return callIdentity('summary');
}

function saveProfile(profile) {
  return callIdentity('saveProfile', profile).then((data) => data.user);
}

async function verifyAdministrator() {
  await ensureIdentity();
  return callIdentity('checkAdmin');
}

module.exports = {
  getCachedUser, clearIdentity, restoreIdentity, ensureIdentity, verifyAdministrator,
  subscribeIdentity, getPersonalSummary, saveProfile,
};
