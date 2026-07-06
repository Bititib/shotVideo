import React, { useState } from 'react';
import { Terminal, Copy, Check, FileText, Globe, Key, User, Play, Image as ImageIcon, Video, HelpCircle, Code, ShieldCheck } from 'lucide-react';

interface Parameter {
  name: string;
  type: string;
  required: boolean;
  defaultVal?: string;
  description: string;
}

interface EndpointDoc {
  id: string;
  title: string;
  method: 'GET' | 'POST';
  path: string;
  description: string;
  parameters: Parameter[];
  curlExample: string;
  pythonExample: string;
  responseExample: string;
}

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<string>('getting-started');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [langTab, setLangTab] = useState<'curl' | 'python'>('curl');

  const triggerCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const getBaseUrl = () => {
    return `${window.location.protocol}//${window.location.host}/v1`;
  };

  const endpoints: EndpointDoc[] = [
    {
      id: 'models',
      title: '获取可用模型列表',
      method: 'GET',
      path: '/v1/models',
      description: '获取当前 API Key 拥有访问权限的全部活跃 AI 模型列表。返回结果格式完全兼容 OpenAI 规范。',
      parameters: [],
      curlExample: `curl -X GET "${getBaseUrl()}/models" \\
  -H "Authorization: Bearer sk-你的令牌Key"`,
      pythonExample: `from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌Key",
    base_url="${getBaseUrl()}"
)

models = client.models.list()
for model in models:
    print(model.id)`,
      responseExample: `{
  "object": "list",
  "data": [
    {
      "id": "gemini-2.5-flash",
      "object": "model",
      "created": 1783309000,
      "owned_by": "system"
    },
    {
      "id": "gpt-image-2-pro",
      "object": "model",
      "created": 1783309000,
      "owned_by": "system"
    }
  ]
}`
    },
    {
      id: 'chat',
      title: '智能对话补全 (Chat Completions)',
      method: 'POST',
      path: '/v1/chat/completions',
      description: '提供基础对话、思维链推理（Thinking）和多模态图像分析服务。流式与非流式调用均直接由组织/个人账户以 Token 消费计费扣减。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '可用的对话模型 ID（如 gemini-2.5-flash）' },
        { name: 'messages', type: 'array', required: true, description: '对话上下文消息数组，格式如 [{"role": "user", "content": "你好"}]' },
        { name: 'stream', type: 'boolean', required: false, defaultVal: 'false', description: '是否使用流式传输。如果为 true，将采用 text/event-stream 协议持续推送生成片段' },
        { name: 'reasoning_effort', type: 'string', required: false, defaultVal: 'none', description: '推理强度选项（支持 expert 等级别启用思维链推理）' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/chat/completions" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "用一句话解释相对论"}],
    "stream": false
  }'`,
      pythonExample: `from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌Key",
    base_url="${getBaseUrl()}"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "用一句话解释相对论"}],
    stream=False
)
print(response.choices[0].message.content)`,
      responseExample: `{
  "id": "chatcmpl-xxxxx",
  "object": "chat.completion",
  "created": 1783309100,
  "model": "gemini-2.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "相对论是由爱因斯坦提出的物理理论，它认为时间和空间是相对且互相关联的，在大质量物体周围会发生弯曲。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 42,
    "total_tokens": 57
  }
}`
    },
    {
      id: 'image-gen',
      title: '文生图 (Text to Image)',
      method: 'POST',
      path: '/v1/images/generations',
      description: '生成全新高质感 AI 场景摄影或设计图像，支持指定分辨率和多样控制参数。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '图像生成模型 ID（如 gpt-image-2-pro、gemini-3-pro-image-preview）' },
        { name: 'prompt', type: 'string', required: true, description: '生图提示词，用于精细刻画生成画面' },
        { name: 'size', type: 'string', required: false, defaultVal: '1024x1024', description: '图片画幅：1024x1024 / 1280x720 / 720x1280 等' },
        { name: 'n', type: 'integer', required: false, defaultVal: '1', description: '一次生成的图片张数，支持 1~4 张' },
        { name: 'quality', type: 'string', required: false, defaultVal: 'medium', description: '画质等级（仅GPT-Image 2支持）：low, medium, high' },
        { name: 'output_format', type: 'string', required: false, defaultVal: 'png', description: '输出文件格式：png, jpeg, webp' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/images/generations" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2-pro",
    "prompt": "一只现代极简主义设计水杯, 3D 渲染, 白色背景",
    "size": "1024x1024",
    "n": 1,
    "output_format": "webp"
  }'`,
      pythonExample: `from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌Key",
    base_url="${getBaseUrl()}"
)

response = client.images.generate(
    model="gpt-image-2-pro",
    prompt="一只现代极简主义设计水杯, 3D 渲染, 白色背景",
    size="1024x1024",
    n=1
)
print(response.data[0].url)`,
      responseExample: `{
  "created": 1783309200,
  "data": [
    {
      "url": "https://grokai.zhubo.asia/v1/files/image/img_xxxx.webp"
    }
  ]
}`
    },
    {
      id: 'image-edit',
      title: '图生图与编辑 (Image Edit)',
      method: 'POST',
      path: '/v1/images/edits',
      description: '提供参考图生图和局部细节修改能力。需要通过 multipart/form-data 方式发送文件。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '图像编辑模型（如 gpt-image-2-pro、grok-imagine-image-edit）' },
        { name: 'prompt', type: 'string', required: true, description: '图像改写/编辑修改描述词' },
        { name: 'image', type: 'file', required: true, description: '参考图文件（多文件时使用 image[]，最大可传 5 张）' },
        { name: 'size', type: 'string', required: false, defaultVal: '1024x1024', description: '目前固定输出 1024x1024 分辨率' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/images/edits" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -F "model=gpt-image-2-pro" \\
  -F "prompt=将图片中的背景替换为繁华霓虹都市" \\
  -F "image=@/local/path/to/origin.png"`,
      pythonExample: `# 使用 requests 发送 multipart/form-data
import requests

url = "${getBaseUrl()}/images/edits"
headers = {"Authorization": "Bearer sk-你的令牌Key"}
files = {"image": ("origin.png", open("origin.png", "rb"), "image/png")}
data = {
    "model": "gpt-image-2-pro",
    "prompt": "将图片中的背景替换为繁华霓虹都市"
}

resp = requests.post(url, headers=headers, data=data, files=files)
print(resp.json()["data"][0]["url"])`,
      responseExample: `{
  "created": 1783309300,
  "data": [
    {
      "url": "https://grokai.zhubo.asia/v1/files/image/img_edit_xxxx.png"
    }
  ]
}`
    },
    {
      id: 'grok-video',
      title: '创建 Grok 视频任务',
      method: 'POST',
      path: '/v1/videos',
      description: '利用 Grok 视频生成引擎异步创建长视频任务，支持 6s ~ 30s。需要使用 multipart/form-data 上传参考图及配置。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '视频模型标识：grok-imagine-video' },
        { name: 'prompt', type: 'string', required: true, description: '视频画面的文字描述词' },
        { name: 'seconds', type: 'integer', required: false, defaultVal: '6', description: '视频长度（秒），可选：6, 10, 12, 16, 20, 30' },
        { name: 'size', type: 'string', required: false, defaultVal: '720x1280', description: '宽高尺寸：720x1280 / 1280x720 / 1024x1024 / 1792x1024' },
        { name: 'resolution_name', type: 'string', required: false, defaultVal: '720p', description: '清晰度：480p 或 720p' },
        { name: 'input_reference[]', type: 'file', required: false, description: '最多 5 张参考图像文件引导生成' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/videos" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -F "model=grok-imagine-video" \\
  -F "prompt=科幻赛博朋克城市, 赛车在街道漂移" \\
  -F "seconds=6" \\
  -F "size=1280x720" \\
  -F "input_reference[]=@/local/car.jpg"`,
      pythonExample: `# 使用 requests 发送多图视频任务
import requests

url = "${getBaseUrl()}/videos"
headers = {"Authorization": "Bearer sk-你的令牌Key"}
files = [
    ("input_reference[]", ("car.jpg", open("car.jpg", "rb"), "image/jpeg"))
]
data = {
    "model": "grok-imagine-video",
    "prompt": "科幻赛博朋克城市, 赛车在街道漂移",
    "seconds": 6,
    "size": "1280x720"
}

resp = requests.post(url, headers=headers, data=data, files=files)
print(resp.json())
# {"id": "video_xxxx", "status": "queued", ...}`,
      responseExample: `{
  "id": "video_61be39094ee24240b27a09c673beb068",
  "object": "video",
  "created_at": 1783309400,
  "status": "queued",
  "model": "grok-imagine-video",
  "progress": 0,
  "prompt": "...",
  "seconds": "6",
  "size": "1280x720",
  "quality": "standard"
}`
    },
    {
      id: 'seedance-video',
      title: '创建 Seedance 2.0 Fast 视频任务',
      method: 'POST',
      path: '/v1/videos',
      description: '利用 Seedance 2.0 Fast (接口中调用模型标识为 sora-v4-fast) 视频生成引擎异步创建高动态视频任务，支持 5s ~ 15s。需要使用 multipart/form-data 上传参考图及配置。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '视频模型标识：sora-v4-fast' },
        { name: 'prompt', type: 'string', required: true, description: '视频画面的文字描述词' },
        { name: 'seconds', type: 'integer', required: false, defaultVal: '5', description: '视频长度（秒），可选：5 ~ 15' },
        { name: 'size', type: 'string', required: false, defaultVal: '1280x720', description: '宽高尺寸：1280x720 (横屏) / 720x1280 (竖屏) / 1024x1024 (方屏)' },
        { name: 'resolution_name', type: 'string', required: false, defaultVal: '720p', description: '清晰度：720p' },
        { name: 'input_reference[]', type: 'file', required: false, description: '最多 5 张参考图像文件引导生成' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/videos" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -F "model=sora-v4-fast" \\
  -F "prompt=科幻赛博朋克城市, 赛车在街道漂移" \\
  -F "seconds=5" \\
  -F "size=1280x720" \\
  -F "input_reference[]=@/local/car.jpg"`,
      pythonExample: `# 使用 requests 发送多图视频任务
import requests

url = "${getBaseUrl()}/videos"
headers = {"Authorization": "Bearer sk-你的令牌Key"}
files = [
    ("input_reference[]", ("car.jpg", open("car.jpg", "rb"), "image/jpeg"))
]
data = {
    "model": "sora-v4-fast",
    "prompt": "科幻赛博朋克城市, 赛车在街道漂移",
    "seconds": 5,
    "size": "1280x720"
}

resp = requests.post(url, headers=headers, data=data, files=files)
print(resp.json())
# {"id": "video_xxxx", "status": "queued", ...}`,
      responseExample: `{
  "id": "video_61be39094ee24240b27a09c673beb068",
  "object": "video",
  "created_at": 1783309400,
  "status": "queued",
  "model": "sora-v4-fast",
  "progress": 0,
  "prompt": "...",
  "seconds": "5",
  "size": "1280x720",
  "quality": "standard"
}`
    },
    {
      id: 'omni-video',
      title: '创建 Omni 视频任务',
      method: 'POST',
      path: '/v1/video/generations',
      description: '支持纯文生视频、多图生成（omni-flash）以及高级视频风格编辑与重绘（omni-flash-vref）。请求以 JSON 格式提交。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '模型 ID：omni-flash 或 omni-flash-vref' },
        { name: 'prompt', type: 'string', required: true, description: '视频效果或改写指令提示词' },
        { name: 'duration', type: 'integer', required: false, defaultVal: '6', description: '视频时长：4, 6, 8, 10 秒 (vref 强制固定为 10)' },
        { name: 'aspect_ratio', type: 'string', required: false, defaultVal: 'landscape', description: '画面比例：landscape (横屏) / portrait (竖屏)' },
        { name: 'resolution', type: 'string', required: false, defaultVal: '720p', description: '输出分辨率：720p 或 1080p' },
        { name: 'images', type: 'array', required: false, description: '参考图数据数组（支持 URL 或 base64 data URI）' },
        { name: 'video', type: 'string', required: false, description: '（仅vref必须）原视频数据（支持 URL 或 base64 data URI）' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/video/generations" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "omni-flash",
    "prompt": "动漫少女在绚丽霓虹都市奔跑, 电影级光影",
    "duration": 6,
    "aspect_ratio": "landscape",
    "resolution": "720p"
  }'`,
      pythonExample: `import requests

url = "${getBaseUrl()}/video/generations"
headers = {
    "Authorization": "Bearer sk-你的令牌Key",
    "Content-Type": "application/json"
}
payload = {
    "model": "omni-flash",
    "prompt": "动漫少女在绚丽霓虹都市奔跑, 电影级光影",
    "duration": 6,
    "aspect_ratio": "landscape",
    "resolution": "720p",
    "images": ["https://example.com/character.png"]
}

resp = requests.post(url, headers=headers, json=payload)
print(resp.json())
# {"id": "zerof:task_xxxx", "status": "pending", ...}`,
      responseExample: `{
  "id": "zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n",
  "task_id": "zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n",
  "object": "video_generation",
  "model": "omni-flash",
  "status": "pending",
  "created_at": 1783309500
}`
    },
    {
      id: 'video-poll',
      title: '轮询与下载生成视频',
      method: 'GET',
      path: '/v1/videos/{id}',
      description: '由于视频生成较耗时，提交任务后需要每 5 秒轮询查询一次该 ID 的状态，当状态为 completed 时即可获取本地代理直链进行视频播放与下载。',
      parameters: [
        { name: 'id', type: 'path_param', required: true, description: '创建任务时返回的视频任务 ID（如 video_xxxx 或 zerof:task_xxxx）' }
      ],
      curlExample: `# 1. 轮询 Sora 视频状态 (Sora 接口)：
curl "${getBaseUrl()}/videos/video_61be39094ee24240b27a09c673beb068" \\
  -H "Authorization: Bearer sk-你的令牌Key"

# 2. 轮询 Omni 视频状态 (Omni 接口)：
curl "${getBaseUrl()}/video/generations/zerof:task_8KajbDLyPR5EOKqG3gif9Nuk5x3Bcw8n" \\
  -H "Authorization: Bearer sk-你的令牌Key"

# 3. 本地直链下载视频（返回 video/mp4 格式流，无需鉴权即可公开下载）：
curl -o final.mp4 "${getBaseUrl()}/files/video?id=video_61be39094ee24240b27a09c673beb068"`,
      pythonExample: `# 以 Sora 视频流轮询为例
import time
import requests

headers = {"Authorization": "Bearer sk-你的令牌Key"}
video_id = "video_61be39094ee24240b27a09c673beb068"

while True:
    res = requests.get(f"${getBaseUrl()}/videos/{video_id}", headers=headers).json()
    status = res.get("status")
    print(f"当前生成进度: {res.get('progress', 0)}% | 状态: {status}")
    if status == "completed":
        print(f"✅ 生成完成，本地代理直链: {res.get('url')}")
        break
    elif status == "failed":
        print(f"❌ 失败: {res.get('error', {}).get('message', '未知错误')}")
        break
    time.sleep(5)`,
      responseExample: `{
  "id": "video_61be39094ee24240b27a09c673beb068",
  "object": "video",
  "status": "completed",
  "progress": 100,
  "completed_at": 1783309600,
  "url": "${getBaseUrl()}/files/video?id=video_61be39094ee24240b27a09c673beb068",
  "model": "grok-imagine-video",
  "prompt": "..."
}`
    },
    {
      id: 'billing-balance',
      title: '查询账户与 Token 余额',
      method: 'GET',
      path: '/v1/billing/balance',
      description: '查询当前 API Key 的额度。如果是无限级系统 Token，将回退计算并返回所绑定用户（或所属企业组织）的实时统一余额。',
      parameters: [],
      curlExample: `curl "${getBaseUrl()}/billing/balance" \\
  -H "Authorization: Bearer sk-你的令牌Key"`,
      pythonExample: `import requests

url = "${getBaseUrl()}/billing/balance"
headers = {"Authorization": "Bearer sk-你的令牌Key"}

resp = requests.get(url, headers=headers)
data = resp.json()
print(f"当前账户可用余额: ¥{data['balance']} 元 (已消费 ¥{data['total_charged']} 元)")`,
      responseExample: `{
  "billing": true,
  "key_name": "营销系统API对接Token",
  "balance": 4820.64,
  "total_charged": 179.36,
  "status": "active",
  "group": "default",
  "is_admin": false
}`
    }
  ];

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 p-4 md:p-8">
      {/* 头部面板 */}
      <div className="max-w-6xl mx-auto mb-8 border border-zinc-800/60 bg-zinc-950/80 backdrop-blur-md rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-rose-500/5 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-blue-500/5 rounded-full blur-[100px] pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center shadow-lg shadow-rose-500/10">
              <Code className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                开发者中心 <span className="text-[10px] bg-rose-500/15 border border-rose-500/30 text-rose-400 font-mono px-2 py-0.5 rounded-full">v1 API</span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">面向企业用户、独立开发者和自研系统的兼容 OpenAI 规范的 API 服务文档</p>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800/80 rounded-xl px-4 py-2 text-xs">
            <Globe className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-zinc-500">接口根地址 (Base URL):</span>
            <span className="font-mono text-zinc-100 select-all font-semibold">{getBaseUrl()}</span>
            <button
              onClick={() => triggerCopy(getBaseUrl(), 'baseurl')}
              className="ml-2 hover:text-white text-zinc-400 transition-colors cursor-pointer"
            >
              {copiedText === 'baseurl' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* 两栏主体布局 */}
      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row gap-6">
        
        {/* 左栏导航 */}
        <div className="w-full lg:w-60 shrink-0 flex flex-col gap-2">
          <div className="text-xs font-semibold text-zinc-500 uppercase px-3 mb-2 tracking-wider">开发文档</div>
          <button
            onClick={() => setActiveTab('getting-started')}
            className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-left text-xs font-medium transition-all ${
              activeTab === 'getting-started'
                ? 'bg-gradient-to-r from-zinc-800 to-zinc-900/50 text-white border border-zinc-800'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
            }`}
          >
            <ShieldCheck className="w-4 h-4 shrink-0 text-rose-400" />
            <span>1. 快速开始 (认证)</span>
          </button>
          
          <div className="text-xs font-semibold text-zinc-500 uppercase px-3 mt-4 mb-2 tracking-wider">代理接口</div>
          {endpoints.map((ep) => {
            const isGet = ep.method === 'GET';
            return (
              <button
                key={ep.id}
                onClick={() => setActiveTab(ep.id)}
                className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left text-xs font-medium transition-all ${
                  activeTab === ep.id
                    ? 'bg-gradient-to-r from-zinc-800 to-zinc-900/50 text-white border border-zinc-800'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {ep.id.includes('video') ? <Video className="w-4 h-4 text-indigo-400 shrink-0" /> : ep.id.includes('image') ? <ImageIcon className="w-4 h-4 text-pink-400 shrink-0" /> : <FileText className="w-4 h-4 text-blue-400 shrink-0" />}
                  <span className="truncate">{ep.title}</span>
                </div>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded leading-none shrink-0 ${isGet ? 'bg-blue-500/10 text-blue-400 border border-blue-500/15' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/15'}`}>
                  {ep.method}
                </span>
              </button>
            );
          })}
        </div>

        {/* 右栏详情 */}
        <div className="flex-1 min-w-0">
          <div className="border border-zinc-800/60 bg-zinc-950/40 rounded-2xl p-6 min-h-[450px]">
            
            {/* Tab: 开始使用 */}
            {activeTab === 'getting-started' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-rose-400" /> API 接入说明 (快速开始)
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    本系统内嵌了兼容标准的 OpenAI 规范的 API 转发层。任何支持 OpenAI 格式的第三方软件、客户端、框架（如 Dify、FastGPT、LangChain 或 OpenAI SDK）在将 Base URL 指向本系统接口，并设置相应 Token 后，均能无缝调用本系统的对话、生图和生视频能力。
                  </p>
                </div>

                <div className="border-t border-zinc-800/40 pt-4">
                  <h4 className="text-xs font-semibold text-zinc-200 mb-2">1. 接口授权凭证</h4>
                  <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                    调用所有 `/v1` 接口均需验证鉴权。企业用户/开发团队请先前往控制台「令牌管理 / API Token」页面创建 `sk-` 密钥，创建时可为具体 Token 限定允许消费的余额以及允许访问的模型。
                  </p>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
                    <p className="text-xs text-zinc-300 font-semibold">支持两种鉴权头部写法：</p>
                    <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-900 font-mono text-xs text-zinc-300">
                      Authorization: Bearer sk-xxxxxxxxxxxxxx
                    </div>
                    <div className="text-[10px] text-zinc-500">或</div>
                    <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-900 font-mono text-xs text-zinc-300">
                      X-API-Key: sk-xxxxxxxxxxxxxx
                    </div>
                  </div>
                </div>

                <div className="border-t border-zinc-800/40 pt-4">
                  <h4 className="text-xs font-semibold text-zinc-200 mb-2">2. 错误响应代码</h4>
                  <p className="text-xs text-zinc-400 mb-3">在调用过程中可能会遇到以下状态码：</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left text-zinc-300 border-collapse">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-500 font-medium">
                          <th className="py-2.5 pr-4">状态码</th>
                          <th className="py-2.5 pr-4">含义</th>
                          <th className="py-2.5">产生原因及排除方案</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-zinc-900">
                          <td className="py-2.5 font-mono text-red-400">401 Unauthorized</td>
                          <td className="py-2.5">API Key 缺失或无效</td>
                          <td className="py-2.5 text-zinc-400">请检查 HTTP Authorization 头中 Token 拼写及是否已失效。</td>
                        </tr>
                        <tr className="border-b border-zinc-900">
                          <td className="py-2.5 font-mono text-red-400">402 Payment Required</td>
                          <td className="py-2.5">账户余额不足</td>
                          <td className="py-2.5 text-zinc-400">Token 自设额度已用完，或所绑定账户/组织的统一余额已为 0，请联系管理员充值。</td>
                        </tr>
                        <tr className="border-b border-zinc-900">
                          <td className="py-2.5 font-mono text-red-400">403 Forbidden</td>
                          <td className="py-2.5">模型访问越权</td>
                          <td className="py-2.5 text-zinc-400">当前 Token 被管理员限制了模型可使用范围，该 Key 无权调用目标 Model。</td>
                        </tr>
                        <tr>
                          <td className="py-2.5 font-mono text-red-400">502 Upstream Error</td>
                          <td className="py-2.5">上游第三方渠道错误</td>
                          <td className="py-2.5 text-zinc-400">系统底层通道请求失败、无可用中转可用，或者通道超时挂起。</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* 各代理接口文档渲染 */}
            {endpoints.map((ep) => {
              if (activeTab !== ep.id) return null;
              const isGet = ep.method === 'GET';

              return (
                <div key={ep.id} className="space-y-6">
                  {/* 标题 & 接口路径 */}
                  <div>
                    <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2.5">
                      {ep.title}
                    </h3>
                    <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5">
                      <span className={`text-[10px] font-mono font-black px-2 py-1 rounded leading-none shrink-0 ${isGet ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                        {ep.method}
                      </span>
                      <span className="font-mono text-xs text-zinc-200 select-all font-semibold">{ep.path}</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-3 leading-relaxed">{ep.description}</p>
                  </div>

                  {/* 请求参数表 */}
                  {ep.parameters.length > 0 && (
                    <div className="border-t border-zinc-800/40 pt-4">
                      <h4 className="text-xs font-semibold text-zinc-200 mb-2.5 flex items-center gap-1">
                        <Terminal className="w-3.5 h-3.5 text-zinc-500" /> 请求参数 (Parameters)
                      </h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs text-left text-zinc-300 border-collapse">
                          <thead>
                            <tr className="border-b border-zinc-800 text-zinc-500 font-medium">
                              <th className="py-2.5 pr-4">参数字段</th>
                              <th className="py-2.5 pr-4">类型</th>
                              <th className="py-2.5 pr-4">是否必填</th>
                              <th className="py-2.5 pr-4">默认值</th>
                              <th className="py-2.5">说明</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ep.parameters.map((param, pi) => (
                              <tr key={pi} className="border-b border-zinc-900/60 hover:bg-zinc-900/10">
                                <td className="py-2.5 font-mono text-zinc-200 font-semibold">{param.name}</td>
                                <td className="py-2.5 font-mono text-zinc-400">{param.type}</td>
                                <td className="py-2.5">
                                  {param.required ? (
                                    <span className="text-[10px] bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-medium">必填</span>
                                  ) : (
                                    <span className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded font-medium">可选</span>
                                  )}
                                </td>
                                <td className="py-2.5 font-mono text-zinc-500">{param.defaultVal || '—'}</td>
                                <td className="py-2.5 text-zinc-400 leading-relaxed">{param.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* 代码区 (双语切换) */}
                  <div className="border-t border-zinc-800/40 pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-1.5">
                        <Code className="w-3.5 h-3.5 text-zinc-500" />
                        <span className="text-xs font-semibold text-zinc-200">调用代码示例</span>
                      </div>
                      <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
                        <button
                          onClick={() => setLangTab('curl')}
                          className={`px-3 py-1 text-[10px] font-medium rounded-md transition-colors cursor-pointer ${langTab === 'curl' ? 'bg-zinc-800 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
                        >
                          cURL
                        </button>
                        <button
                          onClick={() => setLangTab('python')}
                          className={`px-3 py-1 text-[10px] font-medium rounded-md transition-colors cursor-pointer ${langTab === 'python' ? 'bg-zinc-800 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
                        >
                          Python
                        </button>
                      </div>
                    </div>

                    <div className="relative group bg-zinc-950 border border-zinc-800 rounded-xl p-4 overflow-x-auto font-mono text-[11px] leading-relaxed text-zinc-300">
                      <button
                        onClick={() => triggerCopy(langTab === 'curl' ? ep.curlExample : ep.pythonExample, ep.id + '_code')}
                        className="absolute top-3.5 right-3.5 w-7 h-7 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white transition-all opacity-0 group-hover:opacity-100 cursor-pointer shadow-md"
                      >
                        {copiedText === ep.id + '_code' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <pre className="whitespace-pre">{langTab === 'curl' ? ep.curlExample : ep.pythonExample}</pre>
                    </div>
                  </div>

                  {/* 响应示例 */}
                  <div className="border-t border-zinc-800/40 pt-4">
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <Play className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-xs font-semibold text-zinc-200">预期响应 (Response JSON)</span>
                    </div>
                    <div className="relative group bg-zinc-950 border border-zinc-800 rounded-xl p-4 overflow-x-auto font-mono text-[11px] leading-relaxed text-zinc-300">
                      <button
                        onClick={() => triggerCopy(ep.responseExample, ep.id + '_resp')}
                        className="absolute top-3.5 right-3.5 w-7 h-7 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white transition-all opacity-0 group-hover:opacity-100 cursor-pointer shadow-md"
                      >
                        {copiedText === ep.id + '_resp' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <pre>{ep.responseExample}</pre>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
