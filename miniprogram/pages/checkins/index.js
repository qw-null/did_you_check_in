const { createLoginPage } = require('../../services/login-page');
const { callCatalog } = require('../../services/catalog');
const { writePersonal, confirmCompletion, displayTime } = require('../../services/checkins');

Page(createLoginPage({
  data: {
    currentView: 'today', filter: 'pending', items: [], businessDate: '', progress: null,
    listLoading: false, error: '', notice: '', cursor: '', working: false, loaded: false,
    todayFilters: [{ value: 'pending', label: '待完成' }, { value: 'completed', label: '已完成' }],
    allFilters: [{ value: 'all', label: '全部' }, { value: 'ongoing', label: '进行中' },
      { value: 'once_completed', label: '一次性已完成' }, { value: 'blocked', label: '暂不可执行' }, { value: 'removed', label: '已移除' }],
  },

  onAuthenticated() { return this.loadList(true); },

  async loadList(reset = true) {
    if (!this.data.authenticated || (this.data.listLoading && !reset)) return;
    const version = this._listVersion = (this._listVersion || 0) + 1;
    const loginVersion = this._loginVersion;
    const view = this.data.currentView;
    const filter = this.data.filter;
    this.setData({ listLoading: true, error: '', ...(reset ? { items: [], cursor: '', loaded: false, progress: null } : {}) });
    try {
      const result = await callCatalog('myCheckins', { view, filter, cursor: reset ? '' : this.data.cursor });
      if (!this._visible || loginVersion !== this._loginVersion || version !== this._listVersion) return;
      const previous = reset ? [] : this.data.items;
      const known = new Set(previous.map((item) => item.id));
      const incoming = result.items.filter((item) => !known.has(item.id)).map((item) => ({ ...item, completed_time: displayTime(item.completed_at) }));
      this.setData({ items: previous.concat(incoming), cursor: result.cursor, progress: result.progress, businessDate: result.businessDate, loaded: true });
    } catch (error) {
      if (this._visible && loginVersion === this._loginVersion && version === this._listVersion) this.setData({ error: error.message });
    } finally {
      if (this._visible && loginVersion === this._loginVersion && version === this._listVersion) this.setData({ listLoading: false });
    }
  },

  onViewChange(event) {
    const view = event.currentTarget.dataset.view;
    if (view !== this.data.currentView && ['today', 'all'].includes(view) && !this.data.working) {
      this.setData({ currentView: view, filter: view === 'today' ? 'pending' : 'all', notice: '' });
      return this.loadList(true);
    }
  },

  onFilterChange(event) {
    const filter = event.currentTarget.dataset.filter;
    const choices = this.data.currentView === 'today' ? this.data.todayFilters : this.data.allFilters;
    if (this.data.working || filter === this.data.filter || !choices.some((item) => item.value === filter)) return;
    this.setData({ filter, notice: '' });
    return this.loadList(true);
  },

  async onComplete(event) {
    const activityId = event.currentTarget.dataset.id;
    const item = this.data.items.find((row) => row.id === activityId);
    if (!item || !item.can_complete || this.data.working || this.data.listLoading || !this.data.authenticated) return;
    const version = this._loginVersion;
    const date = this.data.businessDate;
    const userId = this.data.user.id;
    this.setData({ working: true, error: '', notice: '' });
    try {
      if (!await confirmCompletion(date) || !this._visible || version !== this._loginVersion) return;
      const result = await writePersonal(userId, 'completeCheckin', activityId, date);
      if (!this._visible || version !== this._loginVersion) return;
      this.setData({ notice: result.record.checkin_date === date ? '已记录你的手动确认，清单已更新' : `已恢复 ${result.record.checkin_date} 的确认结果，请重新查看今日任务` });
      await this.loadList(true);
    } catch (error) {
      if (!this._visible || version !== this._loginVersion) return;
      if (['DATE_CHANGED', 'NOT_EXECUTABLE', 'NOT_JOINED'].includes(error.code)) await this.loadList(true);
      if (this._visible && version === this._loginVersion) this.setData({ error: error.message });
    } finally { if (this._visible && version === this._loginVersion) this.setData({ working: false }); }
  },

  async onRemove(event) {
    const activityId = event.currentTarget.dataset.id;
    if (this.data.working || !this.data.authenticated) return;
    const version = this._loginVersion;
    const userId = this.data.user.id;
    this.setData({ working: true, error: '' });
    try {
      const confirmed = await new Promise((resolve) => wx.showModal({ title: '移除活动？', content: '停止后续待办，已完成记录会保留。重新加入不会重置完成状态。', confirmText: '移除', success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
      if (!confirmed || !this._visible || version !== this._loginVersion) return;
      await writePersonal(userId, 'removeActivity', activityId);
      if (!this._visible || version !== this._loginVersion) return;
      this.setData({ notice: '已移除，历史记录已保留，清单已更新' });
      await this.loadList(true);
    } catch (error) { if (this._visible && version === this._loginVersion) this.setData({ error: error.message }); }
    finally { if (this._visible && version === this._loginVersion) this.setData({ working: false }); }
  },

  onOpenActivity(event) { wx.navigateTo({ url: `/pages/activity-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  onLoadMore() { if (this.data.cursor && !this.data.working) return this.loadList(false); },
  onReachBottom() { return this.onLoadMore(); },
  onRetry() { return this.loadList(true); },
  onPullDownRefresh() { return this.loadList(true).finally(() => wx.stopPullDownRefresh()); },
  onHide() { this._listVersion = (this._listVersion || 0) + 1; this.setData({ items: [], progress: null, loaded: false, listLoading: false, working: false, notice: '' }); },

  onOpenSquare() {
    wx.switchTab({ url: '/pages/square/index' });
  },
}));
