# Grok2API 图片接口接入文档 (GPT Image 2 & Gemini Image 专属版)

本项目提供了完全兼容 OpenAI 规范的图片生成与图片编辑接口，支持原生 Grok 生图模型、GPT Image 2 系列模型以及 Google Gemini 生图模型。

---

## 1. 基础信息与鉴权

* **API 基础地址 (Base URL)**: `http://<您的服务器IP或域名>:8000/v1`
* **鉴权方式 (Authentication)**: 
  在 HTTP 请求头中携带 Bearer Token：
  ```http
  Authorization: Bearer YOUR_API_KEY
  ```
  *(注：`YOUR_API_KEY` 可在管理后台的“账号管理”中创建)*

---

## 2. 支持的模型列表

| 模型标识 (model) | 类型 | 扣费单价 (美元/次) | 上游源模型名称 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **gpt-image-2** | 文生图 | 0.04 | gpt-image-2 | GPT Image 2 基础版 |
| **gpt-image-2-plus** | 文生图 | 0.08 | gpt-image-2-plus | GPT Image 2 增强版 |
| **gpt-image-2-pro** | 文生图 | 0.08 | gpt-image-2-pro | GPT Image 2 专业版 |
| **gpt-image-2-max** | 文生图 | 0.12 | gpt-image-2-max | GPT Image 2 旗舰版 |
| **gemini-3.1-flash-image-preview** | 文生图 | 0.14 | gemini-3.1-flash-image-preview | 谷歌 Imagen 3 快速版 |
| **gemini-3-pro-image-preview** | 文生图 | 0.20 | gemini-3-pro-image-preview | 谷歌 Imagen 3 高画质版 |
| **grok-imagine-image-edit** | 图生图/编辑 | 0.04 | - | 仅限 Grok 官方图生图 |
| **gpt-image-2-pro** (用于 edits) | 图生图/编辑 | 0.08 | gpt-image-2-pro | 支持 GPT Image 2 图生图编辑 |

---

## 3. 接口 1：文生图 (Text to Image)

* **接口路径**: `POST /images/generations`
* **请求头**: 
  * `Content-Type: application/json`
  * `Authorization: Bearer YOUR_API_KEY`

### 请求参数 (JSON)

除了 OpenAI 标准参数外，针对 **GPT Image 2** 和 **Gemini** 模型，我们支持以下高级控制参数：

| 参数名 | 类型 | 必填 | 默认值 | 支持的模型 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **model** | string | 是 | - | 所有模型 | 详见支持的模型列表 |
| **prompt** | string | 是 | - | 所有模型 | 描述要生成的图片内容 |
| **size** | string | 否 | "1024x1024" | 所有模型 | 支持 `1024x1024`, `1280x720`, `720x1280`, `1792x1024`, `1024x1792` |
| **response_format** | string | 否 | "url" | 所有模型 | 可选 `url` (图片链接) 或 `b64_json` (Base64 数据) |
| **quality** | string | 否 | "medium" | **GPT Image 2** | 生图画质与速度平衡。可选：`low` (低画质快速度), `medium` (平衡), `high` (高画质) |
| **output_format** | string | 否 | "png" | **GPT Image 2** / **Gemini** | 输出图片格式。可选：`png`, `webp`, `jpeg` |
| **background** | string | 否 | - | **GPT Image 2** | 背景类型。可选：`white` (白色背景), `black` (黑色背景) |
| **output_compression**| string | 否 | - | **GPT Image 2** | 图像压缩选项。可选：`lossless` (无损), `lossy` (有损) |

### 请求示例 (Python)

```python
import requests

url = "http://<您的服务器IP或域名>:8000/v1/images/generations"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

# 示例：使用 gpt-image-2-pro 生成高画质 webp 格式的白色背景图
payload = {
    "model": "gpt-image-2-pro",
    "prompt": "一个现代极简主义水杯 design，3D渲染",
    "size": "1024x1024",
    "quality": "high",
    "output_format": "webp",
    "background": "white",
    "response_format": "url"
}

response = requests.post(url, json=payload, headers=headers)
print(response.json())
```

---

## 4. 接口 2：图生图 / 图像编辑 (Image to Image / Edit)

* **接口路径**: `POST /images/edits`
* **请求头**: 
  * `Authorization: Bearer YOUR_API_KEY`
  * **注意**: 请勿手动指定 `Content-Type`。

### 请求参数 (Multipart / Form-Data)

| 参数名 | 类型 | 必填 | 默认值 | 支持的模型 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **model** | string | 是 | - | `gpt-image-2-pro` / `grok-imagine-image-edit` | 图像编辑模型标识 |
| **prompt** | string | 是 | - | 所有编辑模型 | 编辑指令 (例如: "参考原图人物动作，转换为动漫风格") |
| **image[]** | file | 是 | - | 所有编辑模型 | 原始参考图片文件。最多支持发送 5 张参考图 |
| **size** | string | 否 | "1024x1024" | 所有编辑模型 | 目前图生图限制输出为 `1024x1024` |
| **response_format** | string | 否 | "url" | 所有编辑模型 | 可选 `url` 或 `b64_json` |
| **quality** | string | 否 | "medium" | **GPT Image 2** | 可选：`low`, `medium`, `high` |
| **output_format** | string | 否 | "png" | **GPT Image 2** | 可选：`png`, `webp`, `jpeg` |

### 请求示例 (Python)

```python
import requests

url = "http://<您的服务器IP或域名>:8000/v1/images/edits"
headers = {
    "Authorization": "Bearer YOUR_API_KEY"
}

data = {
    "model": "gpt-image-2-pro",
    "prompt": "参考原图人物动作，将其置于霓虹雨夜背景中",
    "quality": "high",
    "output_format": "webp",
    "response_format": "url"
}

files = [
    ("image[]", ("reference.png", open("reference.png", "rb"), "image/png"))
]

response = requests.post(url, data=data, files=files, headers=headers)
print(response.json())
```

---

## 5. 常见响应状态码

* **200 OK**: 请求成功，返回生成的图片 URL 或 Base64 数据。
* **401 Unauthorized**: 鉴权失败，请检查您的 API Key 是否正确或额度是否充足。
* **400 Bad Request**: 参数校验失败（例如不支持的图片尺寸或限制字段）。
* **500 Internal Server Error**: 上游服务器错误或中转超时。
