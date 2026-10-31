# V6K Seedance 2.0 两个销售入口

核对日期：2026-10-30。用户指定 A 型号合并、XX 单独展示，两个入口默认售价均为人民币 4 元/条。

| 本站 ID | 实际上游 ID | 规格 | 默认线路成本 |
| --- | --- | --- | --- |
| `zh-seedance.2.0` | `Asedanco2.0`、`Asedanco2.05` | 720p，5–15 整数秒，9 图、3 音频、3 参考视频 | 2.5、3 元/条 |
| `XXsedanco2.0` | `XXsedanco2.0` | 720p，5–15 整数秒，9 图、3 音频、不支持参考视频 | 3 元/条 |

成本来自用户截图，只用于现有规格路由排序；用户售价独立按 `per_call` 收取，不随秒数乘算。

## 协议依据

- https://www.v6k.top/api/pricing ：逐一核对三个真实 ID、720p、5–15 秒和各自素材数量；XX 的目录未声明参考视频支持，用户也明确要求禁止。
- https://www.v6k.top/docs/openapi-video.json ：本次读取版本 1.2.0，`POST /v1/videos` 以 JSON 提交 `model,prompt,seconds,ratio,resolution,images,videos,audios`；取得字符串 `id` 后查询 `GET /v1/videos/{id}`，原任务下载使用 `/content`。
- 文档要求检查任务状态，`unknown` 不表示生成失败；临时查询异常退避，禁止以重新生成代替查询。沿用已实现的 V6K 回执、查询退避、410 成品异常处理。
- 未新增独立首尾帧、负面提示词、质量或音频开关能力；画幅沿用现有可配置规格，模拟测试不代表逐一通过上游实测。

## 实际执行链

1. `server/db/seed.ts` → `ensureV6kSeedance20Models` 仅注册两个停用入口、默认价格和停用规格，保留管理员已有价格、名称、开关、规格与历史任务。
2. 渠道“同步模型” → `ChannelService.syncModels` → `syncV6kVideoModels`：先读取当前 Key 的 `/v1/models`。公开目录只补参数，不能授予调用权限；两个 A 型号归到同一公开 ID，XX 保持独立。
3. `bindV6kSeedance20Routes` 只为当前 Key 返回的真实 ID 新增缺少的线路。同步保留既有线路、成本与停用状态；目录缺席不自动删除原线路，不影响其他渠道。同步范围以 `V6K_MODEL_SYNC_ALLOWLIST.md` 为准。
4. 网站、画布、外部 API → `handleSpecificationGeneration`；批量队列经持久化的内部网站入口进入同一函数。`specificationRequest` 与规格校验在订单创建/预扣之前拒绝超限输入，XX 不会静默丢弃视频。
5. `selectModelRoutes` 按实际线路成本排序；`runVideo` 占用提交锁 → `submitSpecificationVideo` → `submitZonghengVideo`。实际发送真实上游 ID，不发送销售入口名。有效任务 ID 先持久化，再解释状态并查询原任务。
6. 仅 A 入口的连接建立前失败、无受理证据的 V6K 401/403/429 拒绝可切下一条线路。参数拒绝结束订单；有效 ID、5xx、断线、响应不完整等未知受理不切换重发。其他 V6K 产品的既有切换判定不变。
7. 成功/失败继续原预扣事务或批量账本结算；`resumeSpecificationTasks` 从原持久化编号恢复查询，不再预扣或创建上游任务。

## 更新后的操作

```bash
cd /opt/shotVideo &&
git pull --ff-only origin main &&
docker compose up -d --build --no-deps app
```

在原 V6K 渠道点击“同步模型”，然后在“模型管理”启用两个入口，并在“模型规格”开放对应规格。新模型按仓库规定默认停用；本次不自动启用渠道/Key，也不更改已有任务、余额或用户权限。

若当前 Key 只授权一个 A 型号，只建立该型号的线路。若未授权 XX，不会凭公开目录建立 XX 线路。

## 验证范围

- 15 个相关测试文件、350 项测试通过：包含真实 Express 网站/API 入口、实际批量队列桥接、授权模型同步、入口分离、5 秒与 15 秒按条价格、XX 素材拒绝、A 限流后安全切换、未知受理不重发、有效编号先保存、失败退款一次、恢复周期不二次预扣，以及其他既有型号回归。
- TypeScript 检查及前端生产构建通过；构建只有既有动态导入/包体大小提示。
- 测试使用模拟上游和隔离数据库。本次未消费上游余额、未改生产数据；VPS 部署与真实 Key 的生成结果尚未验证。
