const { randomUUID } = require('node:crypto');
const { createStore } = require('./store');
const { readImage } = require('./media');
const { createStepUploads } = require('./step-uploads');
const { createPersonalActivities } = require('./personal');
const { CatalogError, fail, hash, userIdFor, text, choice, id, platformInput, activityInput, publishable, executable, publicActivity, canonical } = require('./rules');

const APP_ID = 'wxb7e6889ef5fe7e88';
const PAGE_SIZE = 20;
const SNAPSHOT_MS = 15 * 60 * 1000;
const PUBLIC_ACTIONS = ['list', 'detail', 'entry', 'recordView', 'joinActivity', 'removeActivity', 'completeCheckin', 'myCheckins', 'checkinHistory'];
const ADMIN_ACTIONS = ['dashboard', 'platforms', 'platformImpact', 'savePlatform', 'setPlatformStatus', 'activities', 'adminDetail', 'saveActivity', 'verifyActivity', 'transitionActivity', 'uploadStepImage', 'prepareStepImageUpload', 'completeStepImageUpload', 'cancelStepImageUpload'];

function createCatalogHandler({ db, store = createStore(db), getWXContext, uploadImage, deleteImage, getImageUrls, getStorageEnv, downloadImage, now = () => new Date(), logger = console }) {
  const stepUploads = createStepUploads({ store, requireAdmin, getStorageEnv, downloadImage, uploadImage, deleteImage, getImageUrls, now, logger });
  const personal = createPersonalActivities({ store, requireUser, now });
  async function withImages(item) {
    const steps = (item.participation_steps || []).map((step) => typeof step === 'string' ? { text: step, images: [] } : step);
    const files = [...new Set(steps.flatMap((step) => step.images || []))];
    let urls = {};
    if (files.length && getImageUrls) {
      try { urls = await getImageUrls(files); } catch (_) { logger.error('catalog:image_urls_unavailable'); }
    }
    return { ...item, participation_steps: steps.map((step) => ({ ...step, image_urls: (step.images || []).map((file) => urls[file] || '') })) };
  }
  async function requireUser(source, userId) {
    const user = await source.get('users', userId);
    if (!user) fail('请先登录', 'LOGIN_REQUIRED');
    if (user.status !== 'active') fail('当前账号不可使用', 'ACCOUNT_RESTRICTED');
    return user;
  }
  async function requireAdmin(source, actor) {
    await requireUser(source, actor.userId);
    const binding = await source.get('admin_bindings', actor.binding._id);
    if (!binding || binding.user_id !== actor.userId || binding.role !== 'admin' || binding.status !== 'enabled') fail('当前账号没有管理权限', 'FORBIDDEN');
  }
  async function all(collection, where = {}) {
    const rows = [];
    let after = '';
    for (;;) {
      const page = await store.scan(collection, where, after, 100);
      rows.push(...page);
      if (rows.length > 5000) fail('当前查询范围过大，请缩小范围或联系维护者', 'QUERY_TOO_LARGE');
      if (page.length < 100) return rows;
      after = page[page.length - 1]._id;
    }
  }
  function expected(record, value) {
    if (!Number.isInteger(value) || value !== record.revision) fail('内容已被其他操作更新，请刷新后重试', 'CONFLICT');
  }
  async function mutate(action, event, actor, payload, work) {
    const requestId = id(event.requestId, '请求标识');
    const requestKey = `r_${hash(`${actor.userId}:${requestId}`).slice(0, 40)}`;
    const fingerprint = hash(JSON.stringify(canonical({ action, payload })));
    return store.transact(async (tx) => {
      await requireAdmin(tx, actor);
      const previous = await tx.get('catalog_requests', requestKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('同一请求标识不能用于不同操作', 'REQUEST_CONFLICT');
        return previous.result;
      }
      const time = now();
      const result = await work(tx, time, requestKey);
      await tx.put('audit_logs', requestKey, {
        actor_user_id: actor.userId, actor_binding_id: actor.binding._id, action,
        target_id: result.item._id, revision: result.item.revision, created_at: time,
        request_id: requestId,
      });
      await tx.put('catalog_requests', requestKey, { user_id: actor.userId, fingerprint, result, created_at: time });
      return result;
    });
  }
  async function publicDetail(activityId, time) {
    const activity = await store.get('activities', activityId);
    if (!activity || !activity.first_published_at || activity.publication_status === 'draft') fail('活动不存在或暂未公开', 'NOT_FOUND');
    const platform = await store.get('platforms', activity.platform_id);
    return { activity, platform, item: publicActivity(activity, platform, time, true) };
  }
  function filters(event) {
    const category = event.category || 'all';
    choice(category, ['all', 'points', 'gift', 'benefit'], '分类');
    return { category, query: text(event.query, 60, '搜索词').toLocaleLowerCase(), daily: event.daily === true, ending: event.ending === true };
  }
  async function list(event, userId, time) {
    const filter = filters(event);
    const signature = hash(JSON.stringify(filter));
    let snapshot;
    let offset = 0;
    if (event.cursor) {
      const cursor = text(event.cursor, 160, '分页标识', 1).split(':');
      if (cursor.length !== 2 || !/^\d+$/.test(cursor[1])) fail('分页标识无效');
      snapshot = await store.get('catalog_snapshots', id(cursor[0]));
      offset = Number(cursor[1]);
      if (!snapshot || snapshot.user_id !== userId || snapshot.signature !== signature || new Date(snapshot.expires_at) <= time) fail('列表已过期，请刷新活动', 'CURSOR_EXPIRED');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.ids.length) fail('分页标识无效');
    } else {
      const where = { publication_status: 'published', verification_status: 'verified', content_restricted: false };
      if (filter.category !== 'all') where.category = filter.category;
      if (filter.daily) where.frequency = 'daily';
      const [activities, platforms] = await Promise.all([all('activities', where), all('platforms', { status: 'enabled' })]);
      const platformMap = new Map(platforms.map((platform) => [platform._id, platform]));
      const matches = activities.filter((activity) => {
        const platform = platformMap.get(activity.platform_id);
        return executable(activity, platform, time)
          && (!filter.ending || (activity.validity_type === 'fixed' && activity.end_at && new Date(activity.end_at).getTime() - time.getTime() <= 48 * 3600000))
          && (!filter.query || [activity.title, activity.keywords, platform.name].some((value) => (value || '').toLocaleLowerCase().includes(filter.query)));
      });
      matches.sort((left, right) => new Date(right.last_verified_at) - new Date(left.last_verified_at) || (left._id < right._id ? 1 : -1));
      snapshot = {
        _id: `s_${randomUUID().replace(/-/g, '')}`, user_id: userId, signature,
        ids: matches.map((activity) => activity._id), created_at: time, expires_at: new Date(time.getTime() + SNAPSHOT_MS),
      };
      await store.create('catalog_snapshots', snapshot);
    }
    const items = [];
    const platforms = new Map();
    // 每一页重新核实活动与平台状态；快照只固定初次查询的顺序与候选 ID，不固定授权或有效性。
    while (offset < snapshot.ids.length && items.length < PAGE_SIZE) {
      const activity = await store.get('activities', snapshot.ids[offset++]);
      if (!activity) continue;
      if (!platforms.has(activity.platform_id)) platforms.set(activity.platform_id, await store.get('platforms', activity.platform_id));
      const platform = platforms.get(activity.platform_id);
      if (!executable(activity, platform, time)) continue;
      if (filter.category !== 'all' && activity.category !== filter.category) continue;
      if (filter.daily && activity.frequency !== 'daily') continue;
      if (filter.ending && (activity.validity_type !== 'fixed' || !activity.end_at || new Date(activity.end_at) - time > 48 * 3600000)) continue;
      if (filter.query && ![activity.title, activity.keywords, platform.name].some((value) => (value || '').toLocaleLowerCase().includes(filter.query))) continue;
      items.push(publicActivity(activity, platform, time));
    }
    const enriched = await Promise.all(items.map(async (item) => ({ ...item, personal: await personal.state(userId, item.id, time, item) })));
    return { items: enriched, cursor: offset < snapshot.ids.length ? `${snapshot._id}:${offset}` : '', snapshot_at: snapshot.created_at };
  }

  return async function handle(event = {}) {
    try {
      const context = getWXContext();
      if (!context.OPENID || context.APPID !== APP_ID) fail('无法核实当前微信身份', 'IDENTITY_UNAVAILABLE');
      const userId = userIdFor(context.APPID, context.OPENID);
      const action = event.action;
      if (![...PUBLIC_ACTIONS, ...ADMIN_ACTIONS].includes(action)) fail('不支持的活动操作');
      await requireUser(store, userId);
      const time = now();
      let actor;
      if (ADMIN_ACTIONS.includes(action)) {
        const bindings = await store.scan('admin_bindings', { user_id: userId }, '', 2);
        if (bindings.length !== 1 || bindings[0].role !== 'admin' || bindings[0].status !== 'enabled') fail('当前账号没有管理权限', 'FORBIDDEN');
        actor = { userId, binding: bindings[0] };
      }
      let data;
      if (action === 'list') data = await list(event, userId, time);
      if (action === 'detail' || action === 'entry') {
        const detail = await publicDetail(id(event.id), time);
        if (action === 'entry' && !detail.item.executable) fail(detail.item.status_label, 'NOT_EXECUTABLE');
        data = { item: { ...await withImages(detail.item), personal: await personal.state(userId, detail.activity._id, time, { ...detail.item, frequency: detail.activity.frequency }) } };
      }
      if (['joinActivity', 'removeActivity', 'completeCheckin'].includes(action)) data = await personal.write(action, event, userId, time);
      if (action === 'myCheckins') data = await personal.list(event, userId, time);
      if (action === 'checkinHistory') data = await personal.history(event, userId);
      if (action === 'recordView') {
        const activityId = id(event.id);
        data = await store.transact(async (tx) => {
          await requireUser(tx, userId);
          const activity = await tx.get('activities', activityId);
          if (!activity || !activity.first_published_at || activity.publication_status === 'draft') fail('活动暂不可记录浏览', 'NOT_FOUND');
          if (activity.content_restricted) return { recorded: false };
          const key = `v_${hash(`${userId}:${activityId}`).slice(0, 40)}`;
          const previous = await tx.get('activity_views', key);
          await tx.put('activity_views', key, {
            user_id: userId, activity_id: activityId, first_viewed_at: previous ? previous.first_viewed_at : time, last_viewed_at: time,
          });
          return { recorded: true };
        });
      }
      if (action === 'dashboard') {
        const [platforms, activities] = await Promise.all([store.count('platforms'), all('activities')]);
        data = {
          platforms, activities: activities.length,
          review_due: activities.filter((item) => item.first_published_at && item.publication_status !== 'ended'
            && (item.verification_status !== 'verified' || !item.next_verify_at || new Date(item.next_verify_at) <= time)).length,
        };
      }
      if (action === 'platforms' || action === 'activities') {
        const collection = action === 'platforms' ? 'platforms' : 'activities';
        const where = {};
        if (action === 'activities' && event.status && event.status !== 'all') where.publication_status = choice(event.status, ['draft', 'published', 'paused', 'ended'], '发布状态');
        let after = event.cursor ? id(event.cursor) : '';
        const items = [];
        let more = false;
        do {
          const rows = await store.scan(collection, where, after, PAGE_SIZE);
          if (!rows.length) { more = false; break; }
          after = rows[rows.length - 1]._id;
          more = rows.length === PAGE_SIZE;
          items.push(...rows.filter((item) => !event.reviewOnly || (item.first_published_at && item.publication_status !== 'ended'
            && (item.verification_status !== 'verified' || !item.next_verify_at || new Date(item.next_verify_at) <= time))));
        } while (event.reviewOnly && items.length < PAGE_SIZE && more);
        const enriched = action === 'activities' ? await Promise.all(items.map(async (item) => {
          const platform = await store.get('platforms', item.platform_id);
          return { ...item, platform_name: platform ? platform.name : '平台已删除' };
        })) : items;
        data = { items: enriched, cursor: more ? after : '' };
      }
      if (action === 'platformImpact') data = { activities: await store.count('activities', { platform_id: id(event.id), publication_status: 'published' }) };
      if (action === 'adminDetail') {
        const item = await store.get('activities', id(event.id));
        if (!item) fail('活动不存在', 'NOT_FOUND');
        data = { item: await withImages(item) };
      }
      if (action === 'prepareStepImageUpload') data = await stepUploads.prepare(actor);
      if (action === 'completeStepImageUpload') data = await stepUploads.complete(event, actor);
      if (action === 'cancelStepImageUpload') data = await stepUploads.cancel(event, actor);
      if (action === 'uploadStepImage') {
        const { buffer, extension } = readImage(event.base64);
        if (!uploadImage || !getImageUrls) throw new Error('image storage unavailable');
        const fileId = await uploadImage({ cloudPath: `activity-steps/${userId}/${randomUUID()}.${extension}`, fileContent: buffer });
        try {
          if (!fileId) throw new Error('image upload failed');
          const urls = await getImageUrls([fileId]);
          if (!urls[fileId]) throw new Error('image URL unavailable');
          await store.create('catalog_images', { _id: hash(fileId), file_id: fileId, uploaded_by: userId, created_at: time });
          data = { fileId, url: urls[fileId] };
        } catch (error) {
          if (fileId && deleteImage) { try { await deleteImage(fileId); } catch (_) { logger.error('catalog:image_cleanup_failed'); } }
          throw error;
        }
      }
      if (action === 'savePlatform') {
        const input = platformInput(event.input);
        const existingId = event.id ? id(event.id) : '';
        data = await mutate(action, event, actor, { input, id: existingId, revision: event.expectedRevision }, async (tx, date, key) => {
          const previous = existingId ? await tx.get('platforms', existingId) : null;
          if (existingId && !previous) fail('平台不存在', 'NOT_FOUND');
          if (previous) expected(previous, event.expectedRevision);
          const item = { ...previous, ...input, _id: existingId || `p_${key.slice(2)}`, status: previous ? previous.status : 'enabled', revision: previous ? previous.revision + 1 : 1, created_at: previous ? previous.created_at : date, updated_at: date };
          await tx.put('platforms', item._id, item);
          return { item };
        });
      }
      if (action === 'setPlatformStatus') {
        const platformId = id(event.id);
        const status = choice(event.status, ['enabled', 'disabled'], '平台状态');
        const reason = text(event.reason, 300, '操作原因', 5);
        if (status === 'disabled' && event.confirmDisabled !== true) fail('停用平台前须确认影响范围');
        data = await mutate(action, event, actor, { id: platformId, status, reason, revision: event.expectedRevision }, async (tx, date) => {
          const previous = await tx.get('platforms', platformId);
          if (!previous) fail('平台不存在', 'NOT_FOUND');
          expected(previous, event.expectedRevision);
          const item = { ...previous, status, status_note: reason, revision: previous.revision + 1, updated_at: date };
          await tx.put('platforms', platformId, item);
          return { item };
        });
      }
      if (action === 'saveActivity') {
        const input = activityInput(event.input);
        for (const file of new Set(input.participation_steps.flatMap((step) => step.images))) {
          const image = await store.get('catalog_images', hash(file));
          if (!image || image.file_id !== file) fail('步骤图片未通过上传校验，请重新上传');
        }
        const activityId = event.id ? id(event.id) : '';
        data = await mutate(action, event, actor, { input, id: activityId, revision: event.expectedRevision }, async (tx, date, key) => {
          const platform = await tx.get('platforms', input.platform_id);
          if (!platform) fail('所属平台不存在');
          const previous = activityId ? await tx.get('activities', activityId) : null;
          if (activityId && !previous) fail('活动不存在', 'NOT_FOUND');
          if (previous) {
            expected(previous, event.expectedRevision);
            if (previous.publication_status === 'ended') fail('已结束活动不可编辑，请创建新活动');
            if (previous.first_published_at && previous.frequency !== input.frequency) fail('首次发布后不能修改任务频率，请创建新活动');
          }
          const changed = !previous || Object.entries(input).some(([key, value]) => JSON.stringify(canonical(previous[key])) !== JSON.stringify(canonical(value)));
          const item = {
            publication_status: 'draft', content_restricted: false, source_type: 'operator', first_published_at: null,
            ...previous, ...input, _id: activityId || `a_${key.slice(2)}`,
            owner_admin_id: actor.binding._id, direct_open_enabled: !changed && previous ? previous.direct_open_enabled === true : false,
            entry_tested_at: changed ? null : previous.entry_tested_at || null,
            entry_tested_by: changed ? '' : previous.entry_tested_by || '',
            entry_test_note: changed ? '' : previous.entry_test_note || '',
            verification_status: changed ? 'pending' : previous.verification_status,
            next_verify_at: changed ? null : previous.next_verify_at,
            revision: previous ? previous.revision + 1 : 1, created_at: previous ? previous.created_at : date, updated_at: date,
          };
          await tx.put('activities', item._id, item);
          return { item };
        });
      }
      if (action === 'verifyActivity') {
        const activityId = id(event.id);
        const evidence = text(event.evidence, 1000, '本次核验说明', 10);
        const entryTested = event.entryTested === true;
        data = await mutate(action, event, actor, { id: activityId, evidence, entryTested, revision: event.expectedRevision }, async (tx, date) => {
          const previous = await tx.get('activities', activityId);
          if (!previous) fail('活动不存在', 'NOT_FOUND');
          expected(previous, event.expectedRevision);
          if (previous.publication_status === 'ended') fail('已结束活动不可重新核验');
          publishable(previous, await tx.get('platforms', previous.platform_id), date);
          const hours = previous.validity_type === 'fixed' ? 24 : 72;
          const enableEntry = entryTested && previous.entry_type === 'mini_program' && Boolean(previous.target_address || previous.target_app_id);
          const item = { ...previous, verification_status: 'verified', verification_evidence: evidence, verified_by: actor.binding._id,
            direct_open_enabled: enableEntry, entry_tested_at: enableEntry ? date : null,
            entry_tested_by: enableEntry ? actor.binding._id : '', entry_test_note: enableEntry ? evidence : '',
            last_verified_at: date, next_verify_at: new Date(date.getTime() + hours * 3600000), revision: previous.revision + 1, updated_at: date };
          await tx.put('activities', activityId, item);
          return { item };
        });
      }
      if (action === 'transitionActivity') {
        const activityId = id(event.id);
        const status = choice(event.status, ['published', 'paused', 'ended'], '目标状态');
        const reason = text(event.reason, 300, '操作说明', 5);
        if (status === 'ended' && event.confirmEnded !== true) fail('结束活动不可恢复，请先确认');
        data = await mutate(action, event, actor, { id: activityId, status, reason, revision: event.expectedRevision }, async (tx, date) => {
          const previous = await tx.get('activities', activityId);
          if (!previous) fail('活动不存在', 'NOT_FOUND');
          expected(previous, event.expectedRevision);
          const transitions = { draft: ['published'], published: ['paused', 'ended'], paused: ['published', 'ended'], ended: [] };
          if (!(transitions[previous.publication_status] || []).includes(status)) fail('活动状态不允许此操作');
          if (status === 'published') {
            publishable(previous, await tx.get('platforms', previous.platform_id), date);
            if (previous.verification_status !== 'verified' || !previous.next_verify_at || new Date(previous.next_verify_at) <= date) fail('请先完成有效核验，再发布或恢复');
          }
          const item = { ...previous, publication_status: status, status_note: reason,
            first_published_at: previous.first_published_at || date, revision: previous.revision + 1, updated_at: date };
          await tx.put('activities', activityId, item);
          return { item };
        });
      }
      return { ok: true, data: { ...data, businessDate: new Date(time.getTime() + 8 * 3600000).toISOString().slice(0, 10) } };
    } catch (error) {
      if (error instanceof CatalogError) return { ok: false, error: { code: error.code, message: error.message } };
      logger.error('catalog:backend_failure', {
        action: event.action, code: String(error.errCode || error.code || 'UNKNOWN'),
        message: String(error.errMsg || error.message || '').replace(/https?:\/\/\S+/g, '[storage-url]')
          .replace(/(Signature|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 300),
      });
      return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: /StepImage/.test(event.action)
        ? '图片云端处理失败，请查看 catalog 日志及云存储配置' : '活动服务暂不可用，请检查云函数、集合及事务配置后重试' } };
    }
  };
}

module.exports = { createCatalogHandler };
