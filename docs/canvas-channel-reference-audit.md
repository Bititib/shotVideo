# 跨渠道画布引用核查（2026-11-08）

后续六渠道逐项核查、修复与验证见 [六渠道引用核查](canvas-six-channel-reference-audit.md)。以下未验证列表是前一批次的历史范围，不代表后续核查结果。

## 确认缺口与修复

画布通过稳定节点绑定，将 @图片N / @视频N / @音频N 转成实际按类型提交顺序的“参考图片N / 参考视频N / 参考音频N”。这些编号从 1 开始，不能走旧图片占位符从 0 开始的转换再加 1。

| 渠道 | 已有适配协议的目标标记 | 本次处理 |
| --- | --- | --- |
| HM | @ImageN / @VideoN / @AudioN | 前一提交已修复，继续回归 |
| MJNewAPI | @ImageN / @VideoN / @AudioN | 补画布标记转换 |
| NewToken Seedance | @ImageN / @VideoN / @AudioN | 补转换；Veo 分支保持原有语义 |
| 苏打水 | @imageN / @videoN / @audioN | 补转换，保留小写 |
| LongXia | @imageN / @audioN | 补转换并沿用越界校验；仍拒绝视频参考 |
| 四月天 Seedance/C2 | @ImageN / @VideoN / @AudioN | 补直接提交路径和共用构造器，覆盖外部 API/规格入口 |

依据为仓库已接入的各渠道独立序列化规则、其契约测试，以及 LONGXIA_API.md。公共工具只做字面标记转换，名字由各适配器明确传入，不包含统一业务状态或协议默认值。旧占位符、已原生标记和素材数组次序保持原样。

调用链：CanvasStudio → /api/video/generate → 各渠道 payload；/v1/videos 同样调用相应构造器；规格线路通过 specificationAdapters；批量任务走视频提交入口。四月天网页旧分支存在独立替换代码，因此另行补齐。原任务恢复路径不新增生成或改变任务 ID、扣退费。

## 不能冒充已验证的部分

- HUSS：实际读取 https://www.huss.top/api-docs/unified-video.md ，文档只明确 **MX** 使用 @image_1 / @video_1 / @audio_1。本站接入 BB/HSS，不能据此套用 MX 规则。现有提示词透传和 reference_images/reference_videos/reference_audios 顺序保持。
- Megaby：已保存接入文档规定 referenceImages/referenceVideos/referenceAudios；未记录特殊提示词标记要求，保持原文与数组顺序。
- V6K（原纵横）：公开文档 URL 返回前端应用壳，未取得型号级标记协议；保持现有 prompt 与素材结构，未宣称引用效果已验证。
- Haya、海底月、喵呜、巨轮、智影、FunAI、snumom/Wan：检查了各自 payload 构造，保留各自 content/URL/素材结构及能力限制。当前证据不足以统一替换为 HM 标记；没有因为缺少转换代码就断言上游不支持自然语言引用。
- 本次范围是视频生成中的图片、视频和音频参考，不改变纯图片生成、配音合成或未接入型号。

## 验证与交付

新增真实画布绑定/重排解析 → 渠道 payload 的测试，比对三类标记和实际素材顺序；覆盖图片 1/10、旧图片 0/9、无效 0、大小写和 LongXia 不支持视频的拒绝。LongXia 外部 API 入口集成测试实际捕获模拟上游请求，证明中文音频引用在提交时变成对应标记且不重复补写。

运行相关适配器、规格路由、四月天和 LongXia 入口回归，以及 TypeScript 检查；没有付费生成或生产重试。测试只能证明发送格式和编号，不能证明所有上游生成模型遵从程度。其余未明确协议的渠道仍需型号级文档或脱敏成功样本才能继续确认，不能称为“全渠道效果已修复”。VPS 部署未执行。
