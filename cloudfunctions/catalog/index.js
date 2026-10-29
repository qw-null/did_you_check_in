const cloud = require('wx-server-sdk');
const { createCatalogHandler } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = createCatalogHandler({
  db: cloud.database(), getWXContext: () => cloud.getWXContext(),
  getStorageEnv: () => cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || '',
  downloadImage: async (fileId) => (await cloud.downloadFile({ fileID: fileId })).fileContent,
  uploadImage: async (options) => (await cloud.uploadFile(options)).fileID,
  deleteImage: (fileId) => cloud.deleteFile({ fileList: [fileId] }),
  getImageUrls: async (fileIds) => {
    const result = await cloud.getTempFileURL({ fileList: fileIds });
    return Object.fromEntries(result.fileList.filter((file) => file.status === 0 && file.tempFileURL).map((file) => [file.fileID, file.tempFileURL]));
  },
});
