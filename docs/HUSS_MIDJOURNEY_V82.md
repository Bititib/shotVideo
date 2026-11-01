# HUSS Midjourney V8.2 接入

协议核对：2026-11-01。公开 ID 与上游 ID 均为 `Midjourney V8.2`，不改变现有 MJ 渠道。

依据：
- https://www.huss.top/api-docs/midjourney-style.md
- https://www.huss.top/api-docs/images-text.md

## 部署与启用
更新容器后，在 HUSS 渠道同步模型；原 API Key 需允许该模型。新模型默认停用，管理员设置按次售价后启用。支持 1K/2K，一个模型入口。同步不覆盖已有售价和启用状态。

图片生成页面提供 Raw 模式、stylize、风格参考图直链 sref/sw、chaos、weird、seed、iw、tile、negative_prompt；质量、比例和分辨率使用现有设置。水彩、油画、动漫等风格名称写进提示词。V8.2 不提供 cref/cw/stop/draft。

## 实际调用与状态
网站 `/api/image-gen` 与外部 `/v1/images/generations`、`/v1/images/edits` 均通过 managed specification 执行器进入 HUSS 专用图片分支。
文生图 POST `/v1/images/generations/async`；一张普通参考图转 Data URL 后走 `/v1/images/edits/async`。n=1；参考图限制与上游协议一致，提示词不加本地长度上限。
提交回执 task_id 在状态解析前持久化。只 GET `/v1/images/tasks/{task_id}` 查询；不套用视频幂等键、视频查询地址或视频 ID 前缀。
按 poll_after_ms 安排下一次查询（缺省 5 秒）；失败查询/保存退避 30 秒，后台扫描在重启后恢复原任务。图片 POST 结果不明时不重复发送。
上游 completed 后保存全部 data[].url；不裁图、不丢候选，所有候选按一次费用结算。保存期间显示“图片已生成，正在保存”；失败保留已保存候选，重新查询原结果刷新链接并重试缺失图片。查询临时不可用时可以继续保存已记录的结果。
下载独立控制跳转，跨域不带 API Key，校验真实图片格式。连接、传输、HTTP 错误分别保留诊断，用户页面展示简明阶段。

## 资金与异常
使用原账本预扣，完整保存后原事务结算。明确 HTTP 参数/鉴权/余额拒绝、任务 failed/cancelled 进入失败退款；查询故障及结果保存故障不退款、不重新生成。
expired 表示结果过期，文档未保证退款，转交付核实而不猜测扣退费。提交无回执则保留提交核实，不自动重发。管理员已有处理机制不被绕过。
外部 API 未立即完成时返回 202、task_id 与 status_url；使用同一平台 Token GET `/v1/images/tasks/task_<本地编号>` 查询。只可读取本 Token 的任务，额度耗尽仍可查询已付费任务。完成返回全部本地 data[].url。

## 验证范围
回归覆盖实际执行器与隔离账本：提交回执持久化、错误回执、查询失败与任务失败区分、下载失败重试、重启恢复、部分候选复用、单次计费退款、防重复 POST、图片输入与独立风格参考、候选完整保留、CDN 密钥隔离、前端参数交互与同步定价保护。
未进行真实付费出图或生产部署；上游永久不可用、结果过期仍可能需要管理员处理，不能承诺外部服务永不失败。

本次验证：9 个相关测试文件、315 项测试通过；TypeScript 检查与生产构建通过。构建仅有既有大分包体积提示。
