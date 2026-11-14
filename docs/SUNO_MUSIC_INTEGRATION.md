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
| GET /music/{id}/results/{resultId}/file | 下载或试听已保存的单首结果 |
| GET /music/{id}/file | 兼容单文件客户端，返回首个已保存结果 |

提交通用字段为 model、operation、client_request_id。强化操作必须提交已确认的 expected_cost；其他操作可提交该字段防止价格变动。上传素材须 rights_confirmed=true；音色操作须 self_voice_confirmed=true，强化音色另须 rights_confirmed=true。本站源音频上限 40 MB，音色样本上限 10 MB 且至少 6 秒。音色样本可上传文件或在网站录制 6–90 秒的 WAV。外部 API 可以用 source_kind=record 标记录制样本。素材使用本地文件或本站已授权素材 ID。

generate 默认用灵感模式，传 prompt。专业模式传 custom=true、tags 和可选 lyrics、title；prompt 留空。cover 加本站 asset_id；专业翻唱需 tags 和 title。sing 用本站 voice_id；voice_cover 同时传 asset_id 和 voice_id。后者使用的歌曲素材不得等于创建音色的样本。生成返回 202 表示本站已入队，逐首读取 results[] 中的状态和结果地址。

## 上游协议与恢复

- 普通素材：POST /api/music/upload-source。素材完成态为 complete，存 clip_id。普通翻唱使用 POST /api/music/generate-from-source 的 sourceClipId，强化素材另外带上游音频地址与标题。
- 强化上传：POST /api/music/enhanced-upload，先保存 task_id，再查询原任务。completed 后保存真实 song_id 及媒体。只有原队列确认取消才退款；取消响应中断后查询原任务。
- 音色：POST /api/music/voice-profile/create（普通或 enhanced=true），或者 /create-from-clip。保存 voice_id 并查询到 ready。后续 POST /api/music/voice-profile/cover 检查 resolved_scene，按真实 song_id 保存两首结果。
- 文字生成：POST /api/music/create 或 /create/custom 使用 accept_mode=async、上游 Idempotency-Key。持久化回执后查 /api/music/requests/{request_id}，再逐首用逗号分隔的 song_ids 查询。后台只允许一次同键、同参数、同凭据的受保护回放。普通创建音色及已有音频创建同样只在文档去重范围内使用原 client_request_id 回放。
- 音色翻唱追踪头不具备上游去重。断线后历史详情必须匹配精确追踪号、模型、来源和两个结果位置才关联原歌曲。强化克隆优先在原凭据的音色列表按精确 client_request_id 查找并查询详情。普通翻唱、强化上传或无法精确匹配的强化克隆缺少回执时保留原订单，供人工核对。下载、查询和结算异常只恢复原步骤。
- 一次预扣一笔操作。明确拒绝、确认未提交、全失败或确认取消才全退。素材处理和下游生成分别结算。单首成功可以交付；部分金额由管理员按账单核对，未设自动比例。本站流水与上游扣退证据分开。已完成的单首不会因重新查询而重复扣费。
- 管理员可 GET /api/admin/music/{id} 核对原回执和阶段，POST /api/admin/music/{id}/recover 提交 evidence。缺少回执时，强化／音色／文字生成传上游 upstreamId，普通或音色翻唱传经核实的 songIds；已有回执可提交 evidence 重新查询或保存；翻唱只收到一首且补查到第二首原单结果时，传入原单两首的 songIds。所有操作只读查上游原任务。账单核对页负责实收与退款。

## 验证范围

相关回归共 15 个测试文件、113 项通过，覆盖网站和外部 API、队列恢复、多人及组织资金、取消和部分结果。扩大到目录、渠道管理等共 19 个测试文件时，184 项通过，6 项既有失败在同一基线 8aa456e 复现。TypeScript 检查、生产构建和 git diff --check 通过。

本实现使用隔离 SQLite 与模拟上游。真实型号权限、歌曲素材与音色的组合可用性、部分退款净额、强化操作丢回包之后的上游人工找回、音色删除后上游样本清理仍待联调。没有真实付费调用。浏览器录音的正常路径用模拟麦克风覆盖。

协议：[灵感生成](https://www.suno-api.io/docs/current-music-create/) · [专业生成](https://www.suno-api.io/docs/current-music-create-custom/) · [普通上传](https://www.suno-api.io/docs/current-music-upload-source/) · [强化上传](https://www.suno-api.io/docs/current-music-enhanced-upload/) · [普通翻唱](https://www.suno-api.io/docs/current-music-generate-from-source/) · [音色](https://www.suno-api.io/docs/current-clone-voice/) · [歌曲查询](https://www.suno-api.io/docs/current-music-query/) · [免费 MP3 下载](https://www.suno-api.io/docs/current-music-media-download/) · [余额查询](https://www.suno-api.io/docs/current-user-balance/)
