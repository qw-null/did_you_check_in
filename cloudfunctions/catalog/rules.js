const { createHash } = require('node:crypto');

class CatalogError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(message, code = 'INVALID_INPUT') { throw new CatalogError(code, message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function userIdFor(appId, openId) { return `u_${hash(`${appId}:${openId}`)}`; }
function text(value, max, label, min = 0) {
  const result = value == null ? '' : value;
  if (typeof result !== 'string') fail(`${label}格式不正确`);
  const normalized = result.trim();
  if ([...normalized].length < min || [...normalized].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) fail(`${label}需为 ${min}–${max} 个字`);
  return normalized;
}
function choice(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label}无效`);
  return value;
}
function id(value, label = '记录 ID') {
  const result = text(value, 100, label, 1);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail(`${label}格式不正确`);
  return result;
}
function date(value, label) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+08:00)$/.test(value)) fail(`${label}须包含日期、时间和时区`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail(`${label}格式不正确`);
  return parsed;
}
function https(value, label) {
  const result = text(value, 2048, label);
  if (!result) return '';
  try {
    const url = new URL(result);
    if (url.protocol !== 'https:' || url.username || url.password) fail(`${label}仅支持无账号密码的 HTTPS 地址`);
  } catch (error) { fail(`${label}需为有效 HTTPS 地址`); }
  return result;
}
function platformInput(input = {}) {
  return {
    name: text(input.name, 40, '平台名称', 2),
    description: text(input.description, 500, '平台说明'),
    official_url: https(input.official_url, '平台官网'),
  };
}
function activityInput(input = {}) {
  const rawSteps = typeof input.participation_steps === 'string'
    ? text(input.participation_steps, 2000, '参与步骤').split('\n').map((line) => line.trim()).filter(Boolean)
    : input.participation_steps || [];
  if (!Array.isArray(rawSteps)) fail('参与步骤格式不正确');
  const steps = rawSteps.map((step) => {
    if (typeof step === 'string') return { text: text(step, 2000, '步骤文字'), images: [] };
    if (!step || typeof step !== 'object') fail('参与步骤格式不正确');
    if (!Array.isArray(step.images || [])) fail('步骤图片格式不正确');
    const images = (step.images || []).map((file) => text(file, 500, '图片标识', 1));
    if (images.length > 3 || images.some((file) => !file.startsWith('cloud://'))) fail('每步最多 3 张已上传图片');
    return { text: text(step.text, 2000, '步骤文字'), images };
  }).filter((step) => step.text || step.images.length);
  if (steps.length > 20) fail('参与步骤最多 20 步');
  if (steps.reduce((sum, step) => sum + [...step.text].length, 0) > 2000) fail('全部步骤文字最多 2000 字');
  if (steps.reduce((sum, step) => sum + step.images.length, 0) > 9) fail('每个活动最多 9 张步骤图片');
  const activityInfo = text(input.activity_info, 3000, '活动信息') ||
    [input.reward_summary, input.eligibility, input.rules_note].filter(Boolean).join('\n');
  const entryType = choice(input.entry_type, ['web', 'mini_program', 'platform_search', 'instructions'], '入口类型');
  const address = text(input.target_address == null ? input.entry_url : input.target_address, 2048, '目标地址');
  if (entryType === 'mini_program' && address && !/^#小程序:\/\/[^\s/]+\/[A-Za-z0-9_-]+$/.test(address)) fail('请粘贴完整的小程序分享地址（#小程序://名称/链接）');
  const result = {
    platform_id: id(input.platform_id, '所属平台'), title: text(input.title, 60, '活动名称', 2),
    category: choice(input.category, ['points', 'gift', 'benefit'], '主分类'),
    frequency: choice(input.frequency, ['daily', 'once'], '任务频率'),
    keywords: text(input.keywords, 200, '搜索关键词'),
    activity_info: text(activityInfo, 3000, '活动信息'),
    reward_summary: [...activityInfo.split('\n')[0]].slice(0, 120).join(''),
    entry_type: entryType, target_address: address,
    entry_url: entryType === 'web' ? https(address, '目标地址') : '', target_app_id: text(input.target_app_id, 18, '目标 AppID'),
    target_page_path: text(input.target_page_path, 1024, '目标页面路径'),
    target_mini_program_name: text(input.target_mini_program_name, 60, '目标小程序名称'),
    search_keyword: text(input.search_keyword, 100, '平台搜索词'), participation_steps: steps,
    validity_type: choice(input.validity_type, ['fixed', 'ongoing', 'unknown'], '期限类型'),
    start_at: date(input.start_at, '开始时间'), end_at: date(input.end_at, '结束时间'),
  };
  if (result.validity_type !== 'fixed' && result.end_at) fail('长期或截止时间未知的活动不能填写结束时间');
  if (result.start_at && result.end_at && result.start_at >= result.end_at) fail('结束时间必须晚于开始时间');
  if (result.target_app_id && !/^wx[0-9a-f]{16}$/.test(result.target_app_id)) fail('目标小程序 AppID 格式不正确');
  if (result.target_page_path && (/^(?:[a-z]+:|\/\/)/i.test(result.target_page_path) || /[\r\n]/.test(result.target_page_path))) fail('目标页面路径无效');
  return result;
}
function publishable(activity, platform, now) {
  if (!platform || platform.status !== 'enabled') fail('所属平台未启用，不能核验或发布');
  if (activity.content_restricted) fail('活动内容已限制，不能核验或发布');
  if (!(activity.activity_info || activity.reward_summary) || !activity.owner_admin_id) fail('请填写活动信息');
  if (!activity.participation_steps.length || activity.participation_steps.map((step) => typeof step === 'string' ? step : step.text).join('\n').length < 10) fail('请填写清晰的参与步骤（至少 10 字，可补充图片）');
  if (activity.validity_type === 'fixed' && !activity.end_at) fail('固定期限活动必须填写结束时间');
  if (activity.end_at && new Date(activity.end_at) <= now) fail('活动已经结束，不能核验或发布');
  if (activity.entry_type === 'web' && !activity.entry_url) fail('网页活动必须填写 HTTPS 链接');
  if (activity.entry_type === 'mini_program' && !activity.target_address && (!activity.target_app_id || !activity.target_mini_program_name)) fail('请填写小程序分享地址');
  if (activity.entry_type === 'platform_search' && !activity.search_keyword) fail('平台搜索类型必须填写搜索词');
}
function executable(activity, platform, now) {
  return Boolean(platform && platform.status === 'enabled' && activity.publication_status === 'published'
    && activity.verification_status === 'verified' && activity.next_verify_at && new Date(activity.next_verify_at) > now
    && !activity.content_restricted && (!activity.start_at || new Date(activity.start_at) <= now)
    && (!activity.end_at || new Date(activity.end_at) > now));
}
function statusLabel(activity, platform, now) {
  if (activity.content_restricted) return '活动信息已限制展示';
  if (!platform || platform.status !== 'enabled') return '平台已停用';
  if (activity.publication_status === 'ended' || (activity.end_at && new Date(activity.end_at) <= now)) return '活动已结束';
  if (activity.publication_status === 'paused') return '活动已暂停';
  if (activity.verification_status !== 'verified' || !activity.next_verify_at || new Date(activity.next_verify_at) <= now) return '活动待重新核验';
  if (activity.start_at && new Date(activity.start_at) > now) return '活动尚未开始';
  return '当前可参与';
}
function publicActivity(activity, platform, now, detail = false) {
  if (activity.content_restricted) return { id: activity._id, title: '活动信息已限制展示', restricted: true, executable: false, status_label: '活动信息已限制展示' };
  const allowed = executable(activity, platform, now);
  const result = {
    id: activity._id, title: activity.title, platform_name: platform ? platform.name : '平台暂不可用',
    activity_info: activity.activity_info || [activity.reward_summary, activity.eligibility, activity.rules_note].filter(Boolean).join('\n'),
    category: activity.category, frequency: activity.frequency, reward_summary: activity.reward_summary,
    eligibility: activity.eligibility, validity_type: activity.validity_type, validity_note: activity.validity_note,
    start_at: activity.start_at, end_at: activity.end_at, last_verified_at: activity.last_verified_at,
    executable: allowed, restricted: false, status_label: statusLabel(activity, platform, now),
  };
  if (detail) Object.assign(result, {
    rules_note: activity.rules_note,
    participation_steps: allowed ? activity.participation_steps : [],
    entry_type: allowed ? activity.entry_type : '',
    target_address: allowed ? activity.target_address || activity.entry_url || '' : '',
    direct_open_enabled: allowed && activity.entry_type === 'mini_program' && activity.direct_open_enabled === true,
    target_app_id: allowed ? activity.target_app_id || '' : '', target_page_path: allowed ? activity.target_page_path || '' : '',
    entry_url: allowed ? activity.entry_url : '', search_keyword: allowed ? activity.search_keyword : '',
    target_mini_program_name: allowed ? activity.target_mini_program_name : '',
  });
  return result;
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

module.exports = { CatalogError, fail, hash, userIdFor, text, choice, id, date, platformInput, activityInput, publishable, executable, publicActivity, canonical };
