import type { DeveloperEndpoint, DeveloperModel, DeveloperModelPricing } from '../../../shared/developerModels';

export function formatModelPrice(price: DeveloperModelPricing | null): string {
  if (!price) return '价格未配置';
  const amount = (value: number) => `¥${Number(value.toFixed(6))}`;
  if (price.billing_type === 'per_token') return `输入 ${amount(price.unit_price)} / 输出 ${amount(price.output_unit_price)} · 百万 Token`;
  const unit = { per_call: '次', per_second: '秒', per_character: '字符' }[price.billing_type];
  return `${amount(price.unit_price)} / ${unit}`;
}

// POSIX shell quoting also handles administrator names containing apostrophes.
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function modelExample(model: DeveloperModel, endpoint: DeveloperEndpoint, origin: string, language: 'curl' | 'python'): string {
  const url = `${origin}${endpoint}`;
  const limits = model.limits;
  const payload: Record<string, unknown> = { model: model.id };
  if (endpoint === '/v1/chat/completions') payload.messages = [{ role: 'user', content: '你好，请介绍一下自己。' }];
  else payload.prompt = '温暖晨光中的山谷，电影质感';
  if (endpoint === '/v1/videos') {
    if (limits) {
      payload.seconds = limits.duration.mode === 'options' ? limits.duration.values[0] : limits.duration.min;
      if (limits.resolutions[0]) payload.resolution = limits.resolutions[0];
      if (limits.ratios[0]) payload.ratio = limits.ratios[0];
      if (limits.minImages) payload.image_urls = Array.from({ length: limits.minImages }, (_, index) => `https://example.com/reference-${index + 1}.png`);
    }
    if (model.canonicalId === 'veo-omni-flash-video-edit') {
      payload.seconds = 10; payload.ratio = '16:9'; payload.video_url = 'https://example.com/input.mp4';
    }
  }
  if (endpoint.startsWith('/v1/images/')) {
    payload.n = 1;
    if (limits?.resolutions[0]) payload.output_resolution = limits.resolutions[0];
    if (limits?.ratios[0]) payload.aspect_ratio = limits.ratios[0];
    if (limits?.qualities[0]) payload.quality = limits.qualities[0];
    if (endpoint === '/v1/images/generations' && limits?.minImages) payload.image_urls = Array.from({ length: limits.minImages }, (_, index) => `https://example.com/reference-${index + 1}.png`);
  }
  if (endpoint === '/v1/images/edits') {
    if (language === 'curl') return [`curl ${shellQuote(url)} \\`, '  -H "Authorization: Bearer sk-YOUR_API_KEY" \\',
      ...Object.entries(payload).map(([key, value]) => `  --form-string ${shellQuote(`${key}=${value}`)} \\`), '  -F "image=@/path/to/reference.png"'].join('\n');
    return `import requests\n\nwith open("/path/to/reference.png", "rb") as image:\n    response = requests.post(\n        ${JSON.stringify(url)},\n        headers={"Authorization": "Bearer sk-YOUR_API_KEY"},\n        data=${JSON.stringify(payload)},\n        files={"image": image},\n        timeout=180,\n    )\nresponse.raise_for_status()\nprint(response.json())`;
  }
  const json = JSON.stringify(payload, null, 2);
  const video = endpoint === '/v1/videos';
  const poll = video ? '\n# 网络重试必须复用同一个 Idempotency-Key；主动生成新视频时换新键。\n# 保存响应中的 task_id，再调用 GET /v1/videos/{task_id} 查询结果。任务 ID 是不透明字符串，请原样保存。' : '';
  const header = video ? '  -H "Idempotency-Key: REPLACE-WITH-A-UNIQUE-TASK-KEY" \\\n' : '';
  if (language === 'curl') return `curl ${shellQuote(url)} \\\n  -H "Authorization: Bearer sk-YOUR_API_KEY" \\\n${header}  -H "Content-Type: application/json" \\\n  -d ${shellQuote(json)}${poll}`;
  return `import requests${video ? '\nimport uuid\n\n# 只为新任务创建一次；网络重试复用已保存的 request_key。\nrequest_key = str(uuid.uuid4())' : ''}\n\nresponse = requests.post(\n    ${JSON.stringify(url)},\n    headers={"Authorization": "Bearer sk-YOUR_API_KEY"${video ? ', "Idempotency-Key": request_key' : ''}},\n    json=${json},\n    timeout=180,\n)\nresponse.raise_for_status()\nprint(response.json())${poll}`;
}
