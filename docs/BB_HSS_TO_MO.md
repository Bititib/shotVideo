# BB 与 HSS 改接 Mo

2026-11-03 用户确认：BB 和 HSS 都接 Mo，取消这两个入口的其他来源，不接 SS。保留公开 ID `bb-2.5-301010`、`hss-2.5-301010`，现有显示名称、模型身份、权限、售价及启用状态；底层精确上游 ID 为 `Mo-Seedance-2.5-720p`。页面继续归入 Seedance 系列。

## 协议依据

读取 [Mo 专用接入文档](https://hayaai.cc/docs/models/mo-seedance-2.5-720p/) 和 [通用文档](https://hayaai.cc/docs/)。模型广场的 API 页签仍是通用聊天模板，不作为视频字段依据。旧域名 `hayaai.fun` 返回 `domain_retired` 并指向 `hayaai.cc`，新建渠道默认使用新地址；不静默改写已有渠道地址。

- Bearer 鉴权，`POST /v1/videos`，JSON 字段 `model/prompt/seconds/resolution/ratio`。内部校验整数秒数 5–30，向 Mo 网关发送字符串，例如 `"seconds":"5"`。固定 720p；默认 16:9，支持 auto、1:1、3:4、4:3、9:16、16:9、21:9。提示词必填，最多 45000 字符。
- 素材使用根级 `images/videos/audios`，每类最多 30/10/10，**三类合计最多16项**。专用文档明确要求总量16，不能用卡片“50全参”推算50项。
- 每项为公网可匿名读取的 HTTPS 文件地址，单文件最多30 MiB。Mo 无专用素材上传接口；不向它提交通用的 asset 引用、multipart 或 Base64。本站本地上传转换为本站公开 HTTPS 素材链接；外部 URL 及签名原样传递，外部内容/大小由上游检验，不由本站任意抓取。
- 创建响应读取 `task_id` 或 `id` 的 `task_…` 标识，先持久化再查询 `GET /v1/videos/{id}`。queued/in_progress 继续查询，completed 读取 metadata.url 或统一 content 下载入口，failed 保留 error/message 并结束原订单。
- 提交504 `submission_status_unknown`、网络断线或响应不完整不自动重发；查询429/5xx保留原任务继续查。Mo 任务终态独立解析，不被其他渠道的错误码规则覆盖。

## 迁移与实际路径

`bbHssMoMigration` 首次存档模型、规格、选择及渠道映射，清除 BB/HSS 的旧新单线路，改为仅 Mo；不删除旧渠道、Key、原任务、账本或退款记录，也不写价格表。没有已核实的 Mo 权限时，入口保持原启用开关但无可用线路，不退回 KK 或 HUSS。旧 KK 初始化检测 Mo 迁移标记后不再改价或重新绑定。

Haya 渠道鉴权同步 `/v1/models` 确认当前 Key 包含精确 Mo ID 后，为两个入口绑定 Mo。不会新增带 Mo/SS 前缀的公开模型。随后重启/同步保留管理员修改的开关、限制和价格；后台来源选择仅允许 Mo 和已配置 Haya 渠道，切换前重新验证权限。

网站、外部API、画布和批量调度均经过 `specificationGenerationService`：参数与素材校验 → 路线选择 → 原账本预扣 → 原提交锁 → Haya 专用 POST → 保存原任务ID → 查询 → 保存结果及幂等结算。`maxReferences` 随模型能力返回，网页、画布、报价和服务器共用合计数量校验。批量队列沿原订单金额结算，不因替换渠道二次扣费。

历史已受理任务按保存的 channelId、Key 身份、上游型号和任务ID恢复，不套用 Mo 参数、不发送新生成请求。旧来源仅从这两个入口的新单选择中移除，其他产品不变。

## VPS 更新

拉取 main 并重建 app 后自动执行配置迁移。后台核对 Haya 渠道地址为 `https://hayaai.cc`，保留有效 Key，点击“同步模型”；同步返回 Mo 权限后，BB 和 HSS 才有新线路。也可从 BB/HSS 的来源设置选择该 Haya 渠道并验证绑定。若无权限或旧地址失效，先修正配置，不能以旧来源补发。

## 验证范围

### 2026-11-03 Mo 秒数字段修复

用户提供线上创建回执：HTTP 400、`code=invalid_json`，具体原因为 `json: cannot unmarshal number into Go struct field .Alias.seconds of type string`。重新读取专用文档仍是数字示例，与实际网关解析类型不符；以该真实回执修正 Mo 的传输格式为字符串，内部参数校验与按秒计算仍使用数字。网站、外部 API 和批量队列共用 `submitHayaVideo → buildHayaVideoPayload`，其他型号的字段格式保持原样。

该具体 400 无受理编号，沿现有明确拒绝流程结束并幂等退款，不轮询、不自动补发。新增网站两入口回归，并将 API 同逻辑请求与真实批量队列的拒绝样本替换为此回执；验证只发送一次、原错误保留、资金恢复一次。修复前字段类型回归已复现失败；修复后 4 个相关测试文件、73 项通过，TypeScript 检查及差异格式检查通过。未自动重试生产失败任务或执行付费生成，修复尚需 VPS 拉取重建。

此前初次接入验证：15 个测试文件、473 项回归通过，TypeScript 检查和前端构建通过。隔离数据库及模拟上游验证：两个入口的网站/API提交，16项混合素材和签名保留，17项拒绝、5–30秒与720p限制、实际批量队列、明确失败仅退款一次、未知受理不重发、API同逻辑请求重试、迁移不改价格/身份/历史任务、重复同步不覆盖设置、旧KK及HUSS受理任务按原渠道恢复。该次验证未执行 VPS 部署或真实付费生成，未宣称上游素材效果已验证。
