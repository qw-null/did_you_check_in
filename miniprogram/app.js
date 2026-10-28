const { initializeCloud } = require('./services/cloud');

App({
  globalData: {
    cloudStatus: 'unconfigured',
    runtimeEnv: 'unknown',
  },

  onLaunch() {
    this.globalData.cloudStatus = initializeCloud().status;

    try {
      this.globalData.runtimeEnv = wx.getAccountInfoSync().miniProgram.envVersion;
    } catch (error) {
      console.warn('无法读取当前运行版本', error);
    }
  },
});
