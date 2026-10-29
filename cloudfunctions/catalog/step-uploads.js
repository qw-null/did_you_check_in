const { randomUUID } = require('node:crypto');
const { fail, hash, id } = require('./rules');
const { readImageBuffer } = require('./media');

const UPLOAD_TTL_MS = 10 * 60 * 1000;

function createStepUploads({ store, requireAdmin, getStorageEnv, downloadImage, uploadImage, deleteImage, getImageUrls, now, logger }) {
  async function remove(fileId) {
    if (!fileId) return;
    try { await deleteImage(fileId); } catch (_) { logger.error('catalog:image_cleanup_failed'); }
  }

  function owned(ticket, actor) {
    if (!ticket || ticket.kind !== 'step_upload' || ticket.uploaded_by !== actor.userId) fail('图片上传凭证无效', 'INVALID_UPLOAD');
  }

  function pending(ticket) {
    if (ticket.status !== 'pending' || new Date(ticket.expires_at) <= now()) fail('图片上传凭证已过期，请重新上传', 'UPLOAD_EXPIRED');
  }

  function stagingFile(ticket, fileId) {
    if (typeof fileId !== 'string' || fileId.length > 1024) fail('图片文件标识无效', 'INVALID_UPLOAD');
    const env = getStorageEnv && getStorageEnv();
    if (!env) fail('无法核实云存储环境，请检查 catalog 部署配置', 'IMAGE_UPLOAD_UNAVAILABLE');
    let parsed;
    try { parsed = new URL(fileId); } catch (_) { fail('图片文件标识无效', 'INVALID_UPLOAD'); }
    if (parsed.protocol !== 'cloud:' || (parsed.hostname !== env && !parsed.hostname.startsWith(`${env}.`))
      || parsed.pathname !== `/${ticket.cloud_path}` || parsed.search || parsed.hash || parsed.username || parsed.password) {
      fail('图片文件不属于本次上传路径或云环境', 'INVALID_UPLOAD');
    }
    if (ticket.staging_file_id && ticket.staging_file_id !== fileId) fail('本次上传已绑定其他文件', 'INVALID_UPLOAD');
    return fileId;
  }

  async function result(fileId) {
    const urls = await getImageUrls([fileId]);
    if (!urls[fileId]) fail('图片已上传，预览链接暂不可用，请重试', 'IMAGE_URL_UNAVAILABLE');
    return { fileId, url: urls[fileId] };
  }

  return {
    async prepare(actor) {
      if (!getStorageEnv || !getStorageEnv() || !downloadImage) fail('图片上传接口未就绪，请重新部署 catalog 云函数', 'IMAGE_UPLOAD_UNAVAILABLE');
      const uploadId = `upload_${randomUUID().replace(/-/g, '')}`;
      const cloudPath = `activity-step-staging/${actor.userId}/${randomUUID()}`;
      const time = now();
      await store.create('catalog_images', {
        _id: uploadId, kind: 'step_upload', status: 'pending', uploaded_by: actor.userId,
        cloud_path: cloudPath, created_at: time, expires_at: new Date(time.getTime() + UPLOAD_TTL_MS),
      });
      return { uploadId, cloudPath };
    },

    async complete(event, actor) {
      const uploadId = id(event.uploadId, '图片上传标识');
      const ticket = await store.transact(async (tx) => {
        await requireAdmin(tx, actor);
        const current = await tx.get('catalog_images', uploadId);
        owned(current, actor);
        if (current.status === 'completed') return current;
        pending(current);
        const fileId = stagingFile(current, event.fileId);
        const bound = { ...current, staging_file_id: fileId };
        await tx.put('catalog_images', uploadId, bound);
        return bound;
      });
      if (ticket.status === 'completed') return result(ticket.completed_file_id);
      pending(ticket);
      // 客户端可以继续写自己的暂存文件，正式图片必须另存到服务端目录。
      const { buffer, extension } = readImageBuffer(await downloadImage(ticket.staging_file_id));
      let candidate;
      let accepted = false;
      try {
        candidate = await uploadImage({ cloudPath: `activity-steps/${actor.userId}/${randomUUID()}.${extension}`, fileContent: buffer });
        if (!candidate) throw new Error('Image storage returned no file ID');
        const image = await result(candidate);
        const selected = await store.transact(async (tx) => {
          await requireAdmin(tx, actor);
          const current = await tx.get('catalog_images', uploadId);
          owned(current, actor);
          if (current.status === 'completed') return current.completed_file_id;
          pending(current);
          const time = now();
          await tx.put('catalog_images', hash(candidate), { file_id: candidate, uploaded_by: actor.userId, created_at: time });
          await tx.put('catalog_images', uploadId, { ...current, status: 'completed', completed_file_id: candidate, completed_at: time });
          return candidate;
        });
        accepted = selected === candidate;
        if (!accepted) await remove(candidate);
        await remove(ticket.staging_file_id);
        return accepted ? image : result(selected);
      } catch (error) {
        // 事务响应丢失时，先核对登记，避免删除已经提交成功的正式文件。
        if (candidate && !accepted) {
          try { if (!(await store.get('catalog_images', hash(candidate)))) await remove(candidate); }
          catch (_) { logger.error('catalog:image_registration_unknown'); }
        }
        throw error;
      }
    },

    async cancel(event, actor) {
      const uploadId = id(event.uploadId, '图片上传标识');
      const ticket = await store.transact(async (tx) => {
        await requireAdmin(tx, actor);
        const current = await tx.get('catalog_images', uploadId);
        owned(current, actor);
        if (current.status !== 'pending') return current;
        const cancelled = { ...current, status: 'cancelled', staging_file_id: event.fileId
          ? stagingFile(current, event.fileId) : current.staging_file_id || '' };
        await tx.put('catalog_images', uploadId, cancelled);
        return cancelled;
      });
      await remove(ticket.staging_file_id);
      return { cancelled: ticket.status !== 'completed' };
    },
  };
}

module.exports = { createStepUploads };
