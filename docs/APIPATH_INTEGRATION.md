# 通联接入记录

日期：2026-10-31。基线：origin/main `6158ae0`，隔离分支 `codex/apipath-channel`。根目录和 huss-final-publish 的未提交改动未移植或覆盖。

## 协议依据

- 官方页面：https://online.apipath.top/app/api-docs
- 页面实际读取的公开结构化文档：https://online.apipath.top/api/api-docs
- 已核对字段保存在 `apipath-protocol-evidence.json`；页面本身省略部分 notes、responses、polling 字段，以结构化文档补足。
- Bearer 鉴权；GET /v1/models 的 data[].id 是平台模型编码，不能用展示名称或 new_api_model 替代。
- 视频 POST /v1/video/generations；task_no/task_id/id 指向同一任务；GET /v1/video/generations/{task_no}；queued/pending/processing 继续查询，completed 取 url，failed 取 error.message。
- 图片默认同步 POST /v1/images/generations；参考图使用 multipart POST /v1/images/edits；结果 data[].url。同步请求不附加异步 response_format。
- 文档明确不支持幂等键。付费 POST 不重试，发送前保存本地逻辑请求及提交占用；有效视频 ID 在任何后续处理前写入收据。
- 仅文档约定的 HTTP 400 + invalid_request_error、401 + invalid_api_key 且无任务编号视为明确拒绝。502 upstream_error 不证明未受理；2xx error、非 JSON、断线及缺 ID 均保留原请求核实。GET 查询失败不触发退款。错误保留阶段、HTTP、code 和脱敏原因。

## 本次范围及限制

- 图片：18 个已核对同步协议的目录型号，实际导入与 Key 可用目录取交集；同名且归属其他产品的 ID 会提示冲突并跳过，不合并定价、不创造渠道前缀。
- 视频：seedance-2.0-YZ、seedance-2.0-Fast-YZ、seedance-2-0-mini；4–15 秒，9 图/3 视频/3 音频。标准版 480p/720p/1080p，Fast 与 mini 为 480p/720p。
- 不导入未核实型号。示例冲突：dola2.0 简介固定 15 秒/720p，参数表却为 4–30 秒及三档分辨率；SD2.0 简介 5–15 秒，参数表 4–30 秒。需要上游明确后再开放。
- 独立首尾帧组合尚未确认，当前路由不开放。图片参考数量在本站保守限制为 1，并非宣称上游最大值为 1；图片分辨率使用 default 和明确 size/quality，不把名称中的 4K 当作经过验证的尺寸保证。
- 图片异步模式尚未接入：文档仅提供 /v1/tasks 查询中的 result:null，未给出图片异步终态结果结构。显式 async 参数被拒绝；同步请求若意外返回任务编号，会保存编号并进入待核实，不重发、不退款。
- 新导入模型默认停用，不自动写售价或覆盖管理员价格、开关、已有路由参数。模型目录外或冲突型号在同步 warnings 中明确显示。

## 实际调用链

1. 后台 ChannelsPage → ChannelService → apipathCatalogService：类型、连接测试、Key 模型目录、停用模型与规格路由。
2. 网站视频及图片入口、外部 v1 图片/视频入口调用 handleSpecificationGeneration；视频批量队列经原 video 入口进入相同规格执行服务。
3. specificationGenerationService 创建订单和预扣，视频 claimVideoSubmission 防并发，specificationAdapters 的通联专属分支发送；apipathRequest 不经过其他渠道的提交错误规则。
4. 视频 ID 回调即时 acceptVideoSubmission；同次提交失败终态先处理。pollSpecificationVideo 使用独立通联解析，失败进入原 failTask/幂等退款账本，成功进入下载及 complete 结算。
5. 完成结果地址独立保存为 apipathCompletedReceipt，下载失败继续保存原结果；resumeSpecificationTasks 及 VideoRecoveryService 查询原编号，禁止重新生成。
6. 图片沿用原逐任务预扣/保存/结算；本次图片及视频都不改变其他渠道解析规则。

## 验证和交付状态

- 通联入口集成测试 16 项：正常视频完成/失败、400/401 拒绝且退款一次、缺 ID/断线/HTML/502 不重发、不退款、即时失败、任务 ID 先保存、原任务恢复、同步图片、参考图 multipart、管理员价格开关保留、查询异常后继续、下载失败后重存、错误响应带 ID 的持久化。
- 9 个相关测试文件共 487 项通过：包含通联、Vx、Megaby、规格路由、批量服务/入口、并发占用、预扣账本与入口回归。通联新增测试直接执行规格服务及隔离内存账本；其他文件为原渠道及队列回归，不等于通联真实上游验证。
- TypeScript 检查通过。前端构建通过；首次构建遇系统临时目录权限问题，改用此隔离目录下的临时目录后通过。保留既有大包及动态导入提示。
- 本次提交仅包含通联接入代码、测试及协议记录；临时构建目录和其他工作区改动不在提交范围。未部署；未提供通联 API Key，未进行真实模型同步或付费调用。没有更改生产配置。

