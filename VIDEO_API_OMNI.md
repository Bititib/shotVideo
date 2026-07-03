# Omni 视频生成与视频编辑代理 API 文档

> **Base URL**: `https://grokai.zhubo.asia` *(请替换为您的 VPS 实际域名/IP)*  
> **认证方式**: `Authorization: Bearer <API_KEY>`  
> **内容格式**: `Content-Type: application/json`

---

## 1. 概述

本系统完美集成了对第三方 `Omni` 系列视频模型的代理和缓存支持：
*   **`omni-flash`**：用于 **纯文生视频 (t2v)** 或 **多参考图图生视频 (r2v)**，支持 1~7 张参考图。
*   **`omni-flash-vref`**：用于 **视频编辑 / 视频风格改写**，以 1 个参考视频为基础（可选加 0~5 张参考图引导）。

所有通过本接口生成的视频资源，在完成后都会由系统**自动下载并拦截缓存到本地**，并将视频链接重写为本地直链（格式为 `/v1/files/video?id=xxxx`），保证资源的高速下载和防盗链。

---

## 2. 模型计费与参数概览

| 模型 ID | 功能场景 | 计费模式（双倍上游） | 关键参数限制 |
| :--- | :--- | :--- | :--- |
| **`omni-flash`** | 纯文生视频 / 多参考图生成 | 720p: $0.12/秒 <br> 1080p: $0.20/秒 | `duration`: `4 / 6 / 8 / 10`<br>`aspect_ratio`: `landscape / portrait`<br>`images`: `0~7 张` (URL 或 base64 data URI) |
| **`omni-flash-vref`** | 视频编辑 / 视频风格改写 | 720p: $0.22/秒 <br> 1080p: $0.30/秒 | `video`: `1 个参考视频` (URL 或 base64 data URI)<br>`images`: `0~5 张` (可选参考图)<br>`duration`: **固定传 10** *(实际输出时长随原视频)* |

---

## 3. 接口规范

### 3.1 提交任务 (POST /v1/video/generations)

所有任务提交接口统一为异步创建，成功提交后将返回 `task_id`，用于后续轮询。

#### 1) omni-flash 接口参数 (文生视频 / 图生视频)
| 字段 | 类型 | 是否必填 | 默认/可选值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | string | 是 | `"omni-flash"` | 模型名称 |
| `prompt` | string | 是 | - | 视频生成提示词 |
| `duration` | int | 否 | `6` | 视频长度，可选 `4`, `6`, `8`, `10` |
| `aspect_ratio` | string | 否 | `"landscape"` | 比例，横屏 `"landscape"`，竖屏 `"portrait"` |
| `resolution` | string | 否 | `"720p"` | 输出分辨率，可选 `"720p"`, `"1080p"` |
| `images` | array | 否 | `[]` | `1~7 张` 参考图。为空时退化为**纯文生视频**。支持公网图片 URL 或 base64 data URI |

**omni-flash 请求示例 (cURL)**:
```bash
curl -X POST "https://grokai.zhubo.asia/v1/video/generations" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "omni-flash",
    "prompt": "两个动漫角色在绚丽的霓虹城市街道上进行魔法战斗，电影级光影",
    "duration": 6,
    "aspect_ratio": "landscape",
    "resolution": "720p",
    "images": [
      "https://example.com/character1.png",
      "https://example.com/character2.png"
    ]
  }'
```

---

#### 2) omni-flash-vref 接口参数 (视频编辑 / 参考视频风格改写)
| 字段 | 类型 | 是否必填 | 默认/可选值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | string | 是 | `"omni-flash-vref"` | 模型名称 |
| `prompt` | string | 是 | - | 改写风格/光照提示词 |
| `video` | string | 是 | - | 1 个参考视频 (≤30s)。支持公网视频 URL 或 base64 data URI (也可使用 `video_url`) |
| `duration` | int | 是 | `10` | **固定必须传 10**，实际输出时长自适应原视频 |
| `aspect_ratio` | string | 否 | `"landscape"` | 横屏 `"landscape"`，竖屏 `"portrait"` |
| `resolution` | string | 否 | `"720p"` | 输出分辨率，可选 `"720p"`, `"1080p"` |
| `images` | array | 否 | `[]` | `0~5 张` 引导参考图。留空时代表**纯视频编辑风格改写** |

