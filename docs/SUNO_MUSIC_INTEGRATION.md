# Suno 音乐接入

新音乐生成、翻唱、歌曲素材上传和演唱音色使用 suno-api.io。miniKey 图片、视频协议与原音乐订单保留。部署后，旧音乐队列仅查询已受理的原任务，未发送的订单原路退款，缺少可确认回执的原订单进入核对。旧完成订单继续用原 MP3 下载路径。

## 配置

1. 启动新版后，管理后台「渠道管理」会预置停用的 Suno（音乐）渠道。点「配置 Suno API Key」，填入密钥并保存。后台使用同一个 Key 读取余额和 GET /v1/models，两项成功才保存并同步 suno-v6、suno-v6-wild、suno-v6-mini 中实际返回的型号。首次验证成功启用渠道，并启用已有本站按次售价的已同步模型。尚无售价的模型待定价后在后台启用。后续换 Key 保留管理员已有开关；错误的 Key 不覆盖当前配置。余额查询和模型同步均为只读操作。已有 miniKey 同名纯音乐模型沿用原价格、权限和历史；其他同名模型报告冲突。
2. 为每个开放的模型设置按次售价。基础单价用于文字生成和普通翻唱。其他规格价格每行配置一个键和值：voice_generation 为音色生成，enhanced_upload 为强化上传，enhanced_voice 为强化克隆。未配置的付费操作不报价。Max Mode 仅对生成／翻唱将对应售价乘二。普通上传、普通创建音色、从素材创建音色免费。
3. 启用型号，分配音乐功能、模型权限及 API Key 授权。每个音乐模型只绑定一个启用且具备该模型映射的渠道。同一组合的素材、音色和生成使用原渠道及原凭据。用户音色、素材、文件和订单按本站用户或 API Key 隔离。本站使用私有音乐目录保存样本、素材和结果，随 data 持久化。上传校验使用现有 ffprobe 音频探测。

## 网站和外部 API

网站为 /app/music。外部鉴权使用本站 API Key。下列路径使用 /v1 前缀，网站使用 /api 前缀。

| 方法及路径 | 用法 |
| --- | --- |
| GET /music/models | 已配置的操作和本站售价。网站返回数组，外部 API 返回 data 数组 |
| POST /music/assets | multipart：单个 file，options 为 JSON；operation 为 upload 或 enhanced_upload |
| POST /music/voices | multipart：单个 file，options 为 JSON；operation 为 voice 或 enhanced_voice。已有素材可用 JSON 提交 voice_from_clip 与 asset_id |
| GET /music/assets、GET /music/voices | 本账号素材及音色，完成后返回可组合使用的本站 ID |
| GET /music/assets/{id}/file、GET /music/voices/{id}/file | 鉴权读取本站保存的原始样本或完成后的强化上传文件。从已有素材创建的音色复用原素材 |
| POST /music/assets/{id}/cancel | 尝试取消尚未处理的强化上传 |
| DELETE /music/voices/{id} | 删除已完成的音色；保留已生成歌曲。上游样本留存期限另行确认 |
| POST /music | generate 文字生成，cover 普通翻唱，sing 音色唱新歌，voice_cover 音色翻唱 |
| GET /music、GET /music/{id} | 订单及逐首结果 |
| GET /music/by-request/{client_request_id} | 按原请求编号查单 |
| POST /music/{id}/recover | 使用原 API Key 和空 JSON 对象，恢复免费普通上传或本人音色原订单 |
| GET /music/{id}/results/{resultId}/file | 下载或试听已保存的单首结果 |
| GET /music/{id}/file | 兼容单文件客户端，返回首个已保存结果 |

提交通用字段为 model、operation、client_request_id。强化操作必须提交已确认的 expected_cost；其他操作可提交该字段防止价格变动。上传素材须 rights_confirmed=true；音色操作须 self_voice_confirmed=true，强化音色另须 rights_confirmed=true。本站源音频上限 40 MB，音色样本上限 10 MB 且至少 6 秒。音色样本可上传文件或在网站录制 6–90 秒的 WAV。外部 API 可以用 source_kind=record 标记录制样本。素材使用本地文件或本站已授权素材 ID。

generate 默认用灵感模式，传 prompt。专业模式传 custom=true、tags 和可选 lyrics、title；prompt 留空。cover 加本站 asset_id；专业翻唱需 tags 和 title。sing 用本站 voice_id；voice_cover 同时传 asset_id 和 voice_id。后者使用的歌曲素材不得等于创建音色的样本。生成返回 202 表示本站已入队，逐首读取 results[] 中的状态和结果地址。

### API 上传后的查询与自助恢复

素材和音色上传返回 202 及本站订单 id。API 响应提供 status_url，上传响应的 Location 也指向该地址。用原 API Key 查询，completed 时读取 asset_id 或 voice_id。API Key 之间的素材隔离也适用于同一用户的多个 Key。