部署后后台新增渠道选择“通联（图片和视频）”，地址 https://online.apipath.top，配置 Key 后测试连接、同步模型、设置售价并按需启用。

图片与视频使用不同 Key 时，分别创建“通联－图片”和“通联－视频”两条渠道，类型均为 apipath，分别配置 Key 并同步其授权模型。每条通联渠道保存一个 Key；已有任务按保存的原渠道恢复。

## 截图指定型号扩展（2026-10-31）

进一步读取公开 `/api/models/{model_code}` 中的 `runtime_rule`，并与截图、API 文档交叉核对。新证据存入 `apipath-protocol-evidence.json` 的 selectedModelDetails，不采用其中的上游售价作为本站售价。

| 截图型号 / 上游编码 | 本次规格 | 素材 |
| --- | --- | --- |
| Seedance 2.5-1080P-福利特价 / seedance2-5-特惠-1080p | 1080p，5–30 秒，9:16 / 16:9 | 9 图、3 音频，不支持参考视频 |
| Seedance-2.0-mini-480-GK | 480p，4–15 秒，1:1 / 9:16 / 16:9 | 9 图、3 视频、3 音频 |
| dola2.5 | 720p，仅 5 / 10 / 15 秒，1:1 / 9:16 / 16:9 | 9 图，不支持参考音视频 |
| GPT Image 2.5 Sunburst（渠道1） / gpt-image-2-5-sunburst | 1K / 2K / 4K 独立规格 | 最多 4 张参考图 |

第一款视频的 1:1 尚未开放：用户要求三种比例，但官方 API 文档和 runtime_rule.video.supported_aspect_ratios 均只有 9:16、16:9，已向用户询问是否有另外的上游确认。时长采用截图 5–30 秒，与文档 4–30 秒的共同范围；不自动修改用户提交时长。dola2.5 采用截图及官方 description/prompt_hint 明确限定的 5/10/15 秒，而非自动生成的宽泛 4–15 秒范围。

Sunburst 新公开 ID 为 `gpt-image-2-5-sunburst-1k`、`gpt-image-2-5-sunburst-2k`、`gpt-image-2-5-sunburst-4k`，均映射同一真实上游编码。遵循仓库每个图片规格固定一个分辨率的规则，设置 imageFamily，保留原 default 入口、原定价及开关；新规格默认停用，不迁移或覆盖管理员价格。

上游模型详情明确 `supports_large_sizes=true`，model_by_size 含三个档位。尺寸映射来自其公开图片工具栏 `3494-68548595f3f5364a.js`，通过 `size` 传给 OpenAI Images 接口；普通生成和 multipart 编辑使用相同映射。例如：

| 比例 | 1K | 2K | 4K |
| --- | --- | --- | --- |
| 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
| 16:9 | 1280×720 | 2560×1440 | 3840×2160 |
| 9:16 | 720×1280 | 1440×2560 | 2160×3840 |

另支持 4:3、3:4、3:2、2:3、21:9。4K 是上游档位名称，并非保证所有比例的长边均为 4096。显式 size 与选定规格冲突时，在预扣前拒绝，不能默默覆盖 size 或降档。该规则仅作用于新增 Sunburst 规格，其他渠道保持原行为。

验证：11 个测试文件共 541 项通过，其中通联入口集成测试 44 项；包含新增视频各比例/时长、非法规格预扣前拒绝、图片尺寸、四图编辑、管理员定价和开关保留、图片/视频分开 Key 的实际选择与记录。类型检查、前端构建通过。仍未真实付费调用、合并 main 或部署；第一款视频 1:1 仍待协议确认。

## 模型描述补充（2026-10-31）

上述接入已合并 main（96dd6b5）。用户确认第一款视频先开放文档已确认的 9:16、16:9，不开放 1:1。

本次为三款视频及 Sunburst 1K / 2K / 4K 六个规格补全用户可见描述：视频明确分辨率、整数秒范围或固定时长、比例、参考图/视频/音频数量与独立首尾帧限制；图片明确八种比例、最多四张参考图、每次一张输出、不接收音视频，并列出各档位尺寸示例和 4K 档位说明。文案依据本文件已核对的协议记录与实际规格限制，不改变生成参数。

后台“同步模型”首次导入使用新描述；再次同步仅替换这六个规格的旧默认描述或空描述，保留管理员自定义说明、价格、开关和路由。更新网站代码后，已有模型需要对其通联渠道重新同步才会更新描述。

验证：通联集成测试 51 项通过，新增覆盖六个规格首次导入、旧文案/空文案更新、自定义说明及价格/开关/路由保留、其他渠道同名模型和非目标模型不变。TypeScript 检查与前端构建通过（保留既有大包和动态导入提示）。本次未部署或修改线上配置，未发起付费调用。
