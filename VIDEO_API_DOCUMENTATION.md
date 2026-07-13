# Grok 视频生成与编辑 API 文档

本系统完美集成了对 **Grok Imagine Video** 系列视频模型的代理和缓存支持，支持异步生成任务提交、本地直链代理缓存及视频拼接。

系统分别提供了针对**内部 Web 前端**和**外部开发者（API Key 认证）**的两套 API 体系。

---

## 目录
- [一、 Grok 视频模型概览与计费](#一-grok-视频模型概览与计费)
- [二、 内部 Web API (`/api/video/*`)](#二-内部-web-api-apivideo)
  - [1. 获取可用模型列表](#1-获取可用模型列表)
  - [2. 发起视频生成 (SSE 流式)](#2-发起视频生成-sse-流式)
  - [3. 多段视频合并](#3-多段视频合并)
  - [4. 视频下载代理](#4-视频下载代理)
- [三、 外部开放代理 API (`/v1/*`)](#三-外部开放代理-api-v1)
  - [1. 提交 Grok 视频生成任务](#1-提交-grok-视频生成任务)
  - [2. 查询 Grok 视频任务状态](#2-查询-grok-视频任务状态)
- [四、 客户端集成与代码示例](#四-客户端集成与代码示例)

---

## 一、 Grok 视频模型概览与计费

系统后台预设了以下 Grok 视频模型，可在请求中指定：

| 模型 ID | 功能场景 | 关键参数限制 | 计费模式（可配置费率） |
| :--- | :--- | :--- | :--- |
| **`grok-imagine-1.0-video`** | 文生视频 / 图生视频 | `duration`: `6 / 10`<br>`aspect_ratio`: 支持 `16:9`, `9:16`, `1:1` 等 | 480p/720p 基础费率 |
| **`grok-imagine-video-1.5-preview`** | 图生视频（**强制参考图**） | `duration`: `6 / 10`<br>必须且只能提供 `1` 张参考图 | 1.2倍 480p/720p 基础费率 |
| **`grok-imagine-video-1.5-fast`** | 快速文生视频 / 图生视频 | `duration`: `6 / 10`<br>`aspect_ratio`: 支持 `16:9`, `9:16`, `1:1` 等 | 1.2倍 480p/720p 基础费率 |
| **`grok-imagine-video`** / **`grok-4.3-video`** | Grok 历史版本视频模型 | 时长不作硬性限制 | 480p/720p 基础费率 |

*注：480p/720p 基础费率可在后台设置中动态配置（默认分别为 ¥0.03/秒 及 ¥0.05/秒）。所有生成的视频资源在完成后会自动拦截下载至本地，保证高速分发。*

---

## 二、 内部 Web API (`/api/video/*`)

主要供项目内部 React 页面（如 [VideoPage.tsx](file:///d:/2026-07-04_0129/--main/client/src/pages/analysis/VideoPage.tsx)）使用。接口逻辑定义在 [server/routes/video.ts](file:///d:/2026-07-04_0129/--main/server/routes/video.ts)。

### 1. 获取可用模型列表
*   **请求路径**: `GET /api/video/models`
*   **认证方式**: `Authorization: Bearer <JWT_Token>` (已登录时传)
*   **功能说明**: 获取当前系统支持的 Grok 视频模型、支持的视频长度、分辨率限制及实时单价费率。
*   **响应示例**:
    ```json
    [
      {
        "id": "grok-imagine-1.0-video",
        "name": "Grok 1.0 Video",
        "description": "文生/图生视频，6/10秒",
        "available": true,
        "maxSeconds": 10,
        "allowedSeconds": [6, 10],
        "requireRef": false,
        "series": "1.0",
        "rates": {
          "480p": 0.03,
          "720p": 0.05
        }
      },
      {
        "id": "grok-imagine-video-1.5-preview",
        "name": "Grok 1.5 Preview",
        "description": "图生视频，必须提供参考图，6/10秒",
        "available": true,
        "maxSeconds": 10,
        "allowedSeconds": [6, 10],
        "requireRef": true,
        "series": "1.5",
        "rates": {
          "480p": 0.04,
          "720p": 0.06
        }
      }
    ]
    ```

### 2. 发起视频生成 (SSE 流式)
*   **请求路径**: `POST /api/video/generate`
*   **认证方式**: `Authorization: Bearer <JWT_Token>` (**必填**)
*   **内容格式**: `application/json`
*   **请求参数**:
    ```typescript
    interface VideoGenerateParams {
      prompt: string;               // 视频生成描述词（图生视频可在描述词中用 [@图1] 标识对应的参考图）
      model?: string;               // Grok 模型 ID，默认 "grok-imagine-video"
      aspect_ratio?: string;        // 比例，如 "16:9"、"9:16"、"1:1"、"4:3"、"3:4"、"3:2"、"2:3"、"21:9"
      video_length?: number;        // 时长（秒），如 6 或 10
      resolution?: string;          // 输出分辨率，如 "480p"、"720p"
      reference_images?: string[];  // 参考图片 Base64 DataURL 数组（1.5-preview 必填 1 张，其他模型最多支持 5 张）
    }
    ```
*   **推送事件事件格式 (`data: { ... }`)**:
    后端以 `text/event-stream` 格式持续推送单行 `data: ` 开头的 JSON 字符串：
    *   **建立连接并返回记录 ID**
        `data: {"type": "content_id", "contentId": 123}`
    *   **步骤状态与百分比进度**
        `data: {"type": "status", "message": "视频生成中 40%"}`
        `data: {"type": "progress", "progress": 40}`
    *   **生成成功 (提供已本地化的视频直链)**
        `data: {"type": "complete", "videoUrl": "https://grokai.zhubo.asia/v1/files/video?id=xxxx"}`
        `data: [DONE]`
    *   **生成失败**
        `data: {"type": "error", "message": "模型 grok-imagine-video-1.5-preview 必须提供参考图"}`
        `data: [DONE]`

### 3. 多段视频合并
*   **请求路径**: `POST /api/video/merge`
*   **认证方式**: `Authorization: Bearer <JWT_Token>` (**必填**)
*   **功能说明**: 异步在后台下载多段视频资源，并通过系统 FFmpeg 进行拼接合并，最后输出合成后的 MP4 文件流。
*   **请求参数**:
    ```json
    {
      "urls": [
        "https://domain.com/v1/files/video?id=1",
        "https://domain.com/v1/files/video?id=2"
      ]
    }
    ```
*   **响应**: 直流返回 `video/mp4` 格式的文件流。

### 4. 视频下载代理
*   **请求路径**: `GET /api/video/download`
*   **功能说明**: 主要用于解决浏览器对 MP4 直链默认进行播放而非下载的限制。
*   **请求参数**:
    *   `url`: 视频文件的原始公网 URL (必填，需 URL 编码)
    *   `filename`: 自定义保存文件名 (可选，默认 `video.mp4`)

---

## 三、 外部开放代理 API (`/v1/*`)

主要面向通过系统分配了 `API Key` (如 `sk-xxxx`) 的外部开发者或第三方客户端。接口逻辑定义在 [server/routes/v1.ts](file:///d:/2026-07-04_0129/--main/server/routes/v1.ts)。

### 1. 提交 Grok 视频生成任务
*   **请求路径**: `POST /v1/videos`
*   **认证方式**: `Authorization: Bearer sk-你的APIKey`
*   **内容格式**: `multipart/form-data` (支持参考图直接以上传文件方式提供)
*   **请求参数**:
    *   `model`: string (必填，如 `"grok-imagine-1.0-video"`)
    *   `prompt`: string (必填)
    *   `seconds`: number/string (可选，支持 `6` 或 `10`，默认 `6`)
    *   `size`: string (可选，支持如 `"1280x720"`、`"720x1280"`、`"1024x1024"`，默认 `"720x1280"`)
    *   `resolution_name`: string (可选，支持 `"480p"` 或 `"720p"`，默认 `"720p"`)
    *   `input_reference[]`: File (可选，上传参考图文件，1.5-preview 必须提供)

*   **响应**:
    ```json
    {
      "id": "grok:task_9A2bCD...",
      "object": "video_generation",
      "model": "grok-imagine-1.0-video",
      "status": "pending",
      "progress": 0,
      "created_at": 1782786251
    }
    ```

### 2. 查询 Grok 视频任务状态
*   **请求路径**: `GET /v1/videos/:id`
*   **认证方式**: `Authorization: Bearer sk-你的APIKey`
*   **功能说明**: 轮询查询 Grok 系列视频生成任务的状态。如果任务成功，返回的 `url` 已经过系统本地缓存重写。
*   **请求示例**: `GET /v1/videos/grok:task_9A2bCD...`
*   **响应示例 (未完成)**:
    ```json
    {
      "id": "grok:task_9A2bCD...",
      "status": "processing",
      "progress": 45
    }
    ```
*   **响应示例 (已完成)**:
    ```json
    {
      "id": "grok:task_9A2bCD...",
      "status": "completed",
      "progress": 100,
      "url": "https://grokai.zhubo.asia/v1/files/video?id=grok_cached_xxxx"
    }
    ```

---

## 四、 客户端集成与代码示例

### 1. 前端 React/TypeScript 集成方式
可以直接引入 [client/src/api/video.ts](file:///d:/2026-07-04_0129/--main/client/src/api/video.ts) 中暴露的流式生成接口：

```typescript
import { generateVideo, type VideoSSEEvent } from '@/api/video';

const controller = generateVideo({
  prompt: "一个小黄人在沙滩上晒太阳",
  model: "grok-imagine-1.0-video",
  video_length: 6,
  resolution: "720p",
}, (event: VideoSSEEvent) => {
  if (event.type === 'progress') {
    console.log(`生成进度: ${event.progress}%`);
  } else if (event.type === 'complete') {
    console.log('生成完成，视频直链:', event.videoUrl);
  } else if (event.type === 'error') {
    console.error('生成错误:', event.message);
  }
});

// 如需取消生成:
// controller.abort();
```

### 2. Python 调用外部 API 生成示例
以下展示了通过带 API Key 认证，提交带有本地参考图的 Grok 图生视频任务并轮询的 Python 脚本：

```python
import time
import requests

BASE_URL = "https://grokai.zhubo.asia" # 替换为您的实际部署域名
API_KEY = "sk-你的APIKey"

def main():
    headers = {
        "Authorization": f"Bearer {API_KEY}"
    }

    # 1. 提交 Grok 任务（使用 multipart/form-data 方式）
    url = f"{BASE_URL}/v1/videos"
    data = {
      "model": "grok-imagine-video-1.5-preview",
      "prompt": "make the character in the picture smile, dramatic lighting",
      "seconds": "6",
      "size": "1280x720",
      "resolution_name": "720p"
    }
    
    # 附带上传本地参考图
    files = [
        ('input_reference[]', ('ref.png', open('ref_image.png', 'rb'), 'image/png'))
    ]

    print("正在提交任务...")
    r = requests.post(url, headers=headers, data=data, files=files)
    if r.status_code != 200:
        print("提交失败:", r.text)
        return

    task_data = r.json()
    task_id = task_data.get("id")
    print(f"提交成功，任务 ID: {task_id}")

    # 2. 轮询状态
    while True:
        time.sleep(5)
        res = requests.get(f"{BASE_URL}/v1/videos/{task_id}", headers=headers)
        status_data = res.json()
        status = status_data.get("status")
        progress = status_data.get("progress", 0)
        print(f"当前进度: {progress}% | 状态: {status}")

        if status in ("completed", "success"):
            print("生成成功! 视频直链:", status_data.get("url"))
            break
        elif status in ("failed", "failure"):
            print("生成失败:", status_data.get("error"))
            break

if __name__ == "__main__":
    main()
```
