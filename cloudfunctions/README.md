# 云函数目录

当前提供 `identity` 与 `catalog` 云函数源码，包含身份/管理员核验、平台和活动管理、内容复核发布、公开目录分页、详情和浏览记录，以及 0.5.0 的个人清单、手动完成与历史；本地代码不代表新版已经部署。步骤见 `docs/身份服务部署指引.md`。

云函数统一使用 JavaScript。身份来自 `cloud.getWXContext()`，角色来自受控 `admin_bindings`；管理写入由服务端事务保护，并记录审计。目标环境需实测 `runTransaction` 和所有读写 API；目录函数遇到不支持事务时拒绝写入。投稿与反馈处理仍待实现。

0.5.0 在 `catalog` 增加 `joinActivity`、`removeActivity`、`completeCheckin`、`myCheckins`、`checkinHistory`。写请求使用 `requestId`，完成额外携带服务端显示的 `expectedDate`；业务日期为北京时间，用户/关系/活动/平台的执行依赖在事务中以内部 `_checkin_guard` 写入同步，发生并发变更后重试核验，不修改运营 `revision` 或 `updated_at`。SDK 的实际写冲突和重试行为必须在目标环境验证；不具备事务能力时不降级。

关系和完成文档使用确定性 ID；唯一索引仍须按指引补齐。个人请求结果以 `ur_` 前缀存入既有 `catalog_requests`，与管理员的 `r_` 命名空间隔离。当前不自动清理幂等结果，不要配置该集合 TTL。历史按完成时间和 `_id` 倒序双键分页，快照展示仍服从最新内容限制。已运行 0.4.0 时，只需更新 `catalog`、核对集合/索引并编译前端，`identity` 统计接口无需修改或重复部署。

活动简化表单、图文步骤及短链更新需重新部署 `catalog`，使用全客户端禁读写的 `catalog_images` 集合。最新客户端使用 `prepareStepImageUpload` 申请路径、`wx.cloud.uploadFile` 原生上传暂存区、`completeStepImageUpload` 校验文件所属环境/路径并登记正式图片，失败时调用 `cancelStepImageUpload` 清理暂存区；三个接口均要求管理员。原 `uploadStepImage` Base64 接口保留兼容，上一版普通 wx.uploadFile 前端需同步更新。保存步骤核对正式登记，读取生成临时链接。原图不设业务大小限制，成品校验 1MB，每步最多 3 张、活动最多 9 张。核验时 `entryTested=true` 记录管理员实际真机验证小程序跳转，内容修改会重置。详见部署指引。

HEIC/HEIF 由 Vant Uploader 与微信压缩接口选择/处理，原生结果不符合格式或体积目标时回退 Canvas JPEG；云函数仍按文件头只接受 JPG/PNG/WebP。新版仅直接依赖 `wx-server-sdk@3.0.1`，不再申请预签名。须重新部署 catalog（云端安装依赖）、按 `catalog/storage.rules.json` 设置云存储规则并重新编译；无需新增集合、服务器或域名白名单。规则只允许客户端写入本人暂存文件，正式图片与数据库权限不放开。原 iPhone 文件必须真机验收，组件本身不提供桌面 HEIC 解码器。

客户端压缩目标 900KB，整个文件不再传入云函数 JSON。云端下载暂存文件核对格式和 1MB 成品大小后另存 `activity-steps/`，事务登记前再次核验权限；暂存签名不能覆盖正式文件。文件选择、压缩、签名申请、直传和云端校验分阶段提示与记录。建议将 catalog 的执行超时配置为 60 秒；原图解码与内存仍受微信和设备能力约束。
