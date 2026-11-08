# 画布到 HM 的引用标记修复

2026-11-08。

画布 `resolveReferenceMentions` 将稳定节点绑定转换为按实际提交顺序编号的“参考图片N / 参考视频N / 参考音频N”。HM 的 `materials` 却命名为 `ImageN / VideoN / AudioN`，原适配器仅转换旧式 `[ref_*]`，因此画布三类引用没有形成明确的 HM 标记。

修复位于 HM 的全能参考提示词构造过程：将有对应提交素材的画布标记映射为 `@ImageN / @VideoN / @AudioN`。保留旧标记、原生标记、首尾帧模式和其他渠道处理；不把不同渠道的图片起始编号统一（现有 HM 与 MJNewAPI 的旧图片标记规则不同）。不凭空生成不存在的引用，也不部分匹配多位编号。

调用点已检查：网站直接提交与恢复路径在 `server/routes/video.ts`，规格提交在 `server/services/specificationAdapters.ts`，均经过 `buildHmStudioVideoPayload` 和共用表单构造器。未修改提交调度、状态、计费和退款；未重放生产任务。

验证覆盖：真实画布绑定和重排解析接入 HM 表单构造，逐项比对图片、视频、音频提示词名称和 materials URL；多位编号、无对应素材、旧标记兼容；HM 目录集成、画布交互及引用测试。TypeScript 检查通过。未做付费上游调用，不能保证特定模型生成结果一定遵从音频；用户反馈任务尚缺模型与任务编号，不能据此判定该任务的唯一原因。

发布复核：与图片放大修复一起交付，已合并 origin/main 的 0ffded5。合并后 221 项测试通过；1 项既有 HM 定价界面测试无法找到“1080p 单价”，在未修改的 origin/main 上独立复现。类型检查与构建通过。VPS 部署和生产效果验证尚未执行。
