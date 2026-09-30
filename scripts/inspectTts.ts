/** Read-only upstream probe. Run with: npx tsx scripts/inspectTts.ts */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../server/config/env.js';
import { parseTtsVoices } from '../server/services/ttsCatalogService.js';

async function main() {
  let key = env.GEMINI_API_KEY;
  const databasePath = path.resolve('data/app.db');
  if (fs.existsSync(databasePath)) {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const channel = db.prepare("SELECT api_key FROM channels WHERE type = 'gemini' AND status = 1 ORDER BY priority DESC, id ASC LIMIT 1").get() as { api_key?: string } | undefined;
      if (channel?.api_key) key = channel.api_key;
    } finally { db.close(); }
  }
  const response = await fetch(`${env.GEMINI_API_BASE_URL.replace(/\/+$/, '')}/v1/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ status: response.status, error: response.status === 401 ? '上游要求认证，请在部署环境中运行或配置 GEMINI_API_KEY。' : '上游目录请求失败。' }, null, 2));
    process.exitCode = 1;
    return;
  }
  const payload = await response.json() as any;
  const rows = payload.data || payload.models;
  if (!Array.isArray(rows)) throw new Error('Invalid catalog');
  const voiceResponse = await fetch(`${env.GEMINI_API_BASE_URL.replace(/\/+$/, '')}/v1/voices`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
  const voices = voiceResponse.ok ? parseTtsVoices(await voiceResponse.json()) : [];
  const tts = rows.map(row => ({ modelId: String(row.id || row.name || '').replace(/^models\//, '') }))
    .filter(row => /tts/i.test(row.modelId))
    .map(row => ({ ...row, voices, voiceMetadataAvailable: voices.length > 0 }));
  console.log(JSON.stringify({ status: response.status, totalModels: rows.length, tts }, null, 2));
}

main().catch(() => {
  console.error('读取 TTS 目录失败，请检查部署配置、网络和上游响应。');
  process.exitCode = 1;
});
