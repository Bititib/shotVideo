# HM sd2.5 产品切换 DDLONG

## 协议依据

2026-10-30 只读核对 https://openaivideo.top/ 已登录文档、广场和模型选择器，没有提交付费生成。用户明确要求替换原 sd2.5 30-10-10 模型，素材改为 9/3/3。

- 模型选择按钮的 data-sku 为 `DDLONG:vid:DDLONG-SD2.5`，渠道及模型必须配对、区分大小写；广场成本 4.20 积分/次，不作为本站售价。
- 选择器及混合素材页面确认 720p、4–30 秒、9 图 / 3 视频 / 3 音频。
- HM 文档：JSON `POST /v1/videos/generations`，使用 model、channel、prompt、ratio、duration、video_resolution；混合素材走 function_mode=omni_reference 和 materials 的 type/name/url 数组。
- HTTP 202 返回 task_id，随后使用原身份 `GET /v1/tasks/{task_id}`；success 读取 result_urls，failed 读取 fail_reason。此次不更改终态和资金规则。

## 产品与兼容

- 公开 ID 改为 `sd2.5-933`，前端显示 `HM-Sd2.5-933`。迁移保留模型数字主键、管理员及用户价格、权限、启用状态；旧画布选择、批量参数和 API Key 模型权限同步改名。描述为 9/3/3。
- 新提交指定 model=DDLONG-SD2.5、channel=DDLONG，覆盖旧配置中的 default、nova、lumen。MiniMax-H3 仍走 nova，FAST/MINI 仍走 lumen。
- 普通模型 API、页面、画布读取共享规格，改为 720p。新记录默认售价仍为原有 720p 7 元；数据库已有价格原样保留，包括历史 1080p 价格条目，但新生成请求拒绝 1080p，不自动降清晰度。
- 原产品的专用首尾帧入口保持未开放；上游虽提供首尾帧，此次仅替换现有普通图片/混合素材路径。多帧模式不在该型号能力内，明确拒绝。
- 旧映射 30-10-10、SD2.5-30-10-10 用于内部兼容与同步归一。未发送队列重新校验新规格；超量或 1080p 旧请求拒绝并幂等退款，不截断素材。
- 已受理任务仍以原 task_id 和原渠道身份轮询，历史订单仅归一公开模型名，不修改上游身份、状态、资金及结果，不重新生成。

## 实际执行链

1. shared/hmStudioVideo.ts 定义公开/上游名称、规格及校验；canvasVideoReferences、modelInputPresets、前端能力工具读取此定义。
2. seed 启动校准和 hmStudioCatalogService 同步使用新映射，保留现有价格、开关及权限。
3. video.ts、v1.ts 在预扣前校验规格与准备公共素材，沿用订单、预扣、HM 队列及提交占用。
4. videoBatches 报价/提交复用视频校验；规格路由经 specificationAdapters 校验执行模型。
5. hmStudioAdapter.buildHmStudioVideoPayload 在发送边界再次校验并指定 DDLONG；拒绝标记为本地未发送，队列沿用幂等退款。
6. ID 保存、轮询与 videoRecoveryService 查询原任务。映射替换不触发重新提交。

## 验证

10 个相关测试文件共 357 项通过，覆盖适配器、JSON、web/API/批量入口（内存数据库）、HM 队列、规格路由、画布。验证了完整传递 9/3/3、各类超限和 1080p 拒绝、旧队列未发送且退款一次、收到回执后查询失败继续查原任务、管理员及用户定价保留、其他 HM 型号的渠道不变。另验证启动及后台同步两条入口能从旧公开 ID 迁移，保留用户专属价格、数字主键及权限；冲突时整笔迁移回滚。TypeScript 检查通过。

没有生产部署或付费上游生成。

生产构建通过；仅有既有大体积 chunk 提示。上线后仍需核验实际渠道生成，当前未做生产验证。

## 计费编辑框旧分辨率显示修正

旧规则中的 1080p 价格被迁移保留，计费编辑器原先合并历史价格键与当前能力，导致 933 仍显示 1080p 输入框。现按 DDLONG 当前规格仅展示 720p，计费卡片也隐藏旧分辨率价格；保存当前价格时保留未展示的历史值，不修改管理员价格或用户专属价。其他型号的分辨率展示保持原样。

19 项相关测试通过，包括真实计费页面打开、修改 720p、保存仍保留 1080p 历史值，以及 FAST 1080p/2k 继续展示。类型检查及生产构建通过（既有大 chunk 提示）。
