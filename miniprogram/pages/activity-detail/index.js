const { createLoginPage } = require('../../services/login-page');
const { callCatalog, displayDate } = require('../../services/catalog');
const { writePersonal, confirmCompletion } = require('../../services/checkins');

Page(createLoginPage({
  data: { item: null, pageLoading: false, error: '', copied: false, opening: false, entryMessage: '', working: false, businessDate: '', personalMessage: '' },

  onLoad(query) { this._activityId = query.id || ''; },

  async onAuthenticated() {
    if (!this._activityId) { this.setData({ error: '活动标识无效' }); return; }
    const version = this._loginVersion;
    this.setData({ pageLoading: true, error: '', item: null, entryMessage: '', copied: false });
    try {
      const result = await callCatalog('detail', { id: this._activityId });
      if (!this._visible || version !== this._loginVersion) return;
      this.setData({ item: {
        ...result.item,
        last_verified_at: displayDate(result.item.last_verified_at),
        start_at: displayDate(result.item.start_at),
        end_at: displayDate(result.item.end_at),
      }, businessDate: result.businessDate });
      if (!result.item.restricted) {
        callCatalog('recordView', { id: this._activityId }).catch(() => {});
      }
    } catch (error) {
      if (this._visible && version === this._loginVersion) this.setData({ error: error.message });
    } finally {
      if (this._visible && version === this._loginVersion) this.setData({ pageLoading: false });
    }
  },

  async onJoinActivity() {
    if (!this.data.authenticated || !this.data.item || !this.data.item.executable || this.data.working) return;
    const version = this._loginVersion;
    const userId = this.data.user.id;
    this.setData({ working: true, personalMessage: '' });
    try {
      await writePersonal(userId, 'joinActivity', this._activityId);
      if (!this._visible || version !== this._loginVersion) return;
      await this.onAuthenticated();
      if (this._visible && version === this._loginVersion) this.setData({ personalMessage: '已加入我的打卡' });
    } catch (error) {
      if (!this._visible || version !== this._loginVersion) return;
      if (error.code === 'NOT_EXECUTABLE') await this.onAuthenticated();
      if (this._visible && version === this._loginVersion) this.setData({ personalMessage: error.message });
    } finally { if (this._visible && version === this._loginVersion) this.setData({ working: false }); }
  },

  async onComplete() {
    if (!this.data.authenticated || !this.data.item || !this.data.item.personal || !this.data.item.personal.can_complete || this.data.working) return;
    const version = this._loginVersion;
    const date = this.data.businessDate;
    const userId = this.data.user.id;
    this.setData({ working: true, personalMessage: '' });
    try {
      if (!await confirmCompletion(date) || !this._visible || version !== this._loginVersion) return;
      const result = await writePersonal(userId, 'completeCheckin', this._activityId, date);
      if (!this._visible || version !== this._loginVersion) return;
      await this.onAuthenticated();
      if (this._visible && version === this._loginVersion) this.setData({ personalMessage: `已记录 ${result.record.checkin_date} 的手动确认` });
    } catch (error) {
      if (!this._visible || version !== this._loginVersion) return;
      if (['DATE_CHANGED', 'NOT_EXECUTABLE', 'NOT_JOINED'].includes(error.code)) await this.onAuthenticated();
      if (this._visible && version === this._loginVersion) this.setData({ personalMessage: error.message });
    } finally { if (this._visible && version === this._loginVersion) this.setData({ working: false }); }
  },

  onOpenCheckins() { wx.switchTab({ url: '/pages/checkins/index' }); },

  onPreviewImage(event) {
    const item = this.data.item;
    if (!this._visible || !item || item.restricted || !Array.isArray(item.participation_steps)) return;
    const urls = [];
    item.participation_steps.forEach((step) => {
      (Array.isArray(step.image_urls) ? step.image_urls : []).forEach((url) => {
        if (typeof url === 'string' && url.trim() && !urls.includes(url)) urls.push(url);
      });
    });
    const current = event.currentTarget.dataset.url;
    if (!urls.includes(current)) return;
    const version = this._loginVersion;
    wx.previewImage({ current, urls, fail: () => {
      if (this._visible && version === this._loginVersion) wx.showToast({ title: '图片预览失败，请刷新详情后重试', icon: 'none' });
    } });
  },

  async onOpenEntry() {
    if (!this.data.item || !this.data.item.executable || this.data.opening) return;
    const version = this._loginVersion;
    this.setData({ opening: true, entryMessage: '' });
    try {
      const { item } = await callCatalog('entry', { id: this._activityId });
      if (!this._visible || version !== this._loginVersion) return;
      if (item.entry_type !== 'mini_program' || !item.direct_open_enabled) throw new Error('入口已变更，请刷新活动详情');
      if (typeof wx.navigateToMiniProgram !== 'function' || (item.target_address && wx.canIUse && !wx.canIUse('navigateToMiniProgram.object.shortLink'))) {
        throw new Error('当前微信版本不支持此链接，请更新微信或复制入口');
      }
      await new Promise((resolve, reject) => wx.navigateToMiniProgram({
        ...(item.target_address ? { shortLink: item.target_address } : { appId: item.target_app_id, path: item.target_page_path || '' }),
        envVersion: 'release', success: resolve, fail: reject,
      }));
    } catch (error) {
      if (this._visible && version === this._loginVersion) this.setData({ entryMessage: /cancel/i.test(error.errMsg || '') ? '已取消打开' : error.message || '打开失败，可复制入口或按下方步骤参与' });
    } finally { if (this._visible && version === this._loginVersion) this.setData({ opening: false }); }
  },

  async onCopyEntry() {
    if (!this.data.item || !this.data.item.executable) return;
    const version = this._loginVersion;
    try {
      const { item } = await callCatalog('entry', { id: this._activityId });
      if (!this._visible || version !== this._loginVersion) return;
      const value = item.target_address || item.entry_url || item.search_keyword || item.participation_steps.map((step) => step.text).join('\n');
      if (!value) return;
      wx.setClipboardData({ data: value, success: () => {
        if (this._visible && version === this._loginVersion) this.setData({ copied: true });
      }, fail: () => this.setData({ entryMessage: '复制失败，请重试' }) });
    } catch (error) {
      if (this._visible && version === this._loginVersion) this.setData({ entryMessage: error.message });
    }
  },

  onHide() {
    this.setData({ item: null, pageLoading: false, opening: false, working: false, personalMessage: '' });
  },
}));
