# 六渠道画布素材引用核查（2026-11-08）

## 范围与依据

按用户提供的生产渠道映射核查图片、视频、音频引用。展示名不能决定协议：BB/HSS 当前映射到 Haya Mo，KK/稳定版映射到 V6K。生成成功受理只证明上游接收请求，不证明模型已按提示词使用素材。

| 渠道 | 已核对的规则与处理 | 验证范围 |
| --- | --- | --- |
| V6K | 依实际 upstreamModel 使用各型号的 images/videos/audios 及数量限制；不按 ZH/KK 展示名转换。保留自然语言提示词。 | 全部本地 ZONGHENG_VIDEO_MODELS 增加顺序测试；网站和外部 API 入口已有满量素材、校验、恢复测试。本次未取得公开 SPA 文档的型号级特殊标记语法，不能声称已验证生成效果。 |
| Haya | XG 2.0 用 content 中 image_url/video_url/audio_url；Mo 及其他已接入型号用各自素材数组。Mo 不使用 HUSS/MX 标记。 | XG 2.0、XG 2.5、Mo 重排与分类型顺序；独立上限及入口测试。 |
| 智影 | 先上传到 /v1/files，生成提交归属当前渠道的 file ID，分别放入 reference_images/reference_videos/reference_audios。 | 实际上传字节→文件 ID→生成请求，验证顺序和提示词保持；网站/API、恢复测试。 |
| Vx-乐 | 2.0B 固定 15 秒、最多 9 图，reference_images；不支持视频、音频、独立首尾帧。 | 实际网站提交 9 图及引用文字；视频/音频在扣费和提交前拒绝。旧测试夹具改为明确自定义别名并同步渠道映射，符合现有目录准入。 |
| FunAI | **修复 Kling O3 前三张元素图的画布标记为 @Image1～3**。第四至六张仍是风格参考，不能编造 @Image4～6。其他型号保持各自角色字段。 | 重排、1/10 边界、原生标记、风格图保留、Omni 隔离；真实规格提交入口捕获模拟上游请求。 |
| snumom | WAN、sd-mini 使用各自图片/视频/音频对象数组；Muse/Grok 按型号能力处理。不能将文档中其他 Seedance 型号的小写标记套到这些型号。 | 当前全部 SNUMOM_VIDEO_MODELS 的引用顺序与提示词；Muse、明确拒绝、型号参数回归。 |

协议来源：

- [FunAI 文档](https://ztyunjuan.com/docs/compatibility.md)，页面加载的 app.js 与 model-data.js 明确 Kling O3 前三张元素图、后三张风格图规则；未发现可适用于全部型号的视频/音频命名标记约定。
- [Haya Mo 文档](https://hayaai.cc/docs/models/mo-seedance-2.5-720p/)、[Haya 总文档](https://hayaai.cc/docs)，结合仓库 HAYA_INTEGRATION.md。未据自然语言示例臆造原生标记。
- [智影 OpenAPI](https://zhiyingai.xyz/api/openapi)、[智影文档](https://zhiyingai.xyz/api/docs)，结合 ZHIYING_VIDEO.md。
- Vx-乐原始已提供协议记录于 ASYNC_VIDEO_CHANNEL.md。
- [snumom 文档](https://snumom.com/docs/wan-3.0.html)，同页含多个不同模型章节；WAN NSFW 参数复用依据已有用户确认，见 SNUMOM_WAN_NSFW.md。
- [V6K 公开文档入口](https://www.v6k.top/docs?guide=unified&category=video)，本次取得应用壳与公开脚本；型号参数依仓库已保存的独立协议与既有入口契约。

## 额外确认并修复的音频丢失路径

CanvasStudio 仅在多模态模式发送 audio_urls，但 videoInputError 的动态规格分支曾允许视频编辑模式带音频通过。现在在同一提交前校验入口明确提示切换多模态，避免已连接音频未被提交。未改变模型能力或自动删素材。

实际路径：CanvasStudio → /api/video/generate → 规格处理/各渠道提交；外部 /v1/videos 同样使用对应构造器，规格线路在 specificationAdapters 选择最终 upstreamModel。FunAI 标记修复落在实际调用的 buildFunAiVideoPayload。未改变任务受理、ID 保存、恢复、计费或退款规则。

## 验证结果与限制

- 14 个相关测试文件 **360 项通过、0 失败**；包括六渠道适配器、FunAI/Haya/Vx-乐入口、智影入口与恢复、snumom 拒绝及画布校验。
- V6K 入口扩展测试 **239 项通过、4 项失败**。4 项均为公开开发者目录价格展示断言，在未修改 HEAD 的隔离基线复现相同失败；本次不修改无关价格展示规则，也不将其记作通过。
- TypeScript 检查、前端生产构建、git diff --check 通过。
- 没有付费生成、生产重试或 VPS 部署。已确认格式问题修复与本地契约核查，不等同于所有上游实际生成遵从性验证；V6K 型号级特殊引用语法仍缺可确认依据。
