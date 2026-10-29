const { verifyAdministrator } = require('../../../services/identity');
const { callCatalog, mutate } = require('../../../services/catalog');

Page({
  data: { authorized: false, loading: true, saving: false, items: [], cursor: '', error: '', editorOpen: false, draft: null },
  async onShow() {
    this._visible = true;
    this._version = (this._version || 0) + 1;
    const version = this._version;
    this.setData({ authorized: false, loading: true, error: '' });
    try {
      await verifyAdministrator();
      if (!this._visible || version !== this._version) return;
      this.setData({ authorized: true });
      await this.load(true, version);
    } catch (error) {
      if (this._visible && version === this._version) this.setData({ error: error.message, loading: false });
    }
  },
  onHide() { this._visible = false; this._version += 1; this.setData({ authorized: false }); },
  async load(reset, version = this._version) {
    try {
      const result = await callCatalog('platforms', { cursor: reset ? '' : this.data.cursor });
      if (!this._visible || version !== this._version) return;
      this.setData({ items: reset ? result.items : this.data.items.concat(result.items), cursor: result.cursor, error: '' });
    } catch (error) {
      if (this._visible && version === this._version) this.setData({ error: error.message });
    } finally { if (this._visible && version === this._version) this.setData({ loading: false }); }
  },
  onPullDownRefresh() { return this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.cursor && !this.data.loading) { this.setData({ loading: true }); return this.load(false); } },
  onAdd() { this.setData({ draft: { name: '', description: '', official_url: '' }, editorOpen: true, error: '' }); },
  onEdit(event) {
    const platform = this.data.items.find((item) => item._id === event.currentTarget.dataset.id);
    if (platform) this.setData({ draft: { ...platform }, editorOpen: true, error: '' });
  },
  onInput(event) { this.setData({ [`draft.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onModalTap() {},
  onCloseEditor() { if (!this.data.saving) this.setData({ editorOpen: false }); },
  async onSave() {
    const draft = this.data.draft;
    if (!draft || this.data.saving) return;
    const editing = Boolean(draft._id);
    this.setData({ saving: true, error: '' });
    try {
      await mutate('savePlatform', { ...(editing ? { id: draft._id, expectedRevision: draft.revision } : {}), input: { name: draft.name, description: draft.description, official_url: draft.official_url } });
      this.setData({ editorOpen: false });
      await this.load(true);
      wx.showToast({ title: '平台已保存', icon: 'success' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  onToggleStatus(event) {
    const item = this.data.items.find((row) => row._id === event.currentTarget.dataset.id);
    if (!item) return;
    const enabling = item.status === 'disabled';
    const next = enabling ? 'enabled' : 'disabled';
    const reason = enabling ? '运营确认恢复平台' : '运营确认停用平台';
    const perform = async (impact) => {
      if (!enabling) {
        const confirm = await new Promise((resolve) => wx.showModal({ title: '停用平台', content: `将影响 ${impact} 个已发布活动，是否继续？`, success: (result) => resolve(result.confirm) }));
        if (!confirm) return;
      }
      try {
        await mutate('setPlatformStatus', { id: item._id, status: next, reason, expectedRevision: item.revision, confirmDisabled: !enabling });
        await this.load(true);
        wx.showToast({ title: enabling ? '平台已恢复' : '平台已停用', icon: 'success' });
      } catch (error) { this.setData({ error: error.message }); }
    };
    if (enabling) perform(0);
    else callCatalog('platformImpact', { id: item._id }).then((result) => perform(result.activities)).catch((error) => this.setData({ error: error.message }));
  },
});
