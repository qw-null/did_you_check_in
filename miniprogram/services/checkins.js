const { callCatalog, requestId } = require('./catalog');

// 请求结果未知时保留原标识，跨日重试不能成为新一天的完成操作。
// 缓存按当前用户隔离，不能把上一账号的待确认操作带给新账号。
function pendingKey(userId, action, activityId) { return `checkin-request:${userId}:${action}:${activityId}`; }

async function writePersonal(userId, action, activityId, expectedDate) {
  const key = pendingKey(userId, action, activityId);
  let payload = wx.getStorageSync(key);
  if (!payload || typeof payload !== 'object' || payload.id !== activityId || typeof payload.requestId !== 'string') {
    payload = { id: activityId, requestId: requestId() };
    if (action === 'completeCheckin') payload.expectedDate = expectedDate;
    // 先持久化再发出写请求，失败时不发送可能无法重放的请求。
    wx.setStorageSync(key, payload);
  }
  try {
    const result = await callCatalog(action, payload);
    try { wx.removeStorageSync(key); } catch (_) { /* 保留同一请求的成功重放也不会重复写入。 */ }
    return result;
  } catch (error) {
    // 网络/执行/响应异常可能已经提交，保留请求；明确的业务拒绝才允许新请求。
    const uncertain = !error.code || ['CLOUD_CALL_FAILED', 'BACKEND_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code);
    if (uncertain) error.message = `提交结果待确认，请重试或刷新清单查看。${error.message || ''}`;
    if (!uncertain && !['LOGIN_REQUIRED', 'ACCOUNT_RESTRICTED'].includes(error.code)) {
      try { wx.removeStorageSync(key); } catch (_) { /* 下次仍由服务端给出相同业务结果。 */ }
    }
    throw error;
  }
}

function confirmCompletion(date) {
  return new Promise((resolve) => wx.showModal({
    title: `确认 ${date} 已完成？`,
    content: '仅记录你的手动确认，不代表第三方平台核验或奖励到账。完成后不能撤销，也不支持补卡。',
    confirmText: '确认完成', success: (result) => resolve(result.confirm), fail: () => resolve(false),
  }));
}

function displayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { writePersonal, confirmCompletion, displayTime };
