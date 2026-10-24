# Megaby 视频渠道

依据用户提供的《视频接入文档.md》接入，默认地址 `https://newapi.megabyai.cc`，渠道类型 `megaby`。

## 启用

1. 服务启动时创建停用的「Megaby 视频渠道」及三个停用的视频模型；也可在后台手动添加 Megaby 渠道。
2. 在渠道管理填写该渠道的 API Key，测试连接并同步模型。
3. 为模型配置本站售价（按条或按秒）并启用模型和渠道。文档未给出价格，上游成本保持未知，不根据 `cost_credits` 推算金额。

| 上游模型 | 本站模型 ID |
| --- | --- |
| videos-standard | videos-standard |
| videos-fast | videos-fast |
| videos-mini | videos-mini |

模型同步只导入上述已知视频模型。重复同步保留管理员设置的售价、成本、模型/线路开关及自定义规格；不再授权的模型从当前渠道支持列表移除。

## 能力和协议

- `GET /v1/models`，Bearer Token 鉴权，按 `data[].id` 读取可用模型。
- `POST /v1/videos`，JSON 字段为 `model`、`prompt`、`duration`、`ratio`、`resolution`，参考素材字段必须为驼峰 `referenceImages`、`referenceVideos`、`referenceAudios`。
- 生成时长为 4–15 秒整数；画幅为 16:9、9:16、1:1；分辨率为 720p、480p。
- 最多 9 张图片、3 个视频和 3 个音频；视频总时长与音频总时长分别不得超过 15 秒。使用服务端实际探测时长，需要部署环境提供 ffprobe。
- 不支持独立首尾帧。本站上传及内联素材经既有公开参考素材服务转换为上游可访问的 HTTP/HTTPS URL。
- `GET /v1/videos/{task_id}` 查询原任务，沿用统一视频任务的 8 秒轮询间隔。识别 queued、in_progress、completed、failed。
- 完成后按 video_url、url、metadata.content_url、metadata.local_url 顺序读取结果；未附结果地址时使用 `/v1/videos/{task_id}/content`。视频自动保存至本站，避免依赖上游 24 小时缓存。
- 下载仅向原任务的准确 content 地址发送 API Key；外部媒体及同站其他路径不附带密钥。下载最多跟随 5 次 HTTP/HTTPS 跳转，每次重新确定是否发送密钥；过期媒体链接可回退到原任务的 content 接口。

独立的 Megaby 错误策略保留原生 `error.code`、`error.message` 和 HTTP 状态；任务失败退还预留费用，查询失败不视为生成失败。提交结果未知时保留待核实记录，不自动重提。进程重启和管理员恢复均查询已有任务，不再次创建付费任务。

## 验证

新增测试覆盖模型同步、协议字段、素材数量和时长、任务状态、上游错误、扣费/退款、提交未知状态、恢复和下载鉴权。未配置真实 API Key 时使用模拟上游响应验证，不发起付费生成。

## 本次修正与状态依据

基于 e48b5af 主线迁移，仅引入 Megaby 所需变更，保留 HUSS/V6K/HM/snumom 的独立规则。

- 对外 ID 与显示名称统一为 videos-standard、videos-fast、videos-mini；内部线路 ID 可带渠道标识。其他产品已占用同名时明确报错，不覆盖定价或擅自合并。
- 提交先保存 task_id/id，再处理 error。同一响应两个 ID 冲突为提交未知；有 ID 的请求只查询原任务。
- 提交直接返回 failed，或无受理证据且带错误体的明确客户端拒绝，结束并幂等退款。2xx 下已知素材、参数、审核错误独立判为拒绝；不将这套码表用于其他渠道。
- HTTP 200 的 failed 查询响应属于任务失败。查询错误与下载错误保留原 ID 和预扣，不重发生成。
- server_error、网络中断、非 JSON、缺 ID、受理状态冲突不可仅凭文字断言失败。文档没有无 ID 回执查询或幂等 POST 保证，不能承诺这些情况自动恢复；需补录原任务 ID 后查询。
- 网站 /api/video/generate、外部 /v1/videos 和批量任务都进入规格生成服务，提交占用、ID 保存、退款使用现有账本路径。管理员恢复走 videoRecoveryService，后台重启走 resumeSpecificationTasks。

尚未使用真实 Key 联调，没有执行生产部署或付费生成。

验证记录：12 个相关测试文件共 283 项回归用例通过（最终补充的客户端拒绝及诊断编号用例已复跑），类型检查和生产构建通过。测试使用隔离内存账本和模拟上游，包括明确拒绝退款、即时失败回执、有 ID 且带 error、ID 冲突、断线不重发、恢复查询、模型重名冲突、下载重定向鉴权与其他渠道回归；不等同于真实上游联调。
