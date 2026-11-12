# Image2Pro 图片与视频接入

## 实现状态

2026-11-11，在 `codex/image2pro-integration` 分支完成本地接入。基线为 GitHub main `a0cb21589f8aa8dfb124569f300ac5b857b2954e`，工作目录 `scratch/image2pro-integration`。原主目录和旧发布目录的未提交改动均保留。

代码未提交或推送，未部署，未使用真实 Key 拉取模型或执行付费生成。

## 接入范围

后台新增 Image2Pro 渠道类型，默认地址 `https://api.image2pro.top/v1`。连接测试读取带鉴权的模型目录；同步只处理 image/video，对外使用上游公开 ID，不添加渠道前缀。新模型默认停用，保留已有售价、激活状态、规格、映射和渠道关联；同名但不同产品归属会明确报错。

图片使用 `POST /images/tasks` 和原任务查询，单次请求 n=1。多个请求不共用编号。参考图经网站已有素材发布机制处理；仅在模型公布参考图上限或管理员明确配置后开放。未公布比例、清晰度时采用 auto，表示不发送该参数、使用上游默认。未开放蒙版及原生多图任务；单图请求若意外返回多个结果会保留原任务待核对，不丢弃其他结果后结算。

视频支持：

- 标准媒体 v1：按 `metadata.media_contract=1` 发送专用请求头，使用 duration/images/ratio/resolution，读取 metadata.url。
- Veo/Omni：按公开能力字段和 durations 验证，使用 reference_images/aspect_ratio，支持模型明确允许的普通参考图和首尾帧；Quality 禁止普通参考图，Omni 禁止首尾帧。时长档位由实时目录决定。
- 旧版视频：模型公布 duration_min/max 才同步；图片、音频、视频和 keyframe 模式按 metadata 的明确上限和 modes 映射；H3 固定 size 不覆盖，按 60 秒查询。

未公布可确认能力的型号跳过并在同步结果中显示原因。Veo 视频续写、参考附件上传以及图片蒙版没有在此次入口开放；不静默丢素材或切换模型。

## 实际调用链

网站 `imageGen.ts` / `video.ts` 和外部 `v1.ts` 的图片、编辑、视频入口调用 `handleSpecificationGeneration`；规格路由进入 Image2Pro 专属提交/查询分支。批量服务通过内部 `/api/video/generate` 调用同一入口，并使用原批量账本。

沿用规格服务的预扣、提交锁、任务编号持久化、原结果下载、本地结算和 `resumeSpecificationTasks`。提交前保存逻辑请求编号、参数和凭据指纹；视频复用提交占用保护。有效任务编号先保存，再判断即时终态。重启恢复只查原编号，不重新 POST；凭据变化时保留原任务并提示恢复原凭据。

没有 ID 的未知受理保留具体待核实原因及请求快照，当前不自动重放，避免超过上游幂等保留期后重复收费。图片 failed/refund_pending 继续核对；本站退款和上游退款不是同一结论。查询异常保留 ID，不退款、不生成新任务；查询间隔及 Retry-After 按专属路径处理。

结果下载使用公开结果链接，图片和视频下载均不发送渠道 Key；客户端元数据移除请求快照和凭据指纹。

## 协议依据

官方文档：https://image2pro.top/api-docs

已读取快速开始、模型能力、异步图片、异步视频、Veo Lite/Fast/Quality、Omni 1.1/1.2、并发幂等、错误码章节。

- 图片 Idempotency-Key 必填；同编号同参数在任务保留期内返回原任务，冲突 409。通常保留约 48 小时，以 expires_at 为准。
- 视频同编号已有本账户任务时返回原对象，否则可能 409；通用记录约 2 小时，不能超期盲目重发。
- 图片 queued/processing/completed/failed；费用 not_charged/reserved/settled/refunded/refund_pending 分别处理。
- 视频按协议读取 url、metadata.url 或 output[0].url，未知状态不猜测终态。
- 明确结构化参数/鉴权/余额拒绝可结束订单；409、5xx、非 JSON、断线或查询失败不能单独作为退款依据。

## 验证

- Image2Pro 适配器与实际规格入口：26 项通过，包含明确拒绝、未知受理、即时失败/成功、原编号保存、图片保存失败恢复、查询中断恢复、模型同步保留管理员设置、Veo/H3 字段差异。
- 与 miniKey 适配器/入口、批量账本一起运行：68 项通过。
- TypeScript 检查通过。
- 网站生产构建通过；首次构建受系统临时目录权限影响，改用本工作区临时目录后成功。存在项目既有 chunk 大小提示。
- 扩大回归的频道初始化测试有 3 项失败；在完全未修改的 main 导出副本复跑同样为 3 项失败，涉及 operator-model 关联、MM PRO 价格及旧 Seedance 价格，未在本次接入中修改这些迁移。
- 真实模型目录、供应商账户权限、实际计费和生产生成尚未验证，不代表每个上游型号均已实测。

## 2026-11-12 文本模型扩展

模型目录现在同步 text/image/video。text 注册为本站 text 能力，使用原始公开 ID，默认停用；不创建图片/视频规格，不覆盖管理员价格或开关。同名不同产品归属仍会阻止自动合并。

已接入现有对外 `/v1/chat/completions`：普通 JSON、SSE、工具参数透传、usage 结算；Base URL 带或不带 /v1 均不会重复拼接。模型从 API 目录获取，不依据名称猜测视觉或工具能力。没有新增 Responses API，也没有将 Gemini 专用的视频分析流程改造为文本聊天。

文本 n 仅允许 1；max_tokens 和 max_completion_tokens 不可同时传入；stream 必须为布尔值。持久化的预扣编号同时作为 Idempotency-Key，不自动重试。明确参数/鉴权/余额拒绝幂等退款；409、5xx、断线、空响应、缺少正常结束标记的 SSE 和流内 error 保留待核对，不以已有 usage 猜测完整成功。错误保留渠道原因并脱敏。

验证：新增聊天实际路由/隔离账本测试 10 项通过；连同图片视频测试共 36 项通过（图片视频 26 项沿用前次回归）；原有 prechargeRoutes 27 项通过；类型检查和生产构建通过。未提交、推送、部署，也未真实付费调用。
