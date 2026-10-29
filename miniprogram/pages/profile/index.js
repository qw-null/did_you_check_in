const { getCachedUser, getPersonalSummary, saveProfile } = require('../../services/identity');
const { createLoginPage } = require('../../services/login-page');

function readAvatar(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path, encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(new Error('头像读取失败，请重新选择')),
    });
  });
}

Page(createLoginPage({
  data: {
    summary: null, summaryLoading: false, summaryError: '', shortUserId: '',
    editorOpen: false, draftName: '', draftAvatar: '', profileSaving: false, profileError: '',
  },

  async onAuthenticated(user) {
    this.setData({ shortUserId: `${user.id.slice(0, 8)}…${user.id.slice(-6)}` });
    return this.onRefreshSummary();
  },

  async onRefreshSummary() {
    if (!this.data.authenticated || this.data.summaryLoading) return;
    const version = this._loginVersion;
    this.setData({ summary: null, summaryLoading: true, summaryError: '' });
    try {
      const data = await getPersonalSummary();
      if (!this._visible || version !== this._loginVersion) return;
      const summary = data.summary;
      if (!summary || !['joined', 'browsed', 'completed'].every((key) => Number.isInteger(summary[key]) && summary[key] >= 0)) {
        throw new Error('统计暂不可用，请稍后重试');
      }
      this.setData({ summary });
    } catch (error) {
      if (this._visible && version === this._loginVersion) this.setData({ summaryError: '统计加载失败，请重试' });
    } finally {
      if (this._visible && version === this._loginVersion) this.setData({ summaryLoading: false });
    }
  },

  onEditProfile() {
    if (!this.data.authenticated || this.data.profileSaving) return;
    this.setData({ editorOpen: true, draftName: this.data.user.displayName, draftAvatar: '', profileError: '' });
  },

  onCloseEditor() {
    if (!this.data.profileSaving) this.setData({ editorOpen: false });
  },

  onStopPropagation() {},

  onChooseAvatar(event) {
    if (!this.data.profileSaving) this.setData({ draftAvatar: event.detail.avatarUrl, profileError: '' });
  },

  async onSaveProfile(event) {
    if (!this.data.authenticated || this.data.profileSaving) return;
    const displayName = (event.detail.value.nickname || '').trim();
    if (!displayName || Array.from(displayName).length > 24) {
      this.setData({ profileError: '请输入 1–24 个字的昵称' });
      return;
    }
    const version = this._loginVersion;
    this.setData({ profileSaving: true, profileError: '' });
    try {
      const profile = { displayName };
      if (this.data.draftAvatar) {
        profile.avatarBase64 = await readAvatar(this.data.draftAvatar);
        if (profile.avatarBase64.length > 1398104) throw new Error('头像不能超过 1MB，请选择较小的图片');
      }
      if (!this._visible || version !== this._loginVersion) return;
      await saveProfile(profile);
      if (!this._visible || version !== this._loginVersion) return;
      this.setData({ editorOpen: false, draftAvatar: '' });
      wx.showToast({ title: '资料已保存', icon: 'success' });
    } catch (error) {
      if (this._visible && version === this._loginVersion) this.setData({ profileError: error.message });
    } finally {
      if (this._visible && version === this._loginVersion) this.setData({ profileSaving: false });
    }
  },

  onCopyUserId() {
    const user = getCachedUser();
    if (this.data.authenticated && user) wx.setClipboardData({ data: user.id });
  },

  onOpenAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },
  onOpenHistory() { if (this.data.authenticated) wx.navigateTo({ url: '/pages/checkin-history/index' }); },

  onHide() {
    this.setData({ summary: null, summaryLoading: false, editorOpen: false, profileSaving: false });
  },
}));
