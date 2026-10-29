/** SDK 适配集中在此处；不支持事务时停止写入，不降级为多次独立写。 */
function createStore(db) {
  function transactional(transaction) {
    return {
      async get(collection, id) {
        try {
          const result = await transaction.collection(collection).doc(id).get();
          return Array.isArray(result.data) ? result.data[0] || null : result.data || null;
        } catch (error) {
          const code = String(error.code || error.errCode || '');
          if (['DOCUMENT_NOT_FOUND', 'DATABASE_DOCUMENT_NOT_EXIST'].includes(code)
            || (code === '-1' && /document.*(?:does not exist|not found)/i.test(error.errMsg || error.message || ''))) return null;
          throw error;
        }
      },
      async put(collection, id, data) {
        const { _id, ...fields } = data;
        await transaction.collection(collection).doc(id).set({ data: fields });
      },
    };
  }
  return {
    async get(collection, id) {
      const result = await db.collection(collection).where({ _id: id }).limit(1).get();
      return result.data[0] || null;
    },
    async scan(collection, where = {}, after = '', size = 100) {
      const query = after ? { ...where, _id: db.command.gt(after) } : where;
      const result = await db.collection(collection).where(query).orderBy('_id', 'asc').limit(size).get();
      return result.data;
    },
    async count(collection, where = {}) { return (await db.collection(collection).where(where).count()).total; },
    async history(userId, cursor, size) {
      const where = cursor ? db.command.and([
        { user_id: userId },
        db.command.or([
          { completed_at: db.command.lt(new Date(cursor.time)) },
          { completed_at: new Date(cursor.time), _id: db.command.lt(cursor.id) },
        ]),
      ]) : { user_id: userId };
      const result = await db.collection('checkins').where(where).orderBy('completed_at', 'desc').orderBy('_id', 'desc').limit(size).get();
      return result.data;
    },
    async create(collection, data) { await db.collection(collection).add({ data }); },
    async transact(work) {
      if (typeof db.runTransaction !== 'function') throw new Error('transactions required');
      return db.runTransaction((transaction) => work(transactional(transaction)));
    },
  };
}

module.exports = { createStore };
