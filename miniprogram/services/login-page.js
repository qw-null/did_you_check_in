const { ensureIdentity, subscribeIdentity } = require('./identity');

/** 三个 tab 共用登录状态；离开页面后不再接收异步界面更新。 */
function createLoginPage(options = {}) {
  return {
    ...options,
    data: {
      ...options.data,
      user: null,
      authenticated: false,
      loginLoading: true,
      loginError: '',
    },

    onShow() {
      this._visible = true;
      this._loginVersion = (this._loginVersion || 0) + 1;
      if (this._unsubscribeIdentity) this._unsubscribeIdentity();
      this._unsubscribeIdentity = subscribeIdentity((user) => {
        if (this._visible) this.setData({ user, authenticated: Boolean(user) });
      });
      this.setData({ authenticated: false, loginLoading: false, loginError: '' });
      return this.onLogin();
    },

    async onLogin() {
      if (this.data.loginLoading) return;
      const version = this._loginVersion;
      this.setData({ loginLoading: true, loginError: '' });
      try {
        const user = await ensureIdentity({ refresh: true });
        if (!this._visible || version !== this._loginVersion) return;
        this.setData({ user, authenticated: true, loginLoading: false });
        if (this.onAuthenticated) await this.onAuthenticated(user);
      } catch (error) {
        if (!this._visible || version !== this._loginVersion) return;
        this.setData({ user: null, authenticated: false, loginLoading: false, loginError: error.message });
      }
    },

    onHide() {
      this._visible = false;
      this._loginVersion += 1;
      if (this._unsubscribeIdentity) this._unsubscribeIdentity();
      this.setData({ user: null, authenticated: false, loginLoading: false });
      if (options.onHide) options.onHide.call(this);
    },

    onUnload() {
      this.onHide();
    },
  };
}

module.exports = { createLoginPage };
