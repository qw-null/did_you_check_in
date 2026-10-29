const { verifyAdministrator } = require('../../../services/identity');
const { callCatalog } = require('../../../services/catalog');

Page({
  data: { authorized: false, verifying: true, dashboard: null, dashboardError: '' },

  async onShow() {
    const version = this._verificationVersion = (this._verificationVersion || 0) + 1;
    this._visible = true;
    this.setData({ authorized: false, verifying: true });
    try {
      await verifyAdministrator();
      if (this._visible && version === this._verificationVersion) {
        this.setData({ authorized: true, verifying: false });
        try {
          const dashboard = await callCatalog('dashboard');
          if (this._visible && version === this._verificationVersion) this.setData({ dashboard, dashboardError: '' });
        } catch (error) {
          if (this._visible && version === this._verificationVersion) this.setData({ dashboardError: error.message });
        }
      }
    } catch (error) {
      if (!this._visible || version !== this._verificationVersion) return;
      this.setData({ authorized: false, verifying: false });
      wx.showModal({
        title: '运营工作台',
        content: error.message,
        showCancel: false,
        complete: () => {
          if (!this._visible || version !== this._verificationVersion) return;
          wx.redirectTo({ url: '/pages/about/index' });
        },
      });
    }
  },

  onHide() {
    this._verificationVersion += 1;
    this._visible = false;
    this.setData({ authorized: false });
  },

  onUnload() {
    this._verificationVersion += 1;
    this._visible = false;
  },
  onOpenPlatforms() { wx.navigateTo({ url: '/admin/pages/platforms/index' }); },
  onOpenActivities() { wx.navigateTo({ url: '/admin/pages/activities/index' }); },
});
