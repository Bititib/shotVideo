# 稳定 720P 独立入口

2026-11-03，按用户指定新增 `wd-seedance2.5-720`，映射 V6K 的 `稳定seadanco2.5-720`，初始售价 ¥6.5/条。与 KK 入口及其后台分流设置独立，不把 WD 合并成 KK 别名。

依据只读公开目录 [模型目录](https://www.v6k.top/api/pricing) 和 [统一视频 OpenAPI](https://www.v6k.top/docs/openapi-video.json)：稳定型号支持 720P、5–30 整数秒、30 图/10 音/10 视频，使用 Bearer 平台令牌提交 `POST /v1/videos`，查询 `GET /v1/videos/{id}`，下载 `GET /v1/videos/{id}/content`；状态包括 queued/in_progress/completed/failed/unknown。无独立首尾帧或新增参数的依据，不额外开放。

## 实际入口与状态/计费

- `shared/v6kStableVideo.ts` 声明公开 ID、真实上游 ID 与能力。共享上游规格解析识别公开 WD ID；画布、网站、API 参数默认值及能力保持一致。
- `v6kCatalogService.ts` 将已授权的原始稳定型号映射成 WD，严格保留允许同步的型号范围。`v6kStable720Catalog.ts` 在同步或显式启用时注册模型、规格和缺失的初始价格；不覆盖管理员的价格、名称、开关、已绑定线路或订单。新同步模型默认关闭，原启动初始化过程保持不变。
- 用户明确需要开放前台入口：附带的 `server/scripts/enableV6kStable720.ts` 先等待本容器健康检查通过，再只读查询所选渠道 `/v1/models`，确认原始稳定 ID 后，在一个事务中启用 WD 模型、规格和匹配线路，补充渠道关联。查询期间渠道/规格/模型变化则停止，不覆盖新配置；模型 ID 冲突会回滚。不调用生成，不读取或写入余额、预扣、退款、内容记录。
- 网站 `/api/video/generate`、API `/v1/videos` 及持久化批量队列使用现有 `handleSpecificationGeneration → selectModelRoutes → runVideo`。订单与预扣先保存，再占用提交；适配器发送原始稳定 ID，有效任务 ID 先保存，再处理即时终态或查询。沿用预扣报价快照、API 幂等请求绑定和原账本。
- WD 默认只有稳定线路，不配置 KK 备用；上游失败按原订单结算，超时/未知受理不重发、不因此退款。取得任务 ID 后，查询异常退避查询原任务；重启恢复继续原渠道/编号。其他入口的 KK 分流开关不影响 WD，WD 启用/停用不改变 KK。

## VPS 启用

部署此次版本后，针对当前已配置的 V6K 渠道 21 执行：

```bash
docker compose exec -T -w /app app node --import tsx server/scripts/enableV6kStable720.ts 21
```

成功后前台模型列表与公开 API 模型页显示 WD（列表缓存通常约 10 秒；客户端刷新后读取新列表）。外部 API 使用 `model: "wd-seedance2.5-720"`。若目录没有授权此型号，命令会停止并保留原配置；目录权限通过仍不代表已完成真实生成鉴权验证。

## 验证与边界

隔离数据库、模拟上游覆盖：同步与开关/价格保留，授权查询失败/配置并发变化，不修改 KK 分流及历史任务，网站/API 列表和价格一致，5/30 秒按条6.5，30图/10音/10视上限校验、同一 API 请求重试返回原任务、明确失败只退款一次、未知受理不重发、unknown/查询故障后原任务成功或失败，以及持久化批量桥接一次计费。16 个相关测试文件共 814 项通过，类型检查与前端构建通过（保留既有大分包提示）。

额外运行的 `zonghengVideoGrouping.test.tsx` 有 5 项旧下架型号相关的既有失败；已在本次修改前的 `3ab8620` 隔离工作区复现相同 5 项。未扩展修改下架入口的测试或产品行为。新 WD 的实际前台选择、素材上限、售价和提交由 `wdStableVideoPage.test.tsx` 独立验证通过；未运行全仓库测试。

本地实现与模拟验证不等于生产接单成功。本次不执行真实付费生成、生产扣退费或 VPS 部署。已有 KK 提交 401 不由此独立入口改动解决。
