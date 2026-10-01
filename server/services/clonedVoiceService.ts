import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TtsVoice } from '../../shared/tts.js';

export type ClonedVoice = { voiceId: string; displayName: string; sourceFile: string; createdAt: string; state: string; userId: number; upstream: string };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
export class ClonedVoiceService {
  constructor(private userId: number, private baseUrl: string, private apiKey: string,
    private storePath = path.resolve('data/cloned_voices.json')) {}
  private read(): ClonedVoice[] {
    if (!fs.existsSync(this.storePath)) return [];
    const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    if (!Array.isArray(data.voices)) throw new Error('克隆音色存储格式错误，请联系管理员');
    return data.voices;
  }
  private save(voices: ClonedVoice[]) {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ voices }, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.storePath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  listClonedVoices() {
    return this.read().filter(v => v.userId === this.userId && v.upstream === this.baseUrl.replace(/\/$/, ''));
  }
  requireVoice(voiceId: string) {
    const voice = this.listClonedVoices().find(v => v.voiceId === voiceId);
    if (!voice) throw fail(404, '克隆音色不存在或不属于当前账号');
    return voice;
  }
  private async request(endpoint: string, method: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${endpoint}`, {
        method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
      });
    } catch { throw fail(502, '克隆音色上游连接失败或超时，请稍后重试'); }
    if (method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) {
      throw fail(502, response.status === 404 ? '当前上游未提供声音克隆接口，请管理员确认代理版本和接口地址。'
        : response.status === 401 || response.status === 403 ? '声音克隆接口鉴权失败，请管理员检查上游密钥和权限。'
        : response.status === 429 ? '声音克隆请求过于频繁或额度不足，请稍后重试。'
        : `声音克隆请求失败（${response.status}），请检查音频格式和录音质量。`);
    }
    return method === 'DELETE' ? null : response.json();
  }
  async cloneVoice(audioFilePath: string, displayName: string, sourceFile = path.basename(audioFilePath)) {
    displayName = displayName.trim();
    if (!displayName || displayName.length > 60) throw fail(400, '音色名称应为 1～60 个字符');
    const size = fs.statSync(audioFilePath).size;
    if (!size || size > 10 * 1024 * 1024) throw fail(400, '参考音频不能为空或超过 10MB，请压缩或裁剪');
    const bytes = fs.readFileSync(audioFilePath);
    const mimeType = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' ? 'audio/wav'
      : bytes.toString('ascii', 0, 4) === 'OggS' ? 'audio/ogg'
      : bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ? 'audio/mpeg' : '';
    if (!mimeType) throw fail(400, '请上传有效的 WAV、MP3 或 OGG 音频');
    const result = await this.request('/v1beta/voices', 'POST', { voice: { displayName, replicationConfig: { referenceAudio: { inlineData: { mimeType, data: bytes.toString('base64') } } } } });
    if (!/^voices\/[a-zA-Z0-9_-]+$/.test(result?.name || '')) throw fail(502, '上游未返回有效的克隆音色 ID');
    const voice: ClonedVoice = { voiceId: result.name, displayName, sourceFile: path.basename(sourceFile), createdAt: new Date().toISOString(), state: result.state || 'UNKNOWN', userId: this.userId, upstream: this.baseUrl.replace(/\/$/, '') };
    const voices = this.read();
    if (voices.some(v => v.voiceId === voice.voiceId && v.upstream === voice.upstream)) throw fail(502, '上游返回了重复的音色 ID，请联系管理员核对');
    this.save([...voices, voice]);
    return voice;
  }
  async deleteClonedVoice(voiceId: string) {
    this.requireVoice(voiceId);
    await this.request(`/v1beta/${voiceId}`, 'DELETE');
    this.save(this.read().filter(v => !(v.voiceId === voiceId && v.userId === this.userId && v.upstream === this.baseUrl.replace(/\/$/, ''))));
    return true;
  }
  getAllVoices(prebuilt: TtsVoice[]) {
    return [...this.listClonedVoices().map(v => ({ voiceId: v.voiceId, displayName: v.displayName, type: 'cloned' as const, state: v.state, createdAt: v.createdAt })),
      ...prebuilt.filter(v => !v.id.startsWith('voices/')).map(v => ({ voiceId: v.id, displayName: v.displayName || v.name, type: 'prebuilt' as const, state: 'ACTIVE' }))];
  }
}
