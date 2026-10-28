# HM nova MiniMax-H3 接入记录

核对日期：2026-10-28。来源：用户提供的定价截图、https://openaivideo.top/ 登录后的当前广场、视频文档和生成页模型选择器。没有发起付费生成或修改生产数据。

## 身份与售价

| 项目 | 值 |
| --- | --- |
| 本站 API model | `MiniMax-H3` |
| 本站展示名 | `MiniMax-H3 933` |
| 上游 model | `MINIMAXH3 9-3-3`（保留空格） |
| 上游 channel | `nova`（每次提交强制携带） |
| 本站售价 | 720p ¥1.50/条；2k ¥2.20/条 |
| 上游展示成本 | 720p 0.70 积分；2k 1.20 积分，不用于覆盖售价 |

截图中的「映射名称」MiniMax-H3 不等于请求 ID。当前生成页选择器公开 DOM 的 `data-sku` 为 `nova:vid:MINIMAXH3 9-3-3`，显示名为 SD MiniMax-H3。文档要求使用同一个渠道下的模型 ID，不能拿显示名或顶层其他渠道模型与 nova 混配。

## 参数与协议依据

- 当前型号选择器：4–15 秒，720p/2k，首尾帧/混合素材；混合素材面板明确显示最多图 9 / 视频 3 / 音频 3。
- 比例选择器提供 21:9、16:9、4:3、1:1、3:4、9:16，以及 adaptive；当前视频文档明确要求不要传 adaptive，因此本站只提供上述六个固定比例。
- JSON `POST /v1/videos/generations`，字段 `model/channel/prompt/ratio/duration/video_resolution/function_mode`。普通参考采用 `materials: [{type,name,url}]`，保留素材顺序与标记。专用帧用 `first_frame_url/end_frame_url`，不与普通素材混用，不支持 multi_frame 模式。
- 成功受理为 HTTP 202 + task_id；原任务 `GET /v1/tasks/{task_id}`；成功使用 result_urls，失败读取渠道实际原因。沿用既有 HM 提交判定、回执、轮询和预扣事务，不增加提示词本地长度拦截。
- 文档公布 API 根地址为 https://openmvideo.top；部署仍使用管理员配置的 HM 地址和 Key，不在本次接入中自动替换其他模型的连接配置。
- 本地现存 HM Key 在当前文档 API 上返回 401，不能用它完成鉴权目录或生成验证。规格证据来自已登录页面，不能将本次模拟测试称为真实生成验证。

## 实际调用链与改动

- `shared/hmStudioVideo.ts` 提供映射、能力、售价和校验；`server/db/seed.ts` 读取该表完成模型/价格初始化，`hmStudioCatalogService.ts` 在后台「同步模型」读取同一映射。新增默认停用；已有管理员价格、开关和旧型号不覆盖。
- 网站 `routes/video.ts` 校验后预扣、入队；外部 API `routes/v1.ts` 使用同一规格校验与 HM 队列；批量通过 videoBatches 的报价/校验及 videoBatchService 调用网站生成入口。
- `enqueueHmStudioVideoContent` 占用提交并调用 `buildHmStudioVideoPayload`，新旧 nova 分别映射各自 ID；即使旧队列携带 default/lumen，也强制新型号走 nova。
- 受理后先保存 videoId 和独立回执，再由 `resumePollForTask` 查原任务并本地保存。失败走既有幂等退款；提交不确定不重发；查询异常继续查询原任务。
- 规格路由 `specificationAdapters.ts` 支持新 nova 并校验真实参数；`modelInputPresets.ts`、画布、视频页、批量页及管理价格控件使用共享规格。

## 验证

模拟覆盖：同步/重启不覆盖管理员售价与开关；新模型停用时不预扣；网站/API 错误参数在扣费前拒绝；两档报价与批量预扣/取消幂等；实际网站/API 发送精确 ID + nova + 15 份素材；明确拒绝按售价退款；未知受理恢复不重发；受理 ID 先保存、查询暂时失败后原任务成功且只扣一次；首尾帧和混合素材不丢失；旧 nova/lumen 保持原映射。

验证结果：

- 第一组：`hmStudioAdapter`、`hmStudioVideoModels`、`hmStudioCatalogIntegration`、`hmSubmissionRace`、`modelSpecificationRouting`，189 项通过。
- 第二组：`hmSubmissionRace`（新增成功回执/临时查询异常用例）、`hmStudioJson`、`hmStudioSubmission`、`hmStudioReferenceService`、`hmTimeoutRecoveryService`、`hmStudioOverflowChannelService`、`pricingResolution`、`videoBatchRoutes`、`videoBatchStore`、`canvasVideoInputs`，126 项通过；与第一组有重叠，不相加作为独立测试数。
- 最后调整规格校验选用原执行型号后的定向复核：5 项 HM/nova/H3 测试通过。
- `npm run lint`、`npm run build`、`git diff --check` 通过。构建仍提示已有的大文件分包警告。

尚未部署，尚未真实付费生成。更新部署后需在后台启用新模型，才会向用户显示。
