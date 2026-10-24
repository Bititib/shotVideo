/** Display-only projection. Never use this text to decide task or billing state. */
const FALLBACK = '生成服务返回异常，暂未提供可展示的失败原因。';
const PROVIDERS = /纵横科技|私有供应商[\w\u4e00-\u9fff]*|\b(?:snumom|hmstudio|haya|longxia)\b/gi;

function redact(text: string, privateNames: readonly string[]): string {
  let result = text
    // Drop stack frames and request echoes before flattening whitespace.
    .replace(/^\s*at\s+.*$/gm, '')
    .replace(/\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi, '[Cookie已隐藏]')
    .replace(/\b(?:request[_ ]?body|payload|prompt|input|reference_images|reference_videos|audio_urls)\s*[:=]\s*[^\r\n]*/gi, '[请求内容已隐藏]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[鉴权已隐藏]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/gi, '[密钥已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[令牌已隐藏]')
    .replace(/(["']?(?:authorization|proxy-authorization|api[_-]?key|key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|signature|x-amz-signature|密钥|密码|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '$1[敏感信息已隐藏]')
    .replace(/\b(?:provider|channel(?:Name|_name)?|base_url)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '[渠道配置已隐藏]')
    .replace(/(?:https?|wss?|ftp|file):\/\/[^\s<>"'，；]+/gi, '[链接已隐藏]')
    .replace(/data:[^\s"'<>]+/gi, '[素材已隐藏]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[地址已隐藏]')
    .replace(/\b[A-Z]:[\\/][^\s"'<>]+/gi, '[路径已隐藏]')
    .replace(/\/(?:app|home|root|opt|usr|var|tmp|srv|Users|uploads)\/[^\s"'<>]+/g, '[路径已隐藏]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐藏]')
    .replace(PROVIDERS, '[服务]');
  for (const name of privateNames) {
    if (name.length >= 3) result = result.split(name).join('[服务]');
  }
  // Strip arbitrary adapter names from transport wrappers, not from the cause.
  result = result.replace(/^.*?提交失败\s*\(\d{3}\)\s*[:：]\s*/s, '')
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim();
  return result.length > 2000 ? result.slice(0, 2000) + '…' : result;
}

/** Only project diagnostic fields; never serialize a whole provider response. */
function extract(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > 65536) return '';
    const html = text.search(/<!doctype|<html\b|<script\b/i);
    if (html >= 0) return text.slice(0, html).trim();
    if (/^\{|^\[\s*(?:[\[{"\d]|null|true|false|\])/.test(text)) {
      try { return extract(JSON.parse(text), depth + 1); } catch { return ''; }
    }
    const brace = text.indexOf('{');
    if (brace >= 0) {
      try { return extract(JSON.parse(text.slice(brace)), depth + 1) || text.slice(0, brace).trim(); }
      catch { return text.slice(0, brace).trim(); }
    }
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, 5).map(v => extract(v, depth + 1)).filter(Boolean).join('; ');
  if (typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['code', 'error_code']) {
    if (typeof obj[key] === 'number' || typeof obj[key] === 'string' && /^[\w.-]{1,100}$/.test(obj[key] as string)) parts.push(String(obj[key]));
  }
  for (const key of ['error', 'message', 'error_message', 'error_msg', 'error_detail', 'detail', 'reason', 'failure_reason', 'fail_reason', 'errors']) {
    const detail = extract(obj[key], depth + 1);
    if (detail && !parts.includes(detail)) parts.push(detail);
  }
  // Some gateways put the diagnostic envelope under data, not at the root.
  if (!parts.length && obj.data && typeof obj.data === 'object') return extract(obj.data, depth + 1);
  return parts.join(': ');
}

export function sanitizedGenerationReason(value: unknown, privateNames: readonly string[] = []): string {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const names = [...privateNames, ...['provider', 'channel', 'channelName', 'channel_name'].map(k => obj[k]).filter((v): v is string => typeof v === 'string')];
  const result = redact(extract(value), names);
  return !result || /^(?:unknown|unknown error|error|undefined|null)$/i.test(result) ? FALLBACK : result;
}
