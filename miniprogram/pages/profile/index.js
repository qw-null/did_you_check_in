const { getCachedUser, restoreIdentity, ensureIdentity, clearIdentity } = require('../../services/identity');

Page({
  data: {
    userId: '',
    identityLoading: false,
    identityError: '',
  },

  async onShow() {
    this.setData({ userId: (getCachedUser() || {}).id || '', identityLoading: true, identityError: '' });
    try {
      const data = await restoreIdentity();
      this.setData({ userId: data.user ? data.user.id : '' });
    } catch (error) {
      clearIdentity();
      this.setData({ userId: '', identityError: error.message });
    } finally {
      this.setData({ identityLoading: false });
    }
  },

  async onLogin() {
    if (this.data.identityLoading) return;
    this.setData({ identityLoading: true, identityError: '' });
    try {
      const user = await ensureIdentity();
      this.setData({ userId: user.id });
    } catch (error) {
      if (error.code !== 'CANCELLED') this.setData({ identityError: error.message });
    } finally {
      this.setData({ identityLoading: false });
    }
  },

  onCopyUserId() {
    if (this.data.userId) wx.setClipboardData({ data: this.data.userId });
  },

  onOpenAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },
});