**omni-flash-vref 请求示例 (cURL)**:
```bash
curl -X POST "https://grokai.zhubo.asia/v1/video/generations" \
  -H "Authorization: Bearer sk-你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "omni-flash-vref",
    "prompt": "make it cinematic, dramatic lighting, vivid colors",
    "video": "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    "duration": 10,
    "aspect_ratio": "landscape",
    "resolution": "720p",
    "images": []
  }'
```

---

#### 3) 任务提交响应示例 (JSON)
```json
{
  "id": "zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n",
  "task_id": "zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n",
  "object": "video_generation",
  "model": "omni-flash",
  "status": "pending",
  "progress": 0,
  "created_at": 1782786251
}
```

---

### 3.2 轮询查询任务状态 (GET /v1/video/generations/{task_id})

客户端通过 GET 请求轮询任务执行状态。任务成功时，响应中的视频链接已由系统**自动本地化缓存**。

*   **查询示例 (cURL)**:
    ```bash
    curl -X GET "https://grokai.zhubo.asia/v1/video/generations/zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n" \
      -H "Authorization: Bearer sk-你的APIKey"
    ```

#### 轮询响应示例（已完成，视频被成功代理缓存）
```json
{
  "code": "success",
  "message": "",
  "data": {
    "task_id": "zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n",
    "status": "SUCCESS",
    "progress": "100%",
    "result_url": "https://grokai.zhubo.asia/v1/files/video?id=4c7cca7a-25e4-4274-a2bf-fc25e9fc1762",
    "data": {
      "status": "completed",
      "format": "mp4",
      "url": "https://grokai.zhubo.asia/v1/files/video?id=4c7cca7a-25e4-4274-a2bf-fc25e9fc1762",
      "metadata": {
        "duration": 6,
        "fps": 30,
        "height": 720,
        "width": 1280
      }
    }
  }
}
```

---

## 4. 客户端示例代码 (Python)

以下脚本展示了如何实现本地文件自动转 base64 data URI 并调用 `omni-flash-vref` 进行视频编辑的完整流程：

```python
import base64
import time
import requests

BASE_URL = "https://grokai.zhubo.asia"
API_KEY = "sk-你的APIKey"

def file_to_data_uri(file_path: str, kind: str) -> str:
    """自动将本地文件转为 data URI (支持 image/video)"""
    with open(file_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    if kind == "video":
        mime = "video/mp4"
    else:
        mime = "image/png" if file_path.lower().endswith(".png") else "image/jpeg"
    return f"data:{mime};base64,{b64}"

def main():
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }

    # 1. 准备视频和参考图 (支持公网URL 或 本地路径)
    video_source = "./input_video.mp4"  # 本地视频路径
    image_source = "./ref_style.png"    # 本地参考图路径

    # 转换为统一的 URL/DataURI 格式
    video_uri = file_to_data_uri(video_source, "video")
    image_uri = file_to_data_uri(image_source, "image")

    # 2. 构造 omni-flash-vref 视频编辑请求 payload
    payload = {
        "model": "omni-flash-vref",
        "prompt": "glowing neon lines outline the characters, cyber-punk style",
        "video": video_uri,
        "duration": 10,  # vref 固定只能传 10
        "aspect_ratio": "landscape",
        "images": [image_uri]  # 传入0-5张引导参考图
    }

    print("正在提交视频编辑/参考视频任务...")
    r = requests.post(f"{BASE_URL}/v1/video/generations", json=payload, headers=headers)
    if r.status_code != 200:
        print("任务提交失败:", r.text)
        return

    task_data = r.json()
    task_id = task_data.get("id") or task_data.get("task_id")
    print(f"任务提交成功，任务ID: {task_id}")

    # 3. 轮询状态
    print("开始轮询任务状态 (每 8 秒一次)...")
    for i in range(100):
        time.sleep(8)
        poll_resp = requests.get(f"{BASE_URL}/v1/video/generations/{task_id}", headers=headers)
        if poll_resp.status_code != 200:
            print(f"查询出错: {poll_resp.text}")
            continue

        result = poll_resp.json()
        data_block = result.get("data", {})
        status = data_block.get("status")
        progress = data_block.get("progress")

        print(f"[{i+1}] 进度: {progress} | 状态: {status}")

        if status == "SUCCESS":
            local_video_url = data_block.get("result_url") or data_block.get("data", {}).get("url")
            print(f"\n🎉 视频编辑成功! 本地代理直链: {local_video_url}")
            break
        elif status in ("FAILURE", "failed"):
            print("❌ 视频生成失败:", data_block.get("fail_reason"))
            break
    else:
        print("⏱️ 轮询超时")

if __name__ == "__main__":
    main()
```
