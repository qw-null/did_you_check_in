const { createHash, randomUUID } = require('node:crypto');

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

async function publicUser(user, getAvatarUrl) {
  let avatarUrl = '';
  if (user.avatar_file_id && getAvatarUrl) {
    // 临时链接不写入数据库；签名失败时仍允许使用账号与默认头像。
    try { avatarUrl = await getAvatarUrl(user.avatar_file_id); } catch (error) { /* 默认头像 */ }
  }
  return { id: user._id, displayName: user.display_name || '微信用户', avatarUrl };
}

function readAvatar(base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new IdentityError('INVALID_PROFILE', '头像文件无效或超过 1MB');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 1024 * 1024) throw new IdentityError('INVALID_PROFILE', '头像文件不能超过 1MB');
  let extension;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) extension = 'jpg';
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  if (!extension) throw new IdentityError('INVALID_PROFILE', '请选择 JPG、PNG 或 WebP 图片');
  return { buffer, extension };
}

async function countActivities(db, collection, userId) {
  const result = await db.collection(collection).aggregate()
    .match({ user_id: userId }).group({ _id: '$activity_id' }).count('total').end();
  return result.list.length ? result.list[0].total : 0;
}

/** 权限只信任云端上下文与受控集合，客户端不能指定当前用户或管理角色。 */
function createIdentityHandler({ db, getWXContext, uploadAvatar, deleteAvatar, getAvatarUrl, now = () => new Date(), logger = console }) {
  async function discardAvatar(fileId) {
    if (!fileId || !deleteAvatar) return;
    try { await deleteAvatar(fileId); } catch (error) { logger.error('identity:avatar_cleanup_failed'); }
  }

  return async function handle(event = {}) {
    try {
      const { OPENID, APPID } = getWXContext();
      if (!OPENID || APPID !== APP_ID) {
        throw new IdentityError('IDENTITY_UNAVAILABLE', '无法核实当前微信身份');
      }

      const action = event.action;
      if (!['current', 'login', 'checkAdmin', 'summary', 'saveProfile'].includes(action)) {
        throw new IdentityError('INVALID_ACTION', '不支持的身份操作');
      }

      const date = now();
      const userId = userIdFor(APPID, OPENID);
      let user = await findOne(db, 'users', userId);

      if (action === 'current') {
        if (user) requireActive(user);
        return { ok: true, data: { user: user ? await publicUser(user, getAvatarUrl) : null, businessDate: getBusinessDate(date) } };
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

      if (action === 'summary') {
        const [joined, browsed, completed] = await Promise.all([
          db.collection('user_activities').where({ user_id: userId, status: 'active' }).count(),
          countActivities(db, 'activity_views', userId),
          countActivities(db, 'checkins', userId),
        ]);
        return {
          ok: true,
          data: {
            user: await publicUser(user, getAvatarUrl),
            summary: { joined: joined.total, browsed, completed },
            businessDate: getBusinessDate(date),
          },
        };
      }

      if (action === 'saveProfile') {
        const previousAvatar = user.avatar_file_id;
        const name = typeof event.displayName === 'string' ? event.displayName.trim() : '';
        if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f]/.test(name)) {
          throw new IdentityError('INVALID_PROFILE', '昵称需为 1–24 个字');
        }
        const fields = { display_name: name, updated_at: date };
        if (event.avatarBase64 !== undefined) {
          const { buffer, extension } = readAvatar(event.avatarBase64);
          if (!uploadAvatar) throw new Error('avatar storage unavailable');
          fields.avatar_file_id = await uploadAvatar({
            cloudPath: `user-avatars/${userId}/${randomUUID()}.${extension}`,
            fileContent: buffer,
          });
          if (!fields.avatar_file_id) throw new Error('avatar upload failed');
        }
        try {
          const result = await db.collection('users').doc(userId).update({ data: fields });
          if (!result.stats || result.stats.updated !== 1) throw new Error('profile update failed');
        } catch (error) {
          await discardAvatar(fields.avatar_file_id);
          throw error;
        }
        if (fields.avatar_file_id && previousAvatar && previousAvatar !== fields.avatar_file_id) await discardAvatar(previousAvatar);
        user = { ...user, ...fields };
      }

      if (action === 'checkAdmin') {
        // 绑定文档允许使用自动生成的 _id；用户关联只取服务端计算的 user_id。
        // 读取至多两条，避免重复绑定时任意选中一条而错误授权。
        const bindings = await db.collection('admin_bindings').where({ user_id: userId }).limit(2).get();
        if (bindings.data.length > 1) {
          throw new IdentityError('FORBIDDEN', '管理员绑定重复，请联系环境负责人处理');
        }
        const binding = bindings.data[0];
        if (!binding || binding.user_id !== userId || binding.role !== 'admin' || binding.status !== 'enabled') {
          throw new IdentityError('FORBIDDEN', '当前账号没有管理权限');
        }
        return {
          ok: true,
          data: { user: await publicUser(user, getAvatarUrl), admin: { bindingId: binding._id, role: 'admin' }, businessDate: getBusinessDate(date) },
        };
      }

      return { ok: true, data: { user: await publicUser(user, getAvatarUrl), businessDate: getBusinessDate(date) } };
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