stage 表示队列阶段，client_request_id 为原调用编号，error 和 error_code 保留脱敏后的具体原因。poll_after_seconds 非空表示后台仍在处理或恢复，客户端按间隔查询。即使 status 为 review，只要该字段非空仍应查询原订单。poll_after_seconds 为空且 can_recover 为 true 时，等待 recovery_after_seconds 后 POST recovery_url，正文为 {}。成功返回 202 并继续查询同一订单，已完成的重复恢复返回 200。429 提供 Retry-After；409 的错误说明具体阻碍。查询响应禁用缓存。

当前恢复只读查询或回填原回执，不重传文件，不重新创建音色，不发起付费生成。本人音色 can_recover=true 时可按原 API Key POST recovery_url 空对象；按原 client_request_id 查询音色列表和详情，查不到时最多连续查询三次，然后保留原单及具体原因。音色原文件已经丢失也不妨碍查询已有音色。渠道凭据变化、结果冲突和关联错误仍需核对。

普通上传缺少回执时返回 recovery_mode=receipt_required、can_recover=false 和 recovery_hint。上游文档未提供按请求编号查回普通上传的接口，歌曲历史明确排除上传素材，不能按标题/时间猜测归属。管理员核实该原请求的成功响应后，在原订单提交 uploadReceipt（含 clip_id、status=complete）、originalRequestId（该订单的原追踪号）和 evidence。后台只回填这一原订单，API 用户继续按原订单号或 client_request_id 查询后获得本站 asset_id。回填是管理员对原始证据的确认，不代表本站通过一个未公开查询接口独立核实了上传。普通 API 用户不能自行关联任意上游 clip_id。重复回填相同回执幂等，其他订单已占用的素材、编号冲突、变更凭据及付费订单均拒绝。

调用示例见站内 API 文档的上传歌曲素材、创建本人演唱音色和恢复原订单条目，包含上传、断线查单、轮询、一次自助恢复及最终素材编号读取。上述流程使用模拟上游验证；普通上传的生产对照结果及尚未确认的断线原因见下方诊断记录。

## 上游协议与恢复

- 普通素材：POST /api/music/upload-source。素材完成态为 complete，存 clip_id。普通翻唱使用 POST /api/music/generate-from-source 的 sourceClipId，强化素材另外带上游音频地址与标题。
- 普通上传在首次提交后丢失回执即保留待核实，恢复及重启不再重传。旧 retryUpload 请求被拒绝，旧版遗留的重传标志也不会触发上传。上游成功回执由管理员核实后回填到原订单。
- 强化上传：POST /api/music/enhanced-upload，先保存 task_id，再查询原任务。completed 后保存真实 song_id 及媒体。只有原队列确认取消才退款；取消响应中断后查询原任务。
- 音色：POST /api/music/voice-profile/create（普通或 enhanced=true），或者 /create-from-clip。保存 voice_id 并查询到 ready。后续 POST /api/music/voice-profile/cover 检查 resolved_scene，按真实 song_id 保存两首结果。
- 文字生成：POST /api/music/create 或 /create/custom 使用 accept_mode=async、上游 Idempotency-Key。持久化回执后查 /api/music/requests/{request_id}，再逐首用逗号分隔的 song_ids 查询。后台只允许一次同键、同参数、同凭据的受保护回放。普通创建音色及已有音频创建在本实现中仅查原 client_request_id 对应音色，禁止回放创建请求。
- 音色翻唱追踪头不具备上游去重。断线后历史详情必须匹配精确追踪号、模型、来源和两个结果位置才关联原歌曲。强化克隆优先在原凭据的音色列表按精确 client_request_id 查找并查询详情。普通翻唱、强化上传或无法精确匹配的强化克隆缺少回执时保留原订单，供人工核对。下载、查询和结算异常只恢复原步骤。
- 一次预扣一笔操作。明确拒绝、确认未提交、全失败或确认取消才全退。素材处理和下游生成分别结算。单首成功可以交付；部分金额由管理员按账单核对，未设自动比例。本站流水与上游扣退证据分开。已完成的单首不会因重新查询而重复扣费。
- 管理员可 GET /api/admin/music/{id} 核对原回执和阶段，POST /api/admin/music/{id}/recover 提交 evidence。普通上传使用上文 uploadReceipt 回填；普通音色可留空编号按原请求只读查回，也可传已核实的 upstreamId。强化／文字生成传原 upstreamId，普通或音色翻唱传经核实的 songIds；已有回执可提交 evidence 重新查询或保存；翻唱只收到一首且补查到第二首原单结果时，传入原单两首的 songIds。回填与查询都不会重新上传或创建歌曲。账单核对页负责实收与退款。

