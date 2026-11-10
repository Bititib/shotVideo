import type Database from 'better-sqlite3';
import type { ZhiyingModelProfile } from '../../shared/zhiyingModelConfiguration.js';

const KEY = 'zhiying_manual_models_v1';
export type ZhiyingBinding = { channelId: number; modelId: string; upstreamModel: string; profile: ZhiyingModelProfile };
export function zhiyingBindings(sqlite: Database.Database): ZhiyingBinding[] {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : [];
}
export function saveZhiyingBinding(sqlite: Database.Database, binding: ZhiyingBinding) {
  const rows = zhiyingBindings(sqlite).filter(row => row.channelId !== binding.channelId || row.modelId !== binding.modelId);
  sqlite.prepare('INSERT INTO settings (key,value,label) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY, JSON.stringify([...rows, binding]), '智赢后台模型配置');
}
