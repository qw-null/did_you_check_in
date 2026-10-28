const cloudConfig = require('../config/cloud');

let cachedUser = null;
let loginRequest = null;

function clearIdentity() {
  cachedUser = null;
}

function getCachedUser() {
  return cachedUser;
}

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function callIdentity(action) {
  if (!cloudConfig.envId.trim()) {
    throw identityError('CLOUD_UNCONFIGURED', '请先配置云环境');
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    throw identityError('CLOUD_UNSUPPORTED', '当前微信版本暂不支持云开发');
  }

  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'identity', data: { action } });
  } catch (error) {
    // 网络失败不能等同于无权限，不返回服务端原始堆栈。
    throw identityError('CLOUD_CALL_FAILED', '身份服务调用失败，请检查网络及 identity 云函数是否已部署');
  }

  const result = response.result;
  if (!result || result.ok !== true || !result.data) {
    const code = result && result.error && result.error.code;
    const known = {
      LOGIN_REQUIRED: '请先建立微信身份',
      ACCOUNT_RESTRICTED: '当前账号不可使用，请联系项目支持',
      IDENTITY_UNAVAILABLE: '无法核实当前微信身份，请重试',
      FORBIDDEN: '当前账号没有管理权限',
      BACKEND_UNAVAILABLE: '身份服务暂不可用，请检查云函数和数据库配置',
    };
    if (code === 'LOGIN_REQUIRED' || code === 'ACCOUNT_RESTRICTED' || code === 'IDENTITY_UNAVAILABLE') clearIdentity();
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

  cachedUser = user;
  return result.data;
}

function restoreIdentity() {
  return callIdentity('current');
}

function ensureIdentity() {
  if (cachedUser) return Promise.resolve(cachedUser);
  if (loginRequest) return loginRequest;

  loginRequest = new Promise((resolve, reject) => {
    wx.showModal({
      title: '建立微信身份',
      content: '用于同步清单与记录，或验证管理员身份。不申请手机号、头像或昵称。是否继续？',
      confirmText: '继续',
      success: (result) => {
        if (!result.confirm) {
          reject(identityError('CANCELLED', '已取消建立身份'));
          return;
        }
        callIdentity('login').then((data) => resolve(data.user), reject);
      },
      fail: () => reject(identityError('CANCELLED', '身份确认未完成，请重试')),
    });
  }).finally(() => { loginRequest = null; });

  return loginRequest;
}

async function verifyAdministrator() {
  await ensureIdentity();
  return callIdentity('checkAdmin');
}

module.exports = { getCachedUser, clearIdentity, restoreIdentity, ensureIdentity, verifyAdministrator };
