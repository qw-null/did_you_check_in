const appConfig = require('../../config/app');
const { verifyAdministrator } = require('../../services/identity');

const CLOUD_LABELS = {
  unconfigured: '待配置云环境',
  unsupported: '当前微信版本暂不支持云开发',
  initialized: '客户端已初始化，云端业务待联调',
  failed: '云开发客户端初始化失败',
};

Page({
  data: {
    appName: appConfig.name,
    description: appConfig.description,
    version: appConfig.version,
    isDevelopment: false,
    cloudLabel: '',
  },

  onShow() {
    this._visibilityVersion = (this._visibilityVersion || 0) + 1;
    this._visible = true;
    const { globalData } = getApp();
    this.setData({
      isDevelopment: globalData.runtimeEnv === 'develop' || globalData.runtimeEnv === 'trial',
      cloudLabel: CLOUD_LABELS[globalData.cloudStatus] || '云环境状态待确认',
    });
    this.resetTapCount();
  },

  onHide() {
    this._visibilityVersion += 1;
    this._visible = false;
    this.resetTapCount();
  },

  onUnload() {
    this._visibilityVersion += 1;
    this._visible = false;
    this.resetTapCount();
  },

  resetTapCount() {
    this._tapStartedAt = 0;
    this._tapCount = 0;
  },

  async onVersionTap() {
    if (this._entryPromptOpen) {
      return;
    }

    const now = Date.now();
    if (!this._tapStartedAt || now - this._tapStartedAt > 3000) {
      this._tapStartedAt = now;
      this._tapCount = 1;
    } else {
      this._tapCount += 1;
    }

    if (this._tapCount < 3) {
      return;
    }

    this.resetTapCount();
    this._entryPromptOpen = true;
    const version = this._visibilityVersion;
    try {
      await verifyAdministrator();
      if (!this._visible || version !== this._visibilityVersion) return;
      wx.navigateTo({ url: '/admin/pages/dashboard/index' });
    } catch (error) {
      if (!this._visible || version !== this._visibilityVersion || error.code === 'CANCELLED') return;
      wx.showModal({ title: '管理员身份核验', content: error.message, showCancel: false });
    } finally {
      this._entryPromptOpen = false;
      this.resetTapCount();
    }
  },
});
