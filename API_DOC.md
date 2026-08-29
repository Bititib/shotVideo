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

> 示例 ID 仅说明响应格式。请以接口实时返回结果为准。模型列表保持 OpenAI 兼容格式；价格请通过下方价格接口查询。

### 2.1 获取可用模型价格

获取当前 API Key 可调用、且已经配置计费规则的模型价格：

```http
GET /v1/pricing
```

也可以查询单个模型：

```http
GET /v1/pricing/{model_id}
```

```bash
curl "https://你的域名/v1/pricing" \
  -H "Authorization: Bearer sk-你的APIKey"
```

```json
{
  "object": "list",
  "currency": "CNY",
  "data": [
    {
      "model": "sd2.5",
      "display_name": "Seedance 2.5 (sd2.5)",
      "capabilities": ["video"],
      "currency": "CNY",
      "billing_type": "per_call",
      "unit": "request",
      "unit_price": 3.5,
      "output_unit_price": 0,
      "resolution_prices": {},
      "matched_pattern": "sd2.5",
      "inherited": false
    }
  ]
}
```

价格列表使用与 `/v1/models` 相同的启用渠道和 Token 模型白名单过滤规则。未配置计费规则的非文本模型不会出现在列表中，也不会被当作免费模型；单模型查询会返回 `404`。

计费单位：`request` 表示按次，`second` 表示按秒，`million_tokens` 表示每百万 Token，`character` 表示按字符。`resolution_prices` 非空时表示特定分辨率单价。

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

兼容别名：`POST /v1/video/generations`、`POST /v1/videos/generations`。

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
| `video_urls` | string[] | 否 | - | 视频 URL；支持别名 `videos`；单视频编辑也支持 `video_url` |
| `audio_urls` | string[] | 否 | - | 音频 URL；支持别名 `audios` |

文件上传字段支持 `image`、`images`、`input_reference[]`、`video`、`videos`、`reference_video`、`audio`、`audios` 和 `reference_audio`。

`veo-omni-flash-video-edit` 为固定10秒的视频编辑模型：必须提供1个 `video_url`，可选 `Ingredients_images` 多张参考图，只支持 `16:9` 或 `9:16`，按 ¥0.09/秒计费。

创建成功：

```json
{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "sd2.5",
  "status": "queued",
  "progress": 0,
  "queue_position": 3,
  "queue_running": 18,
  "queue_limit": 20,
  "channel_running": 9,
  "channel_limit": 10,
  "user_concurrency_limit": 2,
  "status_url": "https://你的域名/v1/videos/task_123",
  "retry_after": 5
}
```

HM Studio 视频任务始终立即返回本地任务 ID。达到并发上限时任务进入公平队列，不会继续向上游提交。
`status_url` 是后续状态查询地址；调用方应按 `retry_after` 秒轮询，不能把创建接口返回的 `202 queued` 当作生成完成。

### 6.2 查询任务

```http
GET /v1/videos/{task_id}
```

兼容别名：`GET /v1/video/generations/{task_id}`、`GET /v1/videos/generations/{task_id}`。

只有创建该任务的 API Key 可以查询任务；旧任务按关联用户校验。

排队期间响应包含 `queue_position`、`queue_running`、`queue_limit` 和 `user_concurrency_limit`。`queue_position=1` 表示下一项将被调度。

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

失败时返回：

```json
{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "sd2.5",
  "status": "failed",
  "progress": 0,
  "error": "Upstream rejected the reference image",
  "error_message": "Upstream rejected the reference image",
  "failed_at": "2026-08-29T10:20:00.000Z"
}
```

调用方收到 `failed` 后必须停止轮询，并向用户展示 `error_message`。上游持续无响应时，系统默认最多轮询 30 分钟，随后自动失败并执行退款逻辑；可通过 `VIDEO_TASK_POLL_TIMEOUT_MS` 调整。

### 6.3 下载任务内容

```bash
curl -o final.mp4 "https://你的域名/v1/videos/task_123/content" \
  -H "Authorization: Bearer sk-你的APIKey"
```

`GET /v1/files/video?id={upstream_file_id}` 同样需要 API Key。业务系统应优先使用任务查询返回的 `/v1/videos/{task_id}/content` 地址。

### 6.4 查询 HM Studio 队列策略

```http
GET /v1/queue
```

```json
{
  "object": "queue_status",
  "provider": "hmstudio",
  "strategy": "round_robin_by_user_fifo_within_user",
  "running": 18,
  "queued": 6,
  "concurrency_limit": 20,
  "pool_count": 2,
  "per_key_concurrency_limit": 10,
  "user_concurrency_limit": 2,
  "max_user_queue": 10,
  "max_queue": 200,
  "pools": [
    {"pool_id": "key-a1b2c3d4e5f6", "running": 9, "queued": 3, "concurrency_limit": 10},
    {"pool_id": "key-1a2b3c4d5e6f", "running": 9, "queued": 3, "concurrency_limit": 10}
  ]
}
```

调度规则：每个不同的 HM Studio API Key 独立提供 10 个并发名额，两个 Key 即为 20；相同 Key 配置多次只计算一个池。系统优先选择负载较低且支持目标模型的 Key。用户之间轮询调度，同一用户内部按提交顺序执行；默认每个用户同时运行 2 项、最多排队 10 项，全局最多排队 200 项。队列满时返回 `429`。

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
- `/v1/models` 不直接返回价格；当前 API Key 可用的模型价格通过 `GET /v1/pricing` 查询。
- 余额不足时返回 `402 Payment Required`。
