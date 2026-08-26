# Unified Video Entry API (统一视频生成接口规范)

本文档说明视频生成网关系统的统一 API 调用方式。新规范统一了参数映射、异步轮询与二进制流下载逻辑，兼容 JSON 及 Multipart Form 格式提交。

---

## 1. 统一创建视频任务

- **请求路径**：`POST /v1/videos` （或 `POST /v1/video/generations`）
- **请求头**：
  - `Authorization: Bearer sk-xxx`
  - `Content-Type: application/json` 或 `multipart/form-data`

### 请求参数说明

| 参数字段 | 类型 | 是否必填 | 默认值 | 兼容别名 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `model` | string | **是** | - | - | 模型标识，如 `seedance-2.5m`, `wan3.0th`, `seedance-2.5-deal` 等 |
| `prompt` | string | **是** | - | - | 视频生成提示词描述 |
| `seconds` | number | 否 | `6` | `duration` | 视频时长（秒）。若同时提供 `seconds` 与 `duration` 且值不同，将返回 400 错误 |
| `ratio` | string | 否 | `"16:9"` | `aspect_ratio` | 画面比例，如 `"16:9"`, `"9:16"`, `"1:1"` |
| `resolution` | string | 否 | `"720p"` | `resolution_name` | 输出清晰度，如 `"480p"`, `"720p"`, `"1080p"` |
| `image_urls` | array[string] | 否 | `[]` | `images`, `image_refs` | 公网图片 URL 列表 |
| `video_urls` | array[string] | 否 | `[]` | `videos` | 公网视频 URL 列表 |
| `audio_urls` | array[string] | 否 | `[]` | `audios` | 公网音频 URL 列表 |

### 响应示例 (HTTP 200 OK)

```json
{
  "id": "task_53",
  "task_id": "task_53",
  "object": "video",
  "model": "seedance-2.5m",
  "status": "queued",
  "progress": 0
}
```

---

## 2. 统一查询任务状态

- **请求路径**：`GET /v1/videos/{task_id}` （或 `GET /v1/video/generations/{task_id}`）
- **请求头**：`Authorization: Bearer sk-xxx`

### 响应状态定义 (`status`)

- `queued`: 任务排队中
- `processing`: 任务生成处理中 (进度 1~99)
- `completed`: 任务成功完成 (进度 100，返回 `url` 和 `result_url`)
- `failed`: 任务生成失败 (自动退费)

### 响应示例 (完成状态)

```json
{
  "id": "task_53",
  "task_id": "task_53",
  "object": "video",
  "model": "seedance-2.5m",
  "status": "completed",
  "progress": 100,
  "url": "https://your-domain.com/v1/videos/task_53/content",
  "result_url": "https://your-domain.com/v1/videos/task_53/content"
}
```

---

## 3. 视频直链下载/播放

- **请求路径**：`GET /v1/videos/{task_id}/content`
- **请求头**：`Authorization: Bearer sk-xxx`
- **响应**：`Content-Type: video/mp4` 二进制文件流直接输出

---

## 4. 支持的模型与单价汇总

| 模型 ID | 计费类型 | 销售价格 | 时长说明 |
| :--- | :--- | :--- | :--- |
| `grok-video-1.5（按秒）` | 按秒 | ¥0.09 / 秒 | 6s ~ 30s |
| `grok-imagine-video-1.5（按次）` | 按次 | ¥0.60 / 请求 | 6s ~ 30s |
| `grok-imagine-video-1.5-preview` | 按次 | ¥0.70 / 请求 | 10s / 15s |
| `seedance-2.5-deal` | 按次 | ¥1.80 / 请求 | 4s ~ 15s |
| `seedance-2.5m` | 按次 | ¥3.00 / 请求 | 4s ~ 25s |
| `wan3.0th` | 按秒 | ¥0.14 / 秒 | 4s ~ 30s；720p；10图/5视频/5个WAV音频；1:1、16:9、9:16、4:3、3:4 |

---

## 5. cURL 与 Python 调用代码示例

### cURL 提交任务
```bash
curl -X POST "https://your-domain.com/v1/videos" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.5m",
    "prompt": "电影感雨夜人像，高画质光影",
    "seconds": 10,
    "ratio": "9:16",
    "resolution": "480p"
  }'
```

### Python 完整轮询与下载示例
```python
import time
import requests

API_KEY = "sk-你的APIKey"
BASE_URL = "https://your-domain.com"

headers = {"Authorization": f"Bearer {API_KEY}"}

# 1. 提交任务
create_resp = requests.post(f"{BASE_URL}/v1/videos", headers=headers, json={
    "model": "seedance-2.5m",
    "prompt": "赛车在城市赛道高速漂移",
    "duration": 15,
    "aspect_ratio": "16:9"
}).json()

task_id = create_resp.get("task_id")
print(f"提交成功，任务ID: {task_id}")

# 2. 轮询状态
while True:
    status_resp = requests.get(f"{BASE_URL}/v1/videos/{task_id}", headers=headers).json()
    status = status_resp.get("status")
    progress = status_resp.get("progress", 0)
    print(f"进度: {progress}% | 状态: {status}")

    if status == "completed":
        video_url = status_resp.get("url")
        print(f"✅ 任务完成，视频流地址: {video_url}")
        
        # 3. 下载视频文件
        video_file = requests.get(video_url, headers=headers)
        with open("output.mp4", "wb") as f:
            f.write(video_file.content)
        print("🎉 视频已成功保存为 output.mp4")
        break
    elif status == "failed":
        print("❌ 生成失败")
        break

    time.sleep(5)
```
