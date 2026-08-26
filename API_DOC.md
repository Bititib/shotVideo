# API 接口文档

本文档与当前 `/v1` 路由实现保持一致。模型和渠道可能动态调整，任何生成请求都应先调用 `GET /v1/models` 获取当前 API Key 实际可用的模型 ID。

## 1. 接入信息

```text
Base URL: https://你的域名/v1
```

支持两种认证头：

```http
Authorization: Bearer sk-xxxxxxxxxxxxxxxx
```

或：

```http
X-API-Key: sk-xxxxxxxxxxxxxxxx
```

所有 `/v1` 接口（包括视频内容下载）都必须携带有效 API Key。

常见错误码：

| 状态码 | 含义 |
|---|---|
| `400` | 请求字段缺失或格式错误 |
| `401` | API Key 缺失、无效、已禁用或已过期 |
| `402` | API Key 或关联账户余额不足 |
| `403` | 当前 API Key 无权访问指定模型 |
| `404` | 模型没有可用渠道，或任务不存在 |
| `502` | 上游渠道请求失败或超时 |

## 2. 获取可用模型

```http
GET /v1/models
```

```bash
curl "https://你的域名/v1/models" \
  -H "Authorization: Bearer sk-你的APIKey"
```

响应遵循 OpenAI 模型列表的基础结构：

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "created": 1783309000,
      "owned_by": "system"
    },
    {
      "id": "sd2.5",
      "object": "model",
      "created": 1783309000,
      "owned_by": "system"
    }
  ]
}
```

> 示例 ID 仅说明响应格式。请以接口实时返回结果为准。当前模型列表不包含价格字段。

## 3. 对话补全

```http
POST /v1/chat/completions
Content-Type: application/json
```

只有当 `GET /v1/models` 返回可用于对话的模型时才能调用。若当前没有配置对话渠道，使用任意对话模型都会返回 `404`。

```json
{
  "model": "YOUR_CHAT_MODEL_ID",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 从 `/v1/models` 获取的对话模型 ID |
| `messages` | array | 是 | OpenAI Chat Completions 消息数组 |
| `stream` | boolean | 否 | 默认 `false`；为 `true` 时返回 SSE |
| 其他字段 | any | 否 | 原样透传给上游，是否支持由目标模型决定 |

## 4. 图片生成

```http
POST /v1/images/generations
Content-Type: application/json
```

```bash
curl -X POST "https://你的域名/v1/images/generations" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只在暖色背景中的陶土杯，极简产品摄影",
    "n": 1,
    "size": "1024x1024",
    "response_format": "url"
  }'
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model` | string | 是 | - | 当前可用的图片模型 ID |
| `prompt` | string | 是 | - | 图片描述 |
| `n` | integer | 否 | `1` | 生成数量，范围 `1~4` |
| `size` | string | 否 | `1024x1024` | 尺寸由上游模型决定是否支持 |
| `response_format` | string | 否 | `url` | `url` 或 `b64_json`，由上游决定是否支持 |
| 其他字段 | any | 否 | - | 原样透传给上游 |

成功响应示例：

```json
{
  "created": 1783309200,
  "data": [
    {"url": "https://..."}
  ]
}
```

## 5. 图片编辑

```http
POST /v1/images/edits
Content-Type: multipart/form-data
```

```bash
curl -X POST "https://你的域名/v1/images/edits" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -F "model=gpt-image-2" \
  -F "prompt=将背景替换为温暖的沙岩色" \
  -F "image=@/local/path/to/origin.png"
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 支持图片编辑的模型 ID |
| `prompt` | string | 是 | 编辑说明 |
| `image` / `image[]` | file | 是 | 至少 1 张、最多 5 张图片 |
| `n` | integer | 否 | 生成数量，范围 `1~4` |
| `size` | string | 否 | 默认 `1024x1024` |
| `response_format` | string | 否 | 默认 `url` |

## 6. 视频任务

视频生成是异步接口：创建任务后使用本地 `task_id` 轮询，完成后再下载内容。

### 6.1 创建任务

```http
POST /v1/videos
Content-Type: application/json 或 multipart/form-data
```

兼容别名：`POST /v1/video/generations`。

```bash
curl -X POST "https://你的域名/v1/videos" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sd2.5",
    "prompt": "电影感的暖色山谷，镜头缓慢向前推进",
    "seconds": 10,
    "ratio": "9:16",
    "resolution": "720p"
  }'
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model` | string | 是 | - | 从 `/v1/models` 获取的视频模型 ID |
| `prompt` | string | 是 | - | 视频描述 |
| `seconds` / `duration` | number | 否 | `6` | 同时传入时两个值必须相等 |
| `ratio` / `aspect_ratio` | string | 否 | `16:9` | 画面比例 |
| `resolution` / `resolution_name` | string | 否 | `720p` | 分辨率 |
| `image_urls` | string[] | 否 | - | 图片 URL；支持别名 `images`、`image_refs` |
| `video_urls` | string[] | 否 | - | 视频 URL；支持别名 `videos` |
| `audio_urls` | string[] | 否 | - | 音频 URL；支持别名 `audios` |

文件上传字段支持 `image`、`images`、`input_reference[]`、`video`、`videos`、`reference_video`、`audio`、`audios` 和 `reference_audio`。

创建成功：

```json
{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "sd2.5",
  "status": "queued",
  "progress": 0
}
```

### 6.2 查询任务

```http
GET /v1/videos/{task_id}
```

兼容别名：`GET /v1/video/generations/{task_id}`。

只有创建该任务的 API Key 可以查询任务；旧任务按关联用户校验。

完成时返回：

```json
{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "sd2.5",
  "status": "completed",
  "progress": 100,
  "url": "https://你的域名/v1/videos/task_123/content",
  "result_url": "https://你的域名/v1/videos/task_123/content"
}
```

### 6.3 下载任务内容

```bash
curl -o final.mp4 "https://你的域名/v1/videos/task_123/content" \
  -H "Authorization: Bearer sk-你的APIKey"
```

`GET /v1/files/video?id={upstream_file_id}` 同样需要 API Key。业务系统应优先使用任务查询返回的 `/v1/videos/{task_id}/content` 地址。

## 7. 余额与用量

### 7.1 查询余额

```http
GET /v1/billing/balance
```

```json
{
  "billing": true,
  "key_name": "业务系统 Token",
  "balance": 4820.64,
  "total_charged": 179.36,
  "status": "active",
  "group": "default",
  "is_admin": false
}
```

### 7.2 查询调用明细

```http
GET /v1/billing/usage?page=1&page_size=50
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `start_time` | integer | 可选，开始时间，Unix 毫秒时间戳 |
| `end_time` | integer | 可选，结束时间，Unix 毫秒时间戳 |
| `page` | integer | 默认 `1` |
| `page_size` | integer | 默认 `50`，范围 `1~100` |

```json
{
  "balance": 4820.64,
  "summary": {
    "total_requests": 42,
    "total_prompt_tokens": 12500,
    "total_completion_tokens": 8300,
    "total_tokens": 20800,
    "total_cost": 12.4,
    "success_count": 41,
    "error_count": 1
  },
  "items": [],
  "total": 42,
  "page": 1,
  "page_size": 50
}
```

## 8. 计费说明

- 计费币种为人民币（CNY）。
- 图片通常按次计费；对话通常按 Token 计费；视频根据模型、时长或规格计费。
- 只有上游成功返回后才扣费；失败请求会写入调用日志但不会扣除生成费用。
- 当前公开 `/v1/models` 不返回价格。实际单价以管理后台当前启用的模型计费规则为准。
- 余额不足时返回 `402 Payment Required`。

