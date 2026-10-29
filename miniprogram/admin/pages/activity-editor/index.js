const { verifyAdministrator } = require('../../../services/identity');
const { callCatalog, mutate, displayDate } = require('../../../services/catalog');
const { prepareStepImage } = require('../../services/step-images');
const { uploadStepFile } = require('../../services/step-upload');

const emptyStep = () => ({ text: '', images: [], image_urls: [], file_list: [] });

const emptyActivity = () => ({
  platform_id: '', title: '', category: 'points', frequency: 'daily', keywords: '', activity_info: '',
  entry_type: 'instructions', target_address: '', search_keyword: '', participation_steps: [emptyStep()],
  validity_type: 'ongoing', start_at: '', end_at: '',
});
const labels = {
  category: ['积分奖励', '实物礼品', '优惠权益'], frequency: ['每日任务', '一次性'],
  entry_type: ['网页', '目标小程序', '平台内搜索', '人工步骤'], validity_type: ['固定期限', '长期开展', '截止时间未知'],
};
const values = {
  category: ['points', 'gift', 'benefit'], frequency: ['daily', 'once'],
  entry_type: ['web', 'mini_program', 'platform_search', 'instructions'], validity_type: ['fixed', 'ongoing', 'unknown'],
};
function inputValue(value) { return value instanceof Date ? value.toISOString() : value || ''; }
function editable(item, existingSteps = []) {
  const urls = new Map(existingSteps.flatMap((step) => (step.images || []).map((file, index) => [file, (step.image_urls || [])[index]])));
  const steps = (item.participation_steps || []).map((step) => typeof step === 'string' ? { text: step, images: [] } : step);
  return { ...emptyActivity(), ...item,
    activity_info: item.activity_info || [item.reward_summary, item.eligibility, item.rules_note].filter(Boolean).join('\n'),
    target_address: item.target_address || item.entry_url || '',
    start_at: inputValue(item.start_at), end_at: inputValue(item.end_at),
    participation_steps: steps.length ? steps.map((step) => {
      const images = step.images || [];
      const imageUrls = step.image_urls || images.map((file) => urls.get(file) || '');
      return { ...step, images, image_urls: imageUrls, file_list: images.map((fileId, index) => ({
        fileId, url: imageUrls[index] || '', isImage: true, status: imageUrls[index] ? 'done' : 'failed', message: imageUrls[index] ? '' : '预览暂不可用',
      })) };
    }) : emptyActivity().participation_steps,
  };
}

