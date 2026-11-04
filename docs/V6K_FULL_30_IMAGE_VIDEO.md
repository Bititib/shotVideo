# 满血 30 图视频入口

2026-11-04。用户指定前台和 API 名称 `seadanco2.5-720-30`、售价 ¥5.8/条；原始上游 ID 为 `稳定极速seadanco2.5-720-30图`，不要与另一款 `稳定极速seadnco2.5-720` 混用。

协议依据：[V6K 模型目录](https://www.v6k.top/api/pricing)、[统一视频 OpenAPI](https://www.v6k.top/docs/openapi-video.json)。只读核对目录中原始 ID 的说明为“30图/720P/5-30秒/关闭音和视 速度快满参满血”，使用 `openai-video`。本入口只开放最多 30 张图片参考、720P、5–30 整数秒、每次一条；不接受音频/视频参考或独立首尾帧。没有额外“满血”请求开关的协议依据，因此不添加虚构参数。“满血”沿用型号说明，不构成质量或完成时间保证。

## 实际执行与数据范围

- `shared/v6kFullReferenceVideo.ts` 保存独立 ID、默认描述和输入限制，规格解析、画布、网站与 API 使用同一能力。网站与 API 对外都显示用户指定名称，内部提交原始上游 ID。不加入 KK 分流或 WD 别名。
- `v6kCatalogService.ts` 仅允许同步明确指定的原始 ID，将它映射至独立入口并创建缺失的按条5.8价格。`v6kFull720Catalog.ts` 保留已有管理员描述、价格、启用状态和线路开关。普通同步默认关闭新增入口，不更改其他模型、历史订单或资金。
- 提供显式启用脚本 `server/scripts/enableV6kFull720.ts`。先等待本容器 `/api/health`，再用选中渠道密钥只读查询 `/v1/models`，确认此精确上游 ID 后，事务内创建/启用本入口的模型、规格、匹配线路及渠道关联。渠道/配置在查询期间变化即停止，冲突回滚；不读取或写入订单、余额和预扣退款表。不执行真实生成。
- 网站 `/api/video/generate`、API `/v1/videos` 和批量桥接走 `handleSpecificationGeneration → specificationRequest/selectModelRoutes → 报价快照/订单/预扣 → runVideo → 提交占用 → submitSpecificationVideo`。有任务 ID 先持久化原渠道和编号，再处理即时终态/查询；沿用现有 API 请求去重与账本，失败仅退款一次。
- 检查到现有公共提交路径可能忽略 `videos` 等别名，新增入口在预扣前明确拒绝所有已核对的视频/音频别名与不支持的首尾帧输入；图片别名按真实图片数组计数，不静默丢弃或缩减素材。其他型号保留原解析规则。
- `pollVideo`、`resumeSpecificationTasks` 及 V6K 原任务恢复只查询/保存原结果；unknown、超时或查询故障不会再次生成，不据此退款。普通上游明确拒绝与已受理任务失败进入现有终态结算，保留具体私有诊断和有效任务 ID；对外错误按最新主线隐私规则脱敏。

## VPS 更新与启用

```bash
cd /opt/shotVideo && git pull --ff-only origin main && docker compose up -d --build --no-deps app && docker compose exec -T -w /app app node --import tsx server/scripts/enableV6kFull720.ts 21
```

最后一步只检查渠道21的型号权限并启用此入口。授权成功不等于真实生成验证通过；启用后等待约10秒并刷新前台或公开模型页。现有管理员改价不被启用脚本覆盖。

## 验证范围

隔离数据库和模拟上游验证真实网站/API/批量入口：5秒、30秒按条5.8；30张图片完整到达上游；31图、视频/音频各别名、错误清晰度、无效时长与冲突时长在扣费前拒绝；原始错误、即时失败、unknown与查询错误后成功/失败、API重试不重复生成或扣退款；同步不引入近似名称型号，不覆盖 KK/WD、历史任务、管理员价格和开关。前台选择与画布能力单独验证。

本次21个相关测试文件共889项通过，`npm run lint` 与 `npm run build` 通过；构建保留原有大分包提示，UI测试环境保留已有 `scrollTo` 提示。未运行全仓库测试。此前 WD 接入记录中已复现的旧下架型号分组测试问题不在本次修改范围，未改动对应测试或重新开放旧型号。

未进行真实付费生成、生产退款或 VPS 部署。之前 #15052 的保存流程不属于此新增模型改动，未在此修复或改写订单。
