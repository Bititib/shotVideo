# HUSS / V6K / snumom 状态复核（2026-10-24）

本轮依据实际读取的公开文档，所有验证使用模拟网络和测试数据库，没有发起付费生成。

## HUSS

来源：https://www.huss.top/api-docs/receipt-states.html 、https://www.huss.top/api-docs/video-async.html

- 同步提交已保存 Idempotency-Key；新增 GET /v1/videos/submissions 使用原密钥、原编号找回任务。没有重发生成 POST。
- accepted 且有 task_id 才开始任务查询；processing 继续核对；rejected/not_submitted 结束本地订单并走幂等退款；未知或冲突状态保留核实。
- 退款依据是生成已拒绝；refund_flow_recorded 不是上游退款到账凭证，不能单凭该字段退款。
- 提交 HTTP 400 不能独自证明拒绝：先查原回执。409 同样不能按普通参数错误重提。
- 原来查询 HTTP 200 + status=failed + error 被当成查询异常，已修复为任务失败。
- 后台恢复扫描覆盖持有原幂等键、无任务 ID 的 HUSS 规格订单，包括待核实订单；每分钟最多查询一次，按原渠道和 Key 查询。404/查询断线不触发重提或退款。
- 本轮保持同步生成入口，未迁移到新的异步 submission_id 协议。没有保存原幂等键的历史任务不能自动找回。

## V6K

来源：https://www.v6k.top/docs?guide=unified&category=video

- 保留其独立状态 queued/in_progress/completed/failed，提交即时失败任务按终态处理，查询失败保留原 ID。
- 补上 HTTP 错误中嵌套 ID、响应头回执和冲突的成功响应保护，避免错误退款或重复生成。
- 5xx、HTML、断线且无法确认受理时仍核实；文档未提供按业务编号找回协议，不能假设发送 Idempotency-Key 就获得幂等保证。

## snumom

来源：https://snumom.com/docs/wan-3.0.html （查询任务 / 万相 3.0 校验失败）

- HTTP 500 + 顶层 code=build_request_failed + message，且没有任务/受理证据：按文档的素材转换失败处理，结束本地任务并退款。
- 规则仅适用于 snumom，接入网站、外部 API、规格提交路径；不将普通 500、其他渠道同名错误或带冲突回执的响应当成明确失败。
- 保留原有 No available channel 独立判定。

## 验证范围

覆盖原回执恢复、明确拒绝、待处理、未知状态、失败任务带 error、冲突 ID，以及实际预扣账本下的恢复、只退款一次、不重复提交。没有验证未提供的供应商私有错误或生产历史账单。
