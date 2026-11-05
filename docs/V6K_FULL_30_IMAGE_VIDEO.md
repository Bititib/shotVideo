# 极速 720P 音视频参考入口

2026-11-05：按用户要求，将此前图片专用的上游替换为支持音视频参考的型号。网站和 API 入口继续使用 `seadanco2.5-720-30`，本站默认售价仍为 ¥5.8/条，5–30 秒价格相同。仅改变新请求的能力与映射，不迁移历史订单的上游编号或计费快照。

## 核对依据

只读获取 [V6K 模型目录](https://www.v6k.top/api/pricing) 及 [统一视频 OpenAPI](https://www.v6k.top/docs/openapi-video.json)。新上游准确 ID 为 **`稳定极速seadnco2.5-720`**（`seadnco` 拼写按上游原文），目录描述为“30图10音10视/720P/5-30秒/极速”，端点类型为 `openai-video`。

原上游 `稳定极速seadanco2.5-720-30图` 的目录明确注明关闭音和视，现从同步白名单及新任务目录移除。只保留其历史规格解析，不创建另一前台入口。没有独立首尾帧或额外“满血”开关的协议依据，不新增这些参数；不保证实际完成耗时。

新规格为最多30张图片、10个视频、10段音频，720P、5–30整数秒，每次一条。POST `/v1/videos` 使用原渠道 Bearer Key，发送 `model/prompt/seconds/ratio/resolution/images/videos/audios`。有有效任务编号先保存，原任务查询状态包括 `unknown`。不改变已有 V6K 状态判定、退避、API 去重或账本规则。

## 迁移与实际调用链

- `shared/v6kFullReferenceVideo.ts`、`shared/zonghengVideo.ts` 和 `modelInputPresets.ts` 提供网站、API、画布使用的统一能力。更新描述为 `30图10音10视/720P/5-30秒/极速/按条计费`。
- `v6kCatalogService.ts → ensureV6kFull720Model` 只在当前渠道的鉴权模型目录包含新精确 ID 后绑定。原图片线路就地替换，保留原线路开关、优先级及成本配置；规格的旧音视频上限升为10。渠道原映射也在同一事务中替换。已重启而归档旧关联的情况下，授权后重新绑定并更新遗留规格。
- 普通同步不启用被管理员停用的模型/规格，不覆盖既有价格、名称或自定义描述；仅替换已知的原默认描述。重复同步不反复覆盖管理员后续调整。全新入口默认停用。其他自定义上游映射冲突会回滚，不静默覆盖。
- 显式启用脚本 `server/scripts/enableV6kFull720.ts` 等待本容器健康，再只读 GET `/v1/models` 核对权限，事务内替换并开启指定入口。查询期间渠道或配置变化即停止。输出实际映射、能力、描述及价格；不向上游发生成 POST，不更新订单、余额或预扣退款表。
- 网站 `/api/video/generate`、API `/v1/videos`、批量队列内部桥接均调用 `handleSpecificationGeneration → specificationRequest/selectModelRoutes → 报价快照/订单/预扣 → runVideo → 提交占用 → submitSpecificationVideo`。
- `specificationRequest` 现在完整解析此型号的 `videos/video/reference_videos/reference_video/video_urls/video_url/video_refs/reference_video_urls` 和对应音频别名，使用同一素材计数与冲突检查。超限、重复字段、格式错误及不支持的首尾帧在下单预扣前拒绝；不丢弃素材。图片和 `duration_seconds` 原解析保持。
- `pollVideo/resumeSpecificationTasks` 使用订单已保存的原渠道、协议快照和任务编号查询。旧图片任务不改成新上游、不重发生成、不因换型号另扣/退款；原任务明确失败按原预扣退款一次，查询异常/unknown 保留原任务继续查询。

## VPS 更新并替换启用

```bash
cd /opt/shotVideo && git pull --ff-only origin main && docker compose up -d --build --no-deps app && docker compose exec -T -w /app app node --import tsx server/scripts/enableV6kFull720.ts 21
```

末步只读核验渠道21的新型号权限后修改模型配置，不真实生成。需要执行完整命令：仅拉代码/重建不会替代生产数据库中的规格启用操作。成功输出应包含新 `upstreamModel`、三个启用标志为 `true`、素材上限30/10/10，以及 `per_call`、`input_price: 5.8`。已有管理员价格调整会保留。等待约10秒后刷新前台和公开 API 模型页。

## 验证记录

隔离数据库及模拟上游覆盖网站/API/批量真实入口：5与30秒均按条5.8；30图10视频10音频完整发送；所有支持的音视频别名与 `duration_seconds`；超限、冲突、无效规格在预扣前拒绝；明确拒绝/即时失败退款、unknown及查询异常后查回原任务；API重试仅返回原任务。新增迁移测试核对原价格、管理员开关/描述、旧任务ID、受理回执、预扣记录不被改写，并模拟启动清理后替换，再恢复旧图片任务成功/失败，无重复生成或扣退款。网站真实组件和画布验证支持音视频及对应上限。

21个相关测试文件共896项通过，`npm run lint` 与 `npm run build` 通过。构建保留已有大分包提示，UI测试环境仍有已有 `scrollTo` 提示。未运行全仓库测试，也未进行真实付费生成、生产退款或 VPS 部署。此前已记录的旧下架型号分组测试失败不在本次修改范围；#15052 保存流程也不属于此型号替换。
