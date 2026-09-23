# LongXia Seedance 2.5 接入

本站支持以下两个独立的按秒计费模型，支持最多 30 张图片和 10 段音频参考，不支持视频参考：

| 完整模型 ID | 固定分辨率 | 时长 | 默认单价 |
|---|---|---|---|
| `LongXia-video-seedance2_5-standard-480p-express-PerSecond` | 480p | 4～25 秒整数 | ¥0.40/秒 |
| `LongXia-video-seedance2_5-standard-720p-express-PerSecond` | 720p | 4～25 秒整数 | ¥0.58/秒 |

按请求生成时长计算费用；25 秒分别为 ¥10.00 和 ¥14.50。后台已有价格不会被重启覆盖。

## 启用

更新代码并重启服务后，初始化程序会注册两个模型及价格，创建停用的「LongXia 视频渠道」。
在后台渠道管理中填写提供方的 API Key 并启用即可；不要把密钥写入代码或文档。
默认地址为 `https://api8.longxiaai.store`，同时兼容末尾带 `/v1` 的地址。
新建 LongXia 类型渠道时会自动绑定这两个模型。已有 LongXia 渠道在启动时补齐缺失绑定，保留密钥、启停状态及自定义映射。

## 本站统一 API

`POST /v1/videos` 使用本站原有参数：`model`、`prompt`、`seconds`（或 `duration`）、`ratio`（或 `aspect_ratio`）、`image_urls`、`audio_urls`。
分辨率可省略，自动按模型确定；传入与模型不符的分辨率会被拒绝。

```json
{
  "model": "LongXia-video-seedance2_5-standard-480p-express-PerSecond",
  "prompt": "让 @image1 中的人物跟随 @audio1 的节奏起舞",
  "seconds": 8,
  "ratio": "16:9",
  "image_urls": ["https://your-public-host/reference.jpg"],
  "audio_urls": ["https://your-public-host/reference.mp3"]
}
```

这是本站接口参数；适配器会转换为 LongXia 的 `duration`、`size`、`assets`，不会发送上游禁止的 `seconds`、`resolution` 等字段。
素材支持公开 HTTPS URL 或包含 MIME 类型的 Base64 data URL；后者会转换为上游要求的不带前缀的 `data_base64`。
支持 `@imageN`、`@audioN`，兼容网页中文及历史素材标签；缺少的引用会自动补齐，越界引用会报错。

按文档保留 PNG/JPEG/WebP、MP3 格式规则和 9500 字符提示词上限。不支持视频参考及单独首尾帧字段。携带参考视频的请求会在提交上游及扣费前返回 HTTP 400。
文档中的音频时长限制、URL 可下载性和深层媒体校验由上游执行；数量上限不代表素材时长、总大小无限制。
Base64 合计按编码后字符串大小保守限制为 40 MiB，大素材建议使用公开 HTTPS URL。

提交后返回本站 `task_id`，继续通过 `GET /v1/videos/{task_id}` 查询。
后台每 30 秒轮询 LongXia，读取 `data[].url`，并在交付前保存视频到本站存储；失败或取消进入现有失败退款流程。

## 验证范围

本地模拟上游测试覆盖两种型号的请求转换、价格、时长边界、素材数量、错误引用、任务结果解析及网页端提交失败退款。
真实提供方的可用性和生成质量需要配置有效 Key 后验证。
