const { initializeCloud } = require('./services/cloud');
const { ensureIdentity } = require('./services/identity');

App({
  globalData: {
    cloudStatus: 'unconfigured',
    runtimeEnv: 'unknown',
  },

  onLaunch() {
    this.globalData.cloudStatus = initializeCloud().status;
    // 云开发调用上下文识别当前微信账号；不弹窗索取头像或昵称。
    this.identityReady = ensureIdentity().catch(() => null);

    try {
      this.globalData.runtimeEnv = wx.getAccountInfoSync().miniProgram.envVersion;
    } catch (error) {
      console.warn('无法读取当前运行版本', error);
    }
  },
});
