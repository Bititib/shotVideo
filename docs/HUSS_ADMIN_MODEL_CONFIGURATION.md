# HUSS 后台模型配置

核对日期：2026-11-20。

## 协议依据与范围

- https://www.huss.top/api-docs/unified-video.md
- https://www.huss.top/api-docs/unified-capabilities.json
- https://www.huss.top/api-docs/video-error-handling.md
- https://www.huss.top/api-docs/huss_video_client.py
- https://www.huss.top/api-docs/midjourney-style.md

以上公开文档已直接读取成功。公开能力表当时包含 7 个视频型号，但它不是账号完整授权目录。
后台读取当前渠道 Key 的 GET /v1/models **全部 ID**，再请求
GET /v1/videos/models，携带 X-Huss-Video-API: unified-v1，按真实能力描述匹配。
不存在 7 个型号的后台准入白名单；测试包含 12 个没有预先写入代码的账号视频型号。

统一能力解析使用 duration（范围/枚举/步长/默认值）、resolutions、ratios、reference_limits、
reference_transport 和 requirements。暂不能解析或有未适配专属要求的型号仍显示在列表中并注明原因，
不猜参数，也不作为已接入型号保存。能力接口失败时保留完整授权列表与错误原因，不静默切回旧固定列表。
Midjourney V8.2 继续使用原图片异步契约；原渠道 B 保留已有专属协议能力。
shared/hussUnifiedModels.ts 的公开表快照用于兼容已核对的旧直接调用/恢复，不用于裁剪后台授权列表。

## 配置及执行路径

渠道管理 → HUSS → 模型与参数 → 添加新模型 → 读取已授权的上游型号。
选择型号后自动填写能力，可收窄规格，超范围时指出具体字段。新本站模型 ID 由管理员填写，
不自动添加渠道前缀；Midjourney 保留原公共 ID，以继续使用原风格控件和四图交付。
新模型默认停用，本站售价由管理员单独设置，不覆盖现有价格、余额或启用状态。

后台 HTTP 路由沿用 channelModelConfigurationService：读取、授权目录、预览、保存均接入 HUSS 分支。
保存前重新读取授权与实时能力，并检查配置版本、Key 变更、ID 占用和删除标记。
视频线路保存 huss.protocol=unified-v1 以及经过校验的 limits；启动关联清理识别这些线路。
HUSS 同步保留管理员创建的线路和参数，不自动恢复 deleted_model_ids 中的模型。

网站、外部 API、批量入口仍进入原规格执行器。specificationAdapters 将线路能力交给 HUSS 构造器，
预览也调用同一构造器，不发送付费 POST。
统一视频 POST /v1/videos 使用 reference_images/reference_videos/reference_audios；
提交前持久化原幂等键、请求体、统一模式与配置能力快照，能力快照不发送上游。
未知受理不降级到旧回执接口；按原键和原请求找回。已有 ID 继续 GET 原任务及 /content 下载。
查询暂时错误不判失败，保存失败保留成品证据并重试；明确拒绝沿原幂等账本结束/退款。
Midjourney 保留原 images/*/async 提交、images/tasks 查询和图片交付恢复。

## 验证

12 个相关测试文件，170 项通过；TypeScript 检查通过；前端生产构建通过（已有分包大小提示）。
覆盖完整授权列表、超过公开表数量的动态型号、缺失能力的可见原因、参数与权限拒绝、
预览字段、默认停用、价格不变、重复同步、启动清理、已删除模型不恢复，以及真实规格执行器的
提交/查询/完成、查询 503 恢复、保存失败重试和一次性扣退费。
恢复测试核对相同幂等键与相同请求体，内部能力快照不泄露到上游。
旧 HUSS 诊断测试已校正为：内部保留请求编号，用户错误显示具体原因而隐藏编号与密钥。

只进行了公开文档读取和模拟验证，未执行生产部署、账号授权查询或付费生成。