Page({
  data: {
    authorized: false, loading: true, saving: false, working: false, error: '', activity: emptyActivity(),
    activityId: '', platforms: [], platformIndex: 0, platformNames: [], labels,
    categoryIndex: 0, frequencyIndex: 0, entryTypeIndex: 3, validityTypeIndex: 1, startDate: '', endDate: '',
    evidence: '', reason: '', uploading: false, dirty: false, entryTested: false,
    imageSizeType: ['compressed'],
  },
  onLoad(query) { this._activityId = query.id || ''; },
  async onShow() {
    this._visible = true;
    const version = this._version = (this._version || 0) + 1;
    this.setData({ authorized: false, loading: true, error: '' });
    try {
      await verifyAdministrator();
      if (!this._visible || version !== this._version) return;
      if (this._loaded) { this.setData({ authorized: true, loading: false }); return; }
      const readPlatforms = async () => {
        let items = [];
        let cursor = '';
        do {
          const page = await callCatalog('platforms', { cursor });
          items = items.concat(page.items);
          cursor = page.cursor;
        } while (cursor);
        return items;
      };
      const [platformResult, detail] = await Promise.all([
        readPlatforms(), this._activityId ? callCatalog('adminDetail', { id: this._activityId }) : Promise.resolve(null),
      ]);
      if (!this._visible || version !== this._version) return;
      const platforms = platformResult;
      const activity = detail ? editable(detail.item) : emptyActivity();
      this._loaded = true;
      this.setData({ authorized: true, loading: false, activity, activityId: this._activityId, platforms,
        platformNames: platforms.map((item) => `${item.name}${item.status === 'disabled' ? '（已停用）' : ''}`),
        platformIndex: Math.max(0, platforms.findIndex((item) => item._id === activity.platform_id)),
        categoryIndex: Math.max(0, values.category.indexOf(activity.category)),
        frequencyIndex: Math.max(0, values.frequency.indexOf(activity.frequency)),
        entryTypeIndex: Math.max(0, values.entry_type.indexOf(activity.entry_type)),
        validityTypeIndex: Math.max(0, values.validity_type.indexOf(activity.validity_type)),
        startDate: activity.start_at ? displayDate(activity.start_at) : '', endDate: activity.end_at ? displayDate(activity.end_at) : '',
      });
    } catch (error) { if (this._visible && version === this._version) this.setData({ error: error.message, loading: false }); }
  },
  onHide() { this._visible = false; this._version += 1; this.setData({ authorized: false }); },
  onUnload() { this._unloaded = true; },
  onInput(event) { this.setData({ [`activity.${event.currentTarget.dataset.field}`]: event.detail.value, dirty: true }); },
  onStepInput(event) { this.setData({ [`activity.participation_steps[${event.currentTarget.dataset.index}].text`]: event.detail.value, dirty: true }); },
  onAddStep() {
    if (this.data.uploading || this.data.saving || this.data.working) return;
    if (this.data.activity.participation_steps.length >= 20) { this.setData({ error: '最多添加 20 步' }); return; }
    this.setData({ 'activity.participation_steps': this.data.activity.participation_steps.concat([emptyStep()]), dirty: true });
  },
  onRemoveStep(event) {
    if (this.data.uploading || this.data.saving || this.data.working) return;
    const steps = this.data.activity.participation_steps.filter((_, index) => index !== Number(event.currentTarget.dataset.index));
    this.setData({ 'activity.participation_steps': steps.length ? steps : emptyActivity().participation_steps, dirty: true });
  },
  async onImagesSelected(event) {
    if (this.data.uploading || this.data.saving || this.data.working || this._unloaded) return;
    const index = Number(event.detail.name);
    const step = this.data.activity.participation_steps[index];
    const selected = Array.isArray(event.detail.file) ? event.detail.file : [event.detail.file];
    const total = this.data.activity.participation_steps.reduce((sum, item) => sum + item.file_list.length, 0);
    if (!step || !selected.length || step.file_list.length + selected.length > 3 || total + selected.length > 9) {
      this.setData({ error: '每步最多 3 张图片，每个活动最多 9 张' }); return;
    }
    const files = selected.map((file) => ({ url: file.url, localPath: file.url, isImage: true, status: 'uploading', message: '压缩中' }));
    step.file_list = step.file_list.concat(files);
    this.setData({ [`activity.participation_steps[${index}].file_list`]: step.file_list, dirty: true });
    return this.uploadStepFiles(index, files);
  },
  async uploadStepFiles(index, files) {
    const step = this.data.activity.participation_steps[index];
    this.setData({ uploading: true, error: '' });
    try {
      // 相册返回时 onShow 的权限核验可能尚未结束，不能直接丢弃选图回调。
      await verifyAdministrator();
      for (const file of files) {
        if (this._unloaded) return;
        let prepared;
        const update = (message) => {
          if (this._unloaded) return;
          file.message = message;
          this.setData({ [`activity.participation_steps[${index}].file_list`]: step.file_list });
        };
        file.status = 'uploading';
        update('压缩中');
        try {
          prepared = await prepareStepImage(this, file.localPath);
          if (this._unloaded) return;
          const image = await uploadStepFile(prepared.filePath, update);
          if (this._unloaded) return;
          Object.assign(file, { fileId: image.fileId, url: image.url, status: 'done', message: '', localPath: '' });
        } catch (error) {
          if (this._unloaded) return;
          Object.assign(file, { status: 'failed', message: '上传失败，点击重试' });
          this.setData({ error: error.message || '图片上传失败，请重试' });
        } finally { if (prepared) prepared.cleanup(); }
        if (this._unloaded) return;
        step.images = step.file_list.filter((item) => item.fileId).map((item) => item.fileId);
        step.image_urls = step.file_list.filter((item) => item.fileId).map((item) => item.url);
        this.setData({ [`activity.participation_steps[${index}]`]: step, dirty: true });
      }
    } catch (error) {
      if (!this._unloaded) {
        files.forEach((file) => Object.assign(file, { status: 'failed', message: '身份核验失败' }));
        this.setData({ [`activity.participation_steps[${index}].file_list`]: step.file_list, error: error.message || '身份核验失败，请重试' });
      }
    } finally { if (!this._unloaded) this.setData({ uploading: false }); }
  },
  onImageSelectError(event) {
    const detail = event.detail || {};
    const message = String(detail.errMsg || detail.message || '');
    if (/cancel/i.test(message)) return;
    this.setData({ error: /auth|permission|authorize/i.test(message) ? '无法访问相册，请在微信设置中允许相册访问' : '选择图片失败；开发者工具不支持的 HEIC 请在 iPhone 微信中选择' });
  },
  onDeleteStepImage(event) {
    if (this.data.uploading || this.data.saving || this.data.working) return;
    const index = Number(event.detail.name);
    const step = this.data.activity.participation_steps[index];
    const files = step.file_list.filter((_, position) => position !== Number(event.detail.index));
    this.setData({ [`activity.participation_steps[${index}]`]: { ...step, file_list: files,
      images: files.filter((file) => file.fileId).map((file) => file.fileId), image_urls: files.filter((file) => file.fileId).map((file) => file.url),
    }, dirty: true });
  },
  onStepImagePreview(event) {
    if (this.data.uploading || this.data.saving || this.data.working || !this.data.authorized) return;
    const index = Number(event.detail.name);
    const file = this.data.activity.participation_steps[index].file_list[event.detail.index];
    if (file.status === 'failed' && file.localPath) return this.uploadStepFiles(index, [file]);
    if (file.url) wx.previewImage({ current: file.url, urls: this.data.activity.participation_steps[index].image_urls.filter(Boolean) });
  },
  onEvidenceInput(event) { this.setData({ evidence: event.detail.value }); },
  onEntryTestedChange(event) { this.setData({ entryTested: event.detail.value.includes('tested') }); },
  onReasonInput(event) { this.setData({ reason: event.detail.value }); },
  onDateChange(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    if (field === 'start_at') this.setData({ startDate: value, 'activity.start_at': `${value}T00:00:00+08:00`, dirty: true });
    if (field === 'end_at') this.setData({ endDate: value, 'activity.end_at': `${value}T23:59:59+08:00`, dirty: true });
  },
  onClearDate(event) {
    const field = event.currentTarget.dataset.field;
    if (field === 'start_at') this.setData({ startDate: '', 'activity.start_at': '', dirty: true });
    if (field === 'end_at') this.setData({ endDate: '', 'activity.end_at': '', dirty: true });
  },
  onPlatformChange(event) { const index = Number(event.detail.value); this.setData({ platformIndex: index, 'activity.platform_id': (this.data.platforms[index] || {})._id || '', dirty: true }); },
  onOptionChange(event) {
    const field = event.currentTarget.dataset.field;
    const index = Number(event.detail.value);
    if (!values[field] || !Number.isInteger(index) || !values[field][index]) return;
    const indexFields = { category: 'categoryIndex', frequency: 'frequencyIndex', entry_type: 'entryTypeIndex', validity_type: 'validityTypeIndex' };
    const update = { [indexFields[field]]: index, [`activity.${field}`]: values[field][index], dirty: true };
    if (field === 'validity_type' && values[field][index] !== 'fixed') { update['activity.end_at'] = ''; update.endDate = ''; }
    if (field === 'entry_type' && values[field][index] !== this.data.activity.entry_type) update['activity.target_address'] = '';
    this.setData(update);
  },
  async onSave() {
    if (this.data.saving || this.data.working || this.data.uploading || !this.data.authorized) return;
    if (this.data.activity.participation_steps.some((step) => step.file_list.some((file) => !file.fileId))) {
      this.setData({ error: '请重试或删除上传失败的图片后再保存' }); return;
    }
    const activity = { ...this.data.activity };
    if (!activity.platform_id && this.data.platforms.length) activity.platform_id = this.data.platforms[this.data.platformIndex]._id;
    this.setData({ saving: true, error: '' });
    try {
      const result = await mutate('saveActivity', { ...(this.data.activityId ? { id: this.data.activityId, expectedRevision: activity.revision } : {}), input: activity });
      this.setData({ activity: editable(result.item, activity.participation_steps), activityId: result.item._id, error: '', dirty: false, entryTested: false });
      this._activityId = result.item._id;
      wx.showToast({ title: '活动已保存', icon: 'success' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  async onVerify() {
    if (!this.data.authorized || this.data.saving || this.data.uploading) return;
    if (this.data.dirty) { this.setData({ error: '请先保存表单修改，再记录核验' }); return; }
    if (!this.data.activityId || this.data.working) { this.setData({ error: '请先保存活动草稿' }); return; }
    this.setData({ working: true, error: '' });
    try {
      const result = await mutate('verifyActivity', { id: this.data.activityId, expectedRevision: this.data.activity.revision, evidence: this.data.evidence, entryTested: this.data.entryTested });
      this.setData({ activity: editable(result.item, this.data.activity.participation_steps), evidence: '', error: '' });
      wx.showToast({ title: '核验已记录', icon: 'success' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ working: false }); }
  },
  async onTransition(event) {
    if (!this.data.authorized || this.data.saving || this.data.uploading) return;
    if (this.data.dirty) { this.setData({ error: '请先保存表单修改，再变更状态' }); return; }
    const status = event.currentTarget.dataset.status;
    if (!this.data.activityId || this.data.working) { this.setData({ error: '请先保存活动草稿' }); return; }
    if (status === 'ended') {
      const confirmed = await new Promise((resolve) => wx.showModal({ title: '结束活动', content: '结束后不可恢复，请确认活动确已永久结束。', success: (result) => resolve(result.confirm) }));
      if (!confirmed) return;
    }
    this.setData({ working: true, error: '' });
    try {
      const result = await mutate('transitionActivity', { id: this.data.activityId, expectedRevision: this.data.activity.revision, status, reason: this.data.reason, confirmEnded: status === 'ended' });
      this.setData({ activity: editable(result.item, this.data.activity.participation_steps), reason: '', error: '' });
      wx.showToast({ title: status === 'published' ? '活动已发布' : status === 'paused' ? '活动已暂停' : '活动已结束', icon: 'success' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ working: false }); }
  },
  onGoBack() { wx.navigateBack(); },
});
