# V6K 提交出站诊断

在 2026-11-10 回退版本上增加观察信息，不改变提交请求体、鉴权、120 秒默认超时、失败分类、重试、恢复或账务规则。

每次实际调用 V6K 视频 POST 完成或异常退出后，输出一条 `[v6k-submit-transport]` JSON。`orderId` 对应原订单 metadata 的 `zonghengOrderId`。只记录生成阶段的时间、字节数、HTTP 状态、对端 IP 和符合格式约束的响应请求编号；不记录密钥、提示词、素材、请求头、响应正文或带签名的地址。

网站与外部 API 的规格提交错误也会保存完整的 `zonghengSubmissionDiagnostics.transport`，并使用既有 `[video-submit]` 日志关联本地订单 ID。已有直接提交入口沿用相同诊断保存机制。

| 字段 | 含义及边界 |
| --- | --- |
| startedAt / timeoutMs / elapsedMs | 网络请求开始时间、实际提交超时配置、观测耗时 |
| requestBytes | JSON 请求体的 UTF-8 字节数，不是实际发送字节数 |
| requestObserved / requestCreatedMs | Undici 是否创建了本次请求；未观测到事件不能作为未发送或退款依据 |
| socketWriteStartedMs | 在首次 socket 写入前触发，不能解释为请求头已送达 |
| peerIp | 本次请求写入所使用 socket 的对端 IP；可能是代理或网关 |
| requestBodySentMs | 客户端已完成请求体发送；不等于上游应用确认接单 |
| responseHeadersMs / httpStatus | 已收到 HTTP 响应头和状态；不等于生成成功 |
| responseBodyCompleteMs | 已收完响应正文 |
| requestId | 响应头提供的跟踪编号，不是生成任务 ID |
| transportCode | 原生传输错误码，例如 ECONNREFUSED；不记录错误原文 |

所有 `Ms` 事件时间均相对 startedAt。采用 AsyncLocalStorage 与原生请求对象关联并发事件；不按主机、时间接近程度或共享连接事件猜测归属。固定订阅不记录没有主动开启追踪的其他请求，退出后忽略迟到事件。诊断缺失不会改变现有受理判断。

## 线上只读采集

让下一笔正常业务请求走原有入口，无需额外创建付费测试任务。随后执行：

```bash
cd /opt/shotVideo && docker compose logs --no-color --since=20m app 2>&1 | grep -E '\[v6k-submit-transport\]|\[video-submit\]' | tail -n 40
```

有 `requestBodySentMs` 无 `responseHeadersMs`：客户端已发送，未取得响应头；需与对端 IP 和 V6K 接入日志对应核查。仅有请求创建事件而没有写入事件：继续核查连接/调度阶段，不能单凭缺事件宣布未接单。收到响应头但没有正文完成事件：核查响应读取中断。返回 JSON 是否符合协议仍由原适配器解析。

历史未保存观测数据的订单不能由此补造发送证据。进程被强制终止时可能来不及输出最终日志，也不能把没有日志视为没有发送。

## 隔离验证

`tests/submissionTransportTrace.test.ts` 仅连接本机 HTTP 服务，验证正常响应、无响应、正文中断、连接拒绝、并发隔离和日志脱敏；集成测试覆盖网站与 API 规格入口的超时/503诊断持久化、保留预扣与不重发。没有调用真实付费上游。