## 验证范围

### 生成记录音乐下载（2026-11-17）

根因：HistoryPage 的音乐下载落入 window.open(resultUrl) 分支，详情也直接使用 audio src；浏览器导航/媒体标签未携带音乐接口要求的 Authorization，因此已登录用户仍看到“请先登录”。同时 API 音乐订单按 token 隔离，简单给原 /api/music/{job}/file 加网页 JWT 仍可能因 owner 不同返回 404。

历史页下载和详情试听现通过认证 API 客户端读取 Blob。新增 GET /api/music/history/{contentId}/file，以 contents.user_id 核对当前网页登录账号，再读取该记录关联的音乐订单首个已保存结果，兼容该账号自己的 API 订单和旧音乐订单。接口保留私有缓存及订单校验；原 /v1/music 与 /api/music 订单接口的 token/user 隔离规则保持不变。没有将登录令牌放入下载 URL，也不公开私有文件。

实际页面下载/试听测试验证 Bearer 头、Blob 下载、退出详情释放音频及错误展示；实际路由验证无登录 401、自己的 API 结果下载成功、其他账号 404、原 token 隔离保留、记录删除后拒绝访问，以及读取不触发上游或扣退费。四个相关测试文件共 50 项通过，类型检查通过。

### 只读恢复原订单（2026-11-17，当前规则）

五个相关测试文件共 52 项通过，TypeScript 检查与生产构建通过。验证实际外部 API、管理员恢复入口、后台表单、原订单归属、普通上传回填幂等、旧恢复请求禁用、重启不重传、音色空列表仅查询、音色编号先保存再查详情、详情断线后续查原编号、并发恢复、无扣退费及 miniKey 历史兼容。本次没有执行任何真实上游请求。代码与模拟验证完成不代表历史生产订单已经恢复；#16028 仍缺少已核实的原成功 clip_id/回执，#16040 需部署后用原凭据查询确认。

### 后台原始音频查看（2026-11-17）

音乐上传将原文件保存在 data/private-music，文件关联位于 music_jobs.payload；通用内容 metadata 不包含这些私有音频链接。此前后台参考素材只读取通用 metadata，导致 API 普通上传和本人音色即使保留了文件，也显示参考素材 0。现有用户素材读取接口还要求完成态，无法用于核对待核实订单的原输入。

后台现在通过管理员专用 GET /api/admin/music/{id}/sources 查询原文件列表，通过 /sources/{sourceId}/file 鉴权读取。读取直接关联音乐订单及同一所有者的歌曲/音色来源，适用于历史订单、待核实和失败状态；不要求上游成功，不修改订单，也不触发上游请求。文件路径不会返回前端，下载前核对真实路径位于私有音乐目录。已删除、缺失或无法读取的文件显示原因。普通用户及 API 调用者不获得管理员权限，原用户素材接口规则保持不变。

后台详情新增“查看用户上传音频”，参考素材数量及音频播放/下载来自上述接口；带鉴权读取后使用临时 Blob 播放，切换订单/关闭预览时释放链接。组合生成展示关联的原歌曲和音色样本。缺少原文件不能从此入口自动找回上游素材，原输入展示与上游成功回执恢复仍是两个独立步骤。

验证：相关四个测试文件累计 48 项通过，包含实际后台详情页切换参考素材、待核实 API 上传/音色读取、组合来源、权限拒绝、文件丢失/删除、越界路径和跨所有者引用拒绝。类型检查、生产构建通过；未执行真实上游请求。部署后的实际历史文件可用性需以服务器留存文件为准。

此前版本（已由当前只读恢复规则替代）的 API 自助恢复修复通过 Suno、miniKey 历史音乐及音乐页面三个测试文件的 37 项回归，覆盖实际上传/查询/恢复入口、同用户不同 API Key 隔离、并发恢复、持久化后重启扫描、原音色只读找回、同键重提、连续断线、明确拒绝结束和免费操作无资金流水。两个 Python 示例通过模拟的上传、轮询和恢复流程，TypeScript 检查及生产构建通过。构建临时目录使用本地工作盘以避开 Windows 系统临时目录的文件删除权限错误。

相关回归共 15 个测试文件、113 项通过，覆盖网站和外部 API、队列恢复、多人及组织资金、取消和部分结果。扩大到目录、渠道管理等共 19 个测试文件时，184 项通过，6 项既有失败在同一基线 8aa456e 复现。TypeScript 检查、生产构建和 git diff --check 通过。

本实现使用隔离 SQLite 与模拟上游。真实型号权限、歌曲素材与音色的组合可用性、部分退款净额、强化操作丢回包之后的上游人工找回、音色删除后上游样本清理仍待联调。没有真实付费调用。浏览器录音的正常路径用模拟麦克风覆盖。

