# HUSS BB Seedance 渠道

HUSS 的 `bb-seedance2.5-301010` 映射为本站已有的公开模型
`bb-2.5-301010`，现有用户 API 无需更换模型名。

后台添加渠道时选择 **HUSS（BB Seedance 视频生成）**，填写
`https://www.huss.top` 和 HUSS API Key，然后测试连接并同步模型。

此型号支持 10–30 秒、720p、16:9/9:16/1:1，以及最多 30 张图片、10 段视频、
10 段音频。服务端以 Bearer Key 调用 `/v1/models`、`/v1/videos` 与
`/v1/videos/{id}`；本地上传的参考素材会转为无账号信息的公网临时地址。

保留旧 BlobDraw 渠道用于查询历史任务；验证 HUSS 可用后，在模型规格中启用 HUSS
线路并停用旧 BlobDraw 线路，避免新任务继续流向旧供应商。
