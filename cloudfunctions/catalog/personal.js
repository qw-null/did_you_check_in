const { fail, hash, id, choice, canonical, executable, publicActivity } = require('./rules');

const PAGE_SIZE = 20;
const businessDate = (time) => new Date(time.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const relationId = (userId, activityId) => `ua_${hash(`${userId}:${activityId}`)}`;
const completionId = (userId, activityId, period) => `c_${hash(`${userId}:${activityId}:${period}`)}`;

function createPersonalActivities({ store, requireUser, now }) {
  async function fence(tx, collection, document) {
    // 快照读本身不足以阻止写偏斜：同时写入执行依赖，使暂停/停用/移除产生写冲突并重试核验。
    // 只增加内部同步字段，不改变内容修订号、运营更新时间或审计口径。
    await tx.put(collection, document._id, { ...document, _checkin_guard: (document._checkin_guard || 0) + 1 });
  }

  async function scan(collection, where) {
    const result = [];
    let after = '';
    for (;;) {
      const page = await store.scan(collection, where, after, 100);
      result.push(...page);
      if (result.length > 5000) fail('清单查询范围过大，请联系维护者', 'QUERY_TOO_LARGE');
      if (page.length < 100) return result;
      after = page[page.length - 1]._id;
    }
  }

  async function context(source, activityId, time) {
    const activity = await source.get('activities', activityId);
    const platform = activity ? await source.get('platforms', activity.platform_id) : null;
    const visible = activity && activity.first_published_at && activity.publication_status !== 'draft';
    const item = visible ? publicActivity(activity, platform, time) : {
      id: activityId, title: '活动暂不可用', platform_name: '', executable: false, status_label: '活动暂不可用',
    };
    return { activity, platform, item };
  }

  async function safeRecord(record) {
    const activity = await store.get('activities', record.activity_id);
    const restricted = Boolean(activity && activity.content_restricted);
    return {
      id: record._id, activity_id: record.activity_id, frequency: record.frequency_snapshot,
      period_key: record.period_key, checkin_date: record.checkin_date, completed_at: record.completed_at,
      completion_source: 'manual', title: restricted ? '活动信息已限制展示' : record.title_snapshot,
      platform_name: restricted ? '' : record.platform_name_snapshot, restricted,
    };
  }

  async function state(userId, activityId, time, knownItem) {
    const item = knownItem || (await context(store, activityId, time)).item;
    const date = businessDate(time);
    const [relation, record] = await Promise.all([
      store.get('user_activities', relationId(userId, activityId)),
      store.get('checkins', completionId(userId, activityId, item.frequency === 'once' ? 'once' : date)),
    ]);
    return {
      joined: Boolean(relation && relation.status === 'active'), removed: Boolean(relation && relation.status === 'removed'),
      completed: Boolean(record), completed_at: record ? record.completed_at : null,
      can_complete: Boolean(relation && relation.status === 'active' && item.executable && !record),
      can_join: Boolean(item.executable && (!relation || relation.status === 'removed')),
      businessDate: date,
    };
  }

  async function write(action, event, userId, time = now()) {
    const activityId = id(event.id, '活动 ID');
    const requestId = id(event.requestId, '请求标识');
    const fingerprint = hash(JSON.stringify(canonical({ action, id: activityId, expectedDate: event.expectedDate || '' })));
    const key = `ur_${hash(`${userId}:${requestId}`)}`;
    // 捕获首次受理时间；事务因并发重试时不更改本次请求所属日期。
    const date = businessDate(time);
    const result = await store.transact(async (tx) => {
      const user = await requireUser(tx, userId);
      const previous = await tx.get('catalog_requests', key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('同一请求标识不能用于不同操作', 'REQUEST_CONFLICT');
        return previous.result;
      }
      await fence(tx, 'users', user);
      const relationshipKey = relationId(userId, activityId);
      const relation = await tx.get('user_activities', relationshipKey);
      let output;
      if (action === 'removeActivity') {
        if (!relation) fail('该活动尚未加入清单', 'NOT_JOINED');
        const item = relation.status === 'removed' ? relation : { ...relation, status: 'removed', removed_at: time, updated_at: time };
        if (item !== relation) await tx.put('user_activities', relationshipKey, item);
        output = { relation: item };
      } else {
        const { activity, platform, item } = await context(tx, activityId, time);
        if (action === 'completeCheckin') {
          // 先查询周期已有记录，再判断日期和最新可执行状态，已成功的确认不受后续暂停/移除影响。
          const period = activity && activity.frequency === 'once' ? 'once' : date;
          const recordKey = completionId(userId, activityId, period);
          const existing = await tx.get('checkins', recordKey);
          if (existing) output = { record: existing, alreadyCompleted: true };
          else {
            if (event.expectedDate !== date) fail('日期已变化，请刷新清单后重新确认', 'DATE_CHANGED');
            if (!relation || relation.status !== 'active') fail('请先加入活动再标记完成', 'NOT_JOINED');
            if (!item.executable) fail(item.status_label, 'NOT_EXECUTABLE');
            await fence(tx, 'user_activities', relation);
            await fence(tx, 'activities', activity);
            await fence(tx, 'platforms', platform);
            const record = {
              _id: recordKey, user_id: userId, activity_id: activityId,
              frequency_snapshot: activity.frequency, period_key: period, checkin_date: date,
              completed_at: time, completion_source: 'manual', title_snapshot: activity.title,
              platform_name_snapshot: platform.name, created_at: time,
            };
            await tx.put('checkins', recordKey, record);
            output = { record, alreadyCompleted: false };
          }
        } else {
          if (!item.executable) fail(item.status_label, 'NOT_EXECUTABLE');
          await fence(tx, 'activities', activity);
          await fence(tx, 'platforms', platform);
          const itemRelation = relation && relation.status === 'active' ? relation : {
            ...relation, _id: relationshipKey, user_id: userId, activity_id: activityId, status: 'active',
            first_joined_at: relation ? relation.first_joined_at : time, last_joined_at: time,
            removed_at: null, updated_at: time,
          };
          if (itemRelation !== relation) await tx.put('user_activities', relationshipKey, itemRelation);
          output = { relation: itemRelation };
        }
      }
      await tx.put('catalog_requests', key, { user_id: userId, action, fingerprint, result: output, created_at: time });
      return output;
    });
    // 请求重放仍按最新内容限制清理快照，不能从旧成功响应泄漏受限内容。
    return result.record ? { record: await safeRecord(result.record), alreadyCompleted: result.alreadyCompleted }
      : { joined: result.relation.status === 'active', removed: result.relation.status === 'removed' };
  }

  async function list(event, userId, time) {
    const view = choice(event.view || 'today', ['today', 'all'], '清单视图');
    const filter = choice(event.filter || (view === 'today' ? 'pending' : 'all'),
      view === 'today' ? ['pending', 'completed'] : ['all', 'ongoing', 'once_completed', 'blocked', 'removed'], '清单筛选');
    const date = businessDate(time);
    const [relations, completedToday, completedOnce] = await Promise.all([
      scan('user_activities', { user_id: userId }),
      scan('checkins', { user_id: userId, checkin_date: date }),
      scan('checkins', { user_id: userId, period_key: 'once' }),
    ]);
    const relationMap = new Map(relations.map((item) => [item.activity_id, item]));
    const todayMap = new Map(completedToday.map((item) => [item.activity_id, item]));
    const onceMap = new Map(completedOnce.map((item) => [item.activity_id, item]));
    const ids = [...new Set([...relationMap.keys(), ...todayMap.keys()])];
    const rows = await Promise.all(ids.map(async (activityId) => {
      const { item, activity } = await context(store, activityId, time);
      const relation = relationMap.get(activityId);
      const record = todayMap.get(activityId) || onceMap.get(activityId);
      const onceDone = Boolean(onceMap.get(activityId));
      const active = Boolean(relation && relation.status === 'active');
      const doneToday = todayMap.has(activityId);
      const canComplete = active && item.executable && !record;
      const group = !active ? 'removed' : onceDone ? 'once_completed' : item.executable ? 'ongoing' : 'blocked';
      const restricted = Boolean(activity && activity.content_restricted);
      return {
        id: activityId, title: restricted ? '活动信息已限制展示' : item.title,
        platform_name: restricted ? '' : item.platform_name, frequency: activity ? activity.frequency : (record && record.frequency_snapshot) || '',
        joined: active, restricted, executable: Boolean(item.executable), group,
        can_complete: canComplete, completed_today: doneToday, completed: Boolean(record),
        completed_at: record ? record.completed_at : null,
        status_label: !active ? '已移除' : onceDone ? '一次性已完成' : !item.executable ? item.status_label : doneToday ? '今日已完成' : '待完成',
        activity_status: item.status_label, pending_today: canComplete,
      };
    }));
    const pending = rows.filter((row) => row.pending_today).length;
    const completed = todayMap.size;
    const eligible = rows.filter((row) => view === 'today' ? (filter === 'pending' ? row.pending_today : row.completed_today)
      : filter === 'all' ? row.joined : row.group === filter).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let after = '';
    if (event.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(event.cursor, 'base64url').toString('utf8'));
        if (cursor.date !== date || cursor.view !== view || cursor.filter !== filter) fail('清单已更新，请刷新', 'CURSOR_EXPIRED');
        after = id(cursor.after);
      } catch (error) { if (error.code === 'CURSOR_EXPIRED') throw error; fail('分页标识无效'); }
    }
    const remaining = eligible.filter((row) => row.id > after);
    const items = remaining.slice(0, PAGE_SIZE);
    return { items, progress: { pending, completed, total: pending + completed }, businessDate: date,
      cursor: remaining.length > PAGE_SIZE ? Buffer.from(JSON.stringify({ date, view, filter, after: items[items.length - 1].id })).toString('base64url') : '',
    };
  }

  async function history(event, userId) {
    let cursor;
    if (event.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(event.cursor, 'base64url').toString('utf8'));
        id(cursor.id);
        if (!Number.isFinite(new Date(cursor.time).getTime())) throw new Error('invalid date');
      } catch (_) { fail('分页标识无效'); }
    }
    const rows = await store.history(userId, cursor, PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return { items: await Promise.all(page.map(safeRecord)), cursor: rows.length > PAGE_SIZE
      ? Buffer.from(JSON.stringify({ id: last._id, time: new Date(last.completed_at).toISOString() })).toString('base64url') : '' };
  }

  return { state, write, list, history };
}

module.exports = { createPersonalActivities, businessDate, relationId, completionId };
