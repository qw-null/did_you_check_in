const cloud = require('wx-server-sdk');
const { createIdentityHandler } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = createIdentityHandler({
  db: cloud.database(),
  getWXContext: () => cloud.getWXContext(),
  uploadAvatar: async (options) => (await cloud.uploadFile(options)).fileID,
  deleteAvatar: (fileId) => cloud.deleteFile({ fileList: [fileId] }),
  getAvatarUrl: async (fileId) => {
    const result = await cloud.getTempFileURL({ fileList: [fileId] });
    const file = result.fileList[0];
    if (!file || file.status !== 0 || !file.tempFileURL) throw new Error('avatar unavailable');
    return file.tempFileURL;
  },
});
