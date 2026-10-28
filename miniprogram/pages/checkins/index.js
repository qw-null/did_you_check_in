Page({
  data: {
    currentView: 'today',
  },

  onViewChange(event) {
    const view = event.currentTarget.dataset.view;
    if (view === 'today' || view === 'all') {
      this.setData({ currentView: view });
    }
  },

  onOpenSquare() {
    wx.switchTab({ url: '/pages/square/index' });
  },
});
