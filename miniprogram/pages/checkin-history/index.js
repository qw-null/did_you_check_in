const { createLoginPage } = require('../../services/login-page');
const { callCatalog } = require('../../services/catalog');
const { displayTime } = require('../../services/checkins');

Page(createLoginPage({
  data: { items: [], cursor: '', loading: false, error: '', loaded: false },
  onAuthenticated() { return this.loadHistory(true); },
  async loadHistory(reset = true) {
    if (!this.data.authenticated || (this.data.loading && !reset)) return;
    const version = this._version = (this._version || 0) + 1;
    const loginVersion = this._loginVersion;
    this.setData({ loading: true, error: '', ...(reset ? { items: [], cursor: '', loaded: false } : {}) });
    try {
      const result = await callCatalog('checkinHistory', { cursor: reset ? '' : this.data.cursor });
      if (!this._visible || version !== this._version || loginVersion !== this._loginVersion) return;
      const previous = reset ? [] : this.data.items;
      const known = new Set(previous.map((item) => item.id));
      const items = result.items.filter((item) => !known.has(item.id)).map((item) => ({ ...item, completed_time: displayTime(item.completed_at) }));
      this.setData({ items: previous.concat(items), cursor: result.cursor, loaded: true });
    } catch (error) {
      if (this._visible && version === this._version && loginVersion === this._loginVersion) this.setData({ error: error.message });
    } finally { if (this._visible && version === this._version && loginVersion === this._loginVersion) this.setData({ loading: false }); }
  },
  onRetry() { return this.loadHistory(true); },
  onLoadMore() { if (this.data.cursor) return this.loadHistory(false); },
  onReachBottom() { return this.onLoadMore(); },
  onPullDownRefresh() { return this.loadHistory(true).finally(() => wx.stopPullDownRefresh()); },
  onOpenActivity(event) { wx.navigateTo({ url: `/pages/activity-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  onHide() { this._version = (this._version || 0) + 1; this.setData({ items: [], loading: false, loaded: false }); },
}));
