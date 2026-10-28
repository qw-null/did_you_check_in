const cloud = require('wx-server-sdk');
const { createIdentityHandler } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = createIdentityHandler({
  db: cloud.database(),
  getWXContext: () => cloud.getWXContext(),
});
