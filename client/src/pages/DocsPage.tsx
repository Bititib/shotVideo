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
      description: '获取当前 API Key 有权访问且已配置可用渠道的模型列表。调用其他接口时，请始终使用本接口实时返回的模型 ID。返回结构兼容 OpenAI 模型列表格式。',
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
}`
    },
    {
      id: 'pricing',
      title: '获取可用模型价格',
      method: 'GET',
      path: '/v1/pricing',
      description: '获取当前 API Key 可调用且已配置计费规则的模型价格。列表与 /v1/models 使用相同的渠道状态和 Token 模型白名单过滤规则；也可以调用 /v1/pricing/{model_id} 查询单个模型。',
      parameters: [],
      curlExample: `curl -X GET "${getBaseUrl()}/pricing" \\
  -H "Authorization: Bearer sk-你的令牌Key"`,
      pythonExample: `import requests

response = requests.get(
    "${getBaseUrl()}/pricing",
    headers={"Authorization": "Bearer sk-你的令牌Key"}
)
response.raise_for_status()
for item in response.json()["data"]:
    print(item["model"], item["unit_price"], item["unit"])`,
      responseExample: `{
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
}`
    },
    {
      id: 'chat',
      title: '智能对话补全 (Chat Completions)',
      method: 'POST',
      path: '/v1/chat/completions',
      description: '提供 OpenAI Chat Completions 兼容转发。仅当 /v1/models 返回可用于对话的模型时才可调用；当前没有对话模型时，请勿使用本接口。流式与非流式响应由上游模型能力决定。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '从 GET /v1/models 实时获取的对话模型 ID' },
        { name: 'messages', type: 'array', required: true, description: '对话上下文消息数组，格式如 [{"role": "user", "content": "你好"}]' },
        { name: 'stream', type: 'boolean', required: false, defaultVal: 'false', description: '是否使用流式传输。如果为 true，将采用 text/event-stream 协议持续推送生成片段' },
        { name: 'reasoning_effort', type: 'string', required: false, description: '透传给上游的推理强度；可选值与目标模型能力保持一致' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/chat/completions" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "YOUR_CHAT_MODEL_ID",
    "messages": [{"role": "user", "content": "用一句话解释相对论"}],
    "stream": false
  }'`,
      pythonExample: `from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌Key",
    base_url="${getBaseUrl()}"
)

response = client.chat.completions.create(
    model="YOUR_CHAT_MODEL_ID",
    messages=[{"role": "user", "content": "用一句话解释相对论"}],
    stream=False
)
print(response.choices[0].message.content)`,
      responseExample: `{
  "id": "chatcmpl-xxxxx",
  "object": "chat.completion",
  "created": 1783309100,
  "model": "YOUR_CHAT_MODEL_ID",
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
        { name: 'model', type: 'string', required: true, description: '图像生成模型 ID；当前可用示例：gpt-image-2' },
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
    "model": "gpt-image-2",
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
    model="gpt-image-2",
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
        { name: 'model', type: 'string', required: true, description: '支持图片编辑的模型 ID；请以 GET /v1/models 返回结果和模型能力为准' },
        { name: 'prompt', type: 'string', required: true, description: '图像改写/编辑修改描述词' },
        { name: 'image', type: 'file', required: true, description: '参考图文件（多文件时使用 image[]，最大可传 5 张）' },
        { name: 'size', type: 'string', required: false, defaultVal: '1024x1024', description: '目前固定输出 1024x1024 分辨率' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/images/edits" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -F "model=gpt-image-2" \\
  -F "prompt=将图片中的背景替换为繁华霓虹都市" \\
  -F "image=@/local/path/to/origin.png"`,
      pythonExample: `# 使用 requests 发送 multipart/form-data
import requests

url = "${getBaseUrl()}/images/edits"
headers = {"Authorization": "Bearer sk-你的令牌Key"}
files = {"image": ("origin.png", open("origin.png", "rb"), "image/png")}
data = {
    "model": "gpt-image-2",
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
      id: 'unified-video',
      title: '统一视频任务创建 (Unified Video Entry)',
      method: 'POST',
      path: '/v1/videos',
      description: '统一视频生成入口，自动完成参数归一、排队和可用容量调度。系统可能在容量繁忙时自动选择兼容的执行模型；请求模型、计费和任务 ID 保持不变。',
      parameters: [
        { name: 'model', type: 'string', required: true, description: '从 GET /v1/models 获取的视频模型 ID；当前示例：seedance_v2.5、wan3.0th、veo-3-1' },
        { name: 'prompt', type: 'string', required: true, description: '视频画面的文字描述词' },
        { name: 'seconds', type: 'integer', required: false, defaultVal: '6', description: '视频时长（秒），支持别名 duration' },
        { name: 'ratio', type: 'string', required: false, defaultVal: '16:9', description: '画面比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4，支持别名 aspect_ratio' },
        { name: 'resolution', type: 'string', required: false, defaultVal: '720p', description: '分辨率：480p / 720p / 1080p，支持别名 resolution_name' },
        { name: 'image_urls', type: 'array', required: false, description: '公网参考图 URL 数组，支持别名 images 或 image_refs' },
        { name: 'video_urls', type: 'array', required: false, description: '公网参考视频 URL 数组，支持别名 videos；单视频编辑也支持 video_url' },
        { name: 'audio_urls', type: 'array', required: false, description: '公网参考音频 URL 数组，支持别名 audios' }
      ],
      curlExample: `curl -X POST "${getBaseUrl()}/videos" \\
  -H "Authorization: Bearer sk-你的令牌Key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "seedance_v2.5",
    "prompt": "电影感的雨夜街巷打斗，动作清楚连贯，镜头稳定",
    "seconds": 10,
    "ratio": "9:16",
    "resolution": "720p",
    "image_urls": ["https://cdn.example.com/character.jpg"]
  }'`,
      pythonExample: `import requests

url = "${getBaseUrl()}/videos"
headers = {
    "Authorization": "Bearer sk-你的令牌Key",
    "Content-Type": "application/json"
}
payload = {
    "model": "seedance_v2.5",
    "prompt": "电影感的雨夜街巷打斗，动作清楚连贯，镜头稳定",
    "seconds": 10,
    "ratio": "9:16",
    "resolution": "720p",
    "image_urls": ["https://cdn.example.com/character.jpg"]
}

resp = requests.post(url, headers=headers, json=payload)
print(resp.json())
# {"id": "task_123", "task_id": "task_123", "status": "queued", ...}`,
      responseExample: `{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "seedance_v2.5",
  "status": "queued",
  "progress": 0,
  "status_url": "${getBaseUrl()}/videos/task_123",
  "retry_after": 5
}`
    },
    {
      id: 'video-poll',
      title: '统一视频任务轮询与查询',
      method: 'GET',
      path: '/v1/videos/{task_id}',
      description: '使用 status_url（或 task_id）持续轮询。queued / processing 期间只返回状态查询地址，不会提前返回视频结果地址；completed 后才返回 url / result_url。failed 时会返回失败原因与 billing_status、refunded、refund_amount 等退款凭证。',
      parameters: [
        { name: 'task_id', type: 'path_param', required: true, description: '创建任务时返回的任务 ID（如 task_123）' }
      ],
      curlExample: `# 1. 轮询视频生成状态：
curl "${getBaseUrl()}/videos/task_123" \\
  -H "Authorization: Bearer sk-你的令牌Key"

# 2. 使用状态响应中的完整签名 URL 直接下载，无需暴露 API Key：
curl -o final.mp4 "状态响应返回的完整 url"`,
      pythonExample: `import time
import requests

headers = {"Authorization": "Bearer sk-你的令牌Key"}
task_id = "task_123"

# 轮询状态
while True:
    res = requests.get(f"${getBaseUrl()}/videos/{task_id}", headers=headers).json()
    status = res.get("status")
    if status == "queued":
        print(f"排队位置: {res.get('queue_position')} | 运行: {res.get('queue_running')}/{res.get('queue_limit')}")
    else:
        print(f"进度: {res.get('progress', 0)}% | 状态: {status}")
    if status == "completed":
        print(f"✅ 生成成功! 下载地址: {res.get('url')}")
        break
    elif status == "failed":
        print(f"❌ 失败: {res.get('error_message') or res.get('error') or '未返回失败原因'}")
        print(f"退款状态: {res.get('billing_status', 'unknown')} | 金额: {res.get('refund_amount', 0)}")
        break
    time.sleep(5)`,
      responseExample: `{
  "id": "task_123",
  "task_id": "task_123",
  "object": "video",
  "model": "seedance_v2.5",
  "status": "completed",
  "progress": 100,
  "url": "${getBaseUrl()}/videos/task_123/content?expires=1788000000&signature=...",
  "result_url": "${getBaseUrl()}/videos/task_123/content?expires=1788000000&signature=..."
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
    },
    {
      id: 'billing-usage',
      title: '查询 API 调用明细',
      method: 'GET',
      path: '/v1/billing/usage',
      description: '按当前 API Key 隔离查询调用记录、Token 用量和费用汇总。时间筛选参数使用毫秒时间戳。',
      parameters: [
        { name: 'page', type: 'integer', required: false, defaultVal: '1', description: '页码，从 1 开始' },
        { name: 'page_size', type: 'integer', required: false, defaultVal: '50', description: '每页数量，范围 1~100' },
        { name: 'start_time', type: 'integer', required: false, description: '开始时间，Unix 毫秒时间戳' },
        { name: 'end_time', type: 'integer', required: false, description: '结束时间，Unix 毫秒时间戳' }
      ],
      curlExample: `curl "${getBaseUrl()}/billing/usage?page=1&page_size=20" \\
  -H "Authorization: Bearer sk-你的令牌Key"`,
      pythonExample: `import requests

url = "${getBaseUrl()}/billing/usage"
headers = {"Authorization": "Bearer sk-你的令牌Key"}
resp = requests.get(url, headers=headers, params={"page": 1, "page_size": 20})
print(resp.json())`,
      responseExample: `{
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
  "page_size": 20
}`
    }
  ];

  return (
    <div className="docs-page min-h-screen bg-[#09090b] text-zinc-100 p-4 md:p-8">
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
              className="ml-2 w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/10 hover:text-white text-zinc-400 transition-colors cursor-pointer"
              aria-label="复制接口地址"
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
                    本系统提供 OpenAI 风格的模型、对话和图片接口，并扩展了异步视频接口。第三方客户端能否直接使用取决于其支持的接口类型；调用前请先请求 `/v1/models`，并只使用实时返回的模型 ID。
                  </p>
                </div>

                <div className="border-t border-zinc-800/40 pt-4">
                  <h4 className="text-xs font-semibold text-zinc-200 mb-2">1. 接口授权凭证</h4>
                  <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                    调用所有 `/v1` 接口均需验证鉴权。企业用户/开发团队请先前往控制台「令牌管理 / API Token」页面创建 `sk-` 密钥，创建时可为具体 Token 限定允许消费的余额以及允许访问的模型。视频内容下载同样需要携带鉴权头。
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
