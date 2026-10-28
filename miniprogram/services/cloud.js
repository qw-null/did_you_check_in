const cloudConfig = require('../config/cloud');

/**
 * 这里只初始化客户端 SDK，不代表已经连接数据库、登录或部署云函数。
 * 缺少 EnvID 时允许浏览页面骨架，不调用未配置的云环境。
 * @returns {{status: 'unconfigured'|'unsupported'|'initialized'|'failed'}}
 */
function initializeCloud() {
  if (!cloudConfig.envId.trim()) {
    return { status: 'unconfigured' };
  }

  if (!wx.cloud || typeof wx.cloud.init !== 'function') {
    return { status: 'unsupported' };
  }

  try {
    wx.cloud.init({ env: cloudConfig.envId.trim() });
    return { status: 'initialized' };
  } catch (error) {
    console.error('云开发客户端初始化失败', error);
    return { status: 'failed' };
  }
}

module.exports = { initializeCloud };
