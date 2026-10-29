const { verifyAdministrator } = require('../../../services/identity');
const { callCatalog } = require('../../../services/catalog');

Page({
  data: { authorized: false, loading: true, items: [], cursor: '', status: 'all', reviewOnly: false, error: '' },
  async onShow() {
    this._visible = true;
    const version = this._version = (this._version || 0) + 1;
    this.setData({ authorized: false, loading: true, error: '' });
    try {
      await verifyAdministrator();
      if (!this._visible || version !== this._version) return;
      this.setData({ authorized: true });
      await this.load(true, version);
    } catch (error) { if (this._visible && version === this._version) this.setData({ error: error.message, loading: false }); }
  },
  onHide() { this._visible = false; this._version += 1; this.setData({ authorized: false }); },
  async load(reset, version = this._version) {
    try {
      const result = await callCatalog('activities', { status: this.data.status, reviewOnly: this.data.reviewOnly, cursor: reset ? '' : this.data.cursor });
      if (!this._visible || version !== this._version) return;
      this.setData({ items: reset ? result.items : this.data.items.concat(result.items), cursor: result.cursor, error: '' });
    } catch (error) { if (this._visible && version === this._version) this.setData({ error: error.message }); }
    finally { if (this._visible && version === this._version) this.setData({ loading: false }); }
  },
  onChooseStatus(event) { const status = event.currentTarget.dataset.status; this.setData({ status, loading: true }); return this.load(true); },
  onToggleReview() { this.setData({ reviewOnly: !this.data.reviewOnly, loading: true }); return this.load(true); },
  onAdd() { wx.navigateTo({ url: '/admin/pages/activity-editor/index' }); },
  onEdit(event) { wx.navigateTo({ url: `/admin/pages/activity-editor/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  onPullDownRefresh() { return this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.cursor && !this.data.loading) { this.setData({ loading: true }); return this.load(false); } },
  onRetry() { this.setData({ loading: true }); return this.load(true); },
});