## 普通上传连接重置诊断（历史记录，当前恢复不要运行重传诊断）

此前对照诊断执行过 `docker exec -i -w /app shot-video node < server/scripts/diagnoseSunoUpload.cjs`。默认读取内容 #16028，可通过 docker exec 的 `-e SUNO_DIAG_CONTENT_ID=编号` 指定其他普通上传原订单。脚本只读数据库，校验免费操作、原凭据、原文件范围及处理状态，最多对当前 DNS 返回的两个 IPv4 地址各发送一次 multipart 和 JSON base64 免费上传。保持相同音频和业务字段、固定每组 IP、校验证书/SNI、显式按字节计算请求长度，并交替两组格式的顺序。

输出记录原文件和请求体摘要、TLS 对端、发送耗时、HTTP 状态、上游请求编号及断开耗时，密钥和音频正文不输出。X-Request-ID 仅供上游日志关联，不表示幂等保证；普通上传成功可能在上游新建免费素材。诊断不回填本站订单，成功的 clipId 保留在输出。BODY_SENT 只表示客户端写入完成，不能证明上游应用已处理完整请求。固定 IP 对照仍可能受到后端负载分配和时间变化影响，精确定位入口/后端关闭连接原因需要上游同期日志。

本地模拟验证了免费操作限制、固定地址、相同原音频、准确 Content-Length、连接重置捕获及成功回执保留。

### 2026-11-17 VPS 实测及处理修复

北京时间 10:09:50–10:12:08，内容 #16028 的同一份 1,058,444 字节 WAV（SHA256：404830284c05ade3536d61ea05257d8244c0953c302886f29392d175b4c1d34a）在两个 IP、两种编码下得到以下结果：

| 固定上游 IP | 请求格式 | 结果 |
| --- | --- | --- |
| 43.159.99.85 | multipart | 13.30 秒返回 HTTP 500，code=bad_response_status_code，原因 This audio matches an existing recording in our catalog. |
| 43.159.99.85 | JSON base64 | 41.75 秒 ECONNRESET，无 HTTP 响应 |
| 43.159.98.82 | JSON base64 | 42.07 秒 ECONNRESET，无 HTTP 响应 |
| 43.159.98.82 | multipart | 40.94 秒 ECONNRESET，无 HTTP 响应 |

HTTP 500 请求的上游编号为 202611170209519990845008268d9d6c2ovYkaJ。该响应确认本次上传被音频曲库匹配规则拒绝，不能据此判断版权归属，也不能用新探测的拒绝回执批量改写历史未知订单。其余三个请求均通过 TLS 证书校验、客户端写入完成在 173 ms 内，诊断截止时间为 310 秒。两种格式均存在重置，不能以切换 base64 为修复。约 41–42 秒的集中断开提示需核对网关或后端处理期限，但客户端日志不能证明具体断开组件，也不能证明三个断开均由曲库匹配引起。

后续上游定位依据：上述 UTC 02:09:50–02:12:08 时间段、上游请求编号、脚本输出的 X-Request-ID 与客户端连接端口，结合上游网关访问/错误日志、请求体读取记录、后端上传处理及回包日志，确认是否进入应用及在哪一层断开。单靠 VPS 重传无法取得这些服务器内部证据。

本站修复限定普通 upload 的明确错误封装：错误码 bad_response_status_code 与指定错误原因精确匹配、且没有有效 clip_id 时，结束为 failed，API 状态查询保留 error_code 和具体原因，停止轮询及自动重发；免费上传不扣退费。有效 clip_id 与错误冲突时仍先保存编号供核对，其他模糊 5xx 保留未知状态；不套用到付费生成。

验证：三个相关测试文件共 41 项通过，TypeScript 检查通过。新增实际 API 上传/音色入口用例覆盖 HTTP 500 曲库拒绝、状态与错误反馈、停止重发及无资金变化；补测未知错误、提示词含相同文字、有效 clip_id 冲突、付费翻唱不误退款。生产断线根因仍需上游日志确认，没有新增真实上游或付费调用。

协议：[灵感生成](https://www.suno-api.io/docs/current-music-create/) · [专业生成](https://www.suno-api.io/docs/current-music-create-custom/) · [普通上传](https://www.suno-api.io/docs/current-music-upload-source/) · [强化上传](https://www.suno-api.io/docs/current-music-enhanced-upload/) · [普通翻唱](https://www.suno-api.io/docs/current-music-generate-from-source/) · [音色](https://www.suno-api.io/docs/current-clone-voice/) · [歌曲查询](https://www.suno-api.io/docs/current-music-query/) · [免费 MP3 下载](https://www.suno-api.io/docs/current-music-media-download/) · [余额查询](https://www.suno-api.io/docs/current-user-balance/)
