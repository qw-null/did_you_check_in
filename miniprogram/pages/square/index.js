const { createLoginPage } = require('../../services/login-page');
const { callCatalog, displayDate } = require('../../services/catalog');
const { writePersonal } = require('../../services/checkins');

Page(createLoginPage({
  data: {
    items: [], category: 'all', query: '', daily: false, ending: false,
    listLoading: false, listError: '', cursor: '', hasMore: false, empty: false,
    joining: '', todayProgress: null,
  },

  onOpenCheckins() { wx.switchTab({ url: '/pages/checkins/index' }); },
  async onAuthenticated() { await Promise.all([this.loadActivities(true), this.loadTodayProgress()]); },
  async loadTodayProgress() {
    const version = this._loginVersion;
    try {
      const result = await callCatalog('myCheckins', { view: 'today', filter: 'pending' });
      if (this._visible && version === this._loginVersion) this.setData({ todayProgress: result.progress });
    } catch (_) { if (this._visible && version === this._loginVersion) this.setData({ todayProgress: null }); }
  },
  async onJoin(event) {
    if (this.data.joining || !this.data.authenticated) return;
    const activityId = event.currentTarget.dataset.id;
    const userId = this.data.user.id;
    const version = this._loginVersion;
    this.setData({ joining: activityId, listError: '' });
    try {
      await writePersonal(userId, 'joinActivity', activityId);
      if (!this._visible || version !== this._loginVersion) return;
      await this.onAuthenticated();
      if (this._visible && version === this._loginVersion) wx.showToast({ title: '已加入我的打卡', icon: 'success' });
    } catch (error) {
      if (!this._visible || version !== this._loginVersion) return;
      if (error.code === 'NOT_EXECUTABLE') await this.loadActivities(true);
      if (this._visible && version === this._loginVersion) this.setData({ listError: error.message });
    } finally { if (this._visible && version === this._loginVersion) this.setData({ joining: '' }); }
  },
  onSearchInput(event) { this.setData({ query: event.detail.value }); },
  onSearch() { return this.loadActivities(true); },

  onChooseCategory(event) {
    const category = event.currentTarget.dataset.category;
    if (category === this.data.category) return;
    this.setData({ category });
    return this.loadActivities(true);
  },

  onToggleFilter(event) {
    const key = event.currentTarget.dataset.filter;
    if (!['daily', 'ending'].includes(key)) return;
    this.setData({ [key]: !this.data[key] });
    return this.loadActivities(true);
  },

  async loadActivities(reset) {
    if (!this.data.authenticated || (this.data.listLoading && !reset)) return;
    const version = this._listVersion = (this._listVersion || 0) + 1;
    const filters = { category: this.data.category, query: this.data.query.trim(), daily: this.data.daily, ending: this.data.ending };
    const cursor = reset ? '' : this.data.cursor;
    this.setData({ listLoading: true, listError: '', ...(reset ? { items: [], cursor: '', hasMore: false, empty: false } : {}) });
    try {
      const result = await callCatalog('list', { ...filters, ...(cursor ? { cursor } : {}) });
      if (!this._visible || version !== this._listVersion) return;
      const known = new Set(reset ? [] : this.data.items.map((item) => item.id));
      const incoming = result.items.filter((item) => !known.has(item.id)).map((item) => ({ ...item, last_verified_at: displayDate(item.last_verified_at), end_at: displayDate(item.end_at) }));
      const items = (reset ? [] : this.data.items).concat(incoming);
      this.setData({ items, cursor: result.cursor, hasMore: Boolean(result.cursor), empty: items.length === 0 });
    } catch (error) {
      if (!this._visible || version !== this._listVersion) return;
      this.setData({ listError: error.message, ...(reset ? { items: [], empty: false } : {}) });
    } finally {
      if (this._visible && version === this._listVersion) this.setData({ listLoading: false });
    }
  },

  onOpenActivity(event) {
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/activity-detail/index?id=${encodeURIComponent(id)}` });
  },
  onClearFilters() {
    this.setData({ category: 'all', query: '', daily: false, ending: false });
    return this.loadActivities(true);
  },
  onRetry() { return this.loadActivities(true); },
  onPullDownRefresh() { return this.onAuthenticated().finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore) return this.loadActivities(false); },
  onHide() {
    this._listVersion = (this._listVersion || 0) + 1;
    this.setData({ listLoading: false, joining: '', todayProgress: null });
  },
}));
