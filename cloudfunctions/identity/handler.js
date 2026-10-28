const { createHash } = require('node:crypto');

const APP_ID = 'wxb7e6889ef5fe7e88';

class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function getBusinessDate(now) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function userIdFor(appId, openId) {
  return `u_${createHash('sha256').update(`${appId}:${openId}`).digest('hex')}`;
}

async function findOne(db, collection, id) {
  const result = await db.collection(collection).where({ _id: id }).limit(1).get();
  return result.data[0] || null;
}

function requireActive(user) {
  if (!user) throw new IdentityError('LOGIN_REQUIRED', '请先建立微信身份');
  if (user.status !== 'active') {
    throw new IdentityError('ACCOUNT_RESTRICTED', '当前账号不可使用，请联系项目支持');
  }
  return user;
}

function publicUser(user) {
  return { id: user._id, displayName: '微信用户' };
}

/** 权限只信任云端上下文与受控集合，客户端不能指定当前用户或管理角色。 */
function createIdentityHandler({ db, getWXContext, now = () => new Date(), logger = console }) {
  return async function handle(event = {}) {
    try {
      const { OPENID, APPID } = getWXContext();
      if (!OPENID || APPID !== APP_ID) {
        throw new IdentityError('IDENTITY_UNAVAILABLE', '无法核实当前微信身份');
      }

      const action = event.action;
      if (!['current', 'login', 'checkAdmin'].includes(action)) {
        throw new IdentityError('INVALID_ACTION', '不支持的身份操作');
      }

      const date = now();
      const userId = userIdFor(APPID, OPENID);
      let user = await findOne(db, 'users', userId);

      if (action === 'current') {
        if (user) requireActive(user);
        return { ok: true, data: { user: user ? publicUser(user) : null, businessDate: getBusinessDate(date) } };
      }

      if (action === 'login' && !user) {
        const candidate = {
          _id: userId,
          wechat_openid: OPENID,
          wechat_appid: APPID,
          status: 'active',
          created_at: date,
        };

        try {
          // 确定性 _id 是身份记录的唯一约束；不使用 set 覆盖既有账号状态。
          await db.collection('users').add({ data: candidate });
          user = candidate;
        } catch (error) {
          // 并发首次登录可能已经由另一请求创建；重新读取，不能把任意写错误当成功。
          user = await findOne(db, 'users', userId);
          if (!user) throw error;
        }
      }

      requireActive(user);

      if (action === 'checkAdmin') {
        const binding = await findOne(db, 'admin_bindings', userId);
        if (!binding || binding.user_id !== userId || binding.role !== 'admin' || binding.status !== 'enabled') {
          throw new IdentityError('FORBIDDEN', '当前账号没有管理权限');
        }
        return {
          ok: true,
          data: { user: publicUser(user), admin: { bindingId: binding._id, role: 'admin' }, businessDate: getBusinessDate(date) },
        };
      }

      return { ok: true, data: { user: publicUser(user), businessDate: getBusinessDate(date) } };
    } catch (error) {
      if (error instanceof IdentityError) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      // 不把完整 SDK 异常、OpenID 或会话写到响应/日志。
      logger.error('identity:backend_failure', { code: String(error.errCode || error.code || 'UNKNOWN') });
      return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试或联系项目维护者' } };
    }
  };
}

module.exports = { createIdentityHandler };
