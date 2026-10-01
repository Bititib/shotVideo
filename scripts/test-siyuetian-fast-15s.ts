import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { buildSiYueTianSeedance25VideoPayload } from '../server/services/siYueTianVideoModels.js';

// Pass an existing task ID to resume polling without submitting another paid task.
const db = new Database('data/app.db', { readonly: true });
const channel = db.prepare('SELECT base_url, api_key FROM channels WHERE base_url = ? AND status = 1').get('https://llm.chre3.com') as { base_url: string; api_key: string } | undefined;
db.close();
if (!channel?.api_key) throw new Error('No configured Siyuetian channel');
const base = channel.base_url.replace(/\/+$/, '');
const headers = { Authorization: `Bearer ${channel.api_key}`, 'Content-Type': 'application/json' };
const outputDir = path.resolve('output/siyuetian-fast-15s');
fs.mkdirSync(outputDir, { recursive: true });
let taskId = process.argv[2];
if (!taskId) {
  const payload = buildSiYueTianSeedance25VideoPayload({
    model: 'seedance-2.0-fast-c2', prompt: '一只橘猫在阳光明媚的花园草地上慢慢散步，镜头平稳跟随，自然写实，无字幕。',
    seconds: 15, aspectRatio: '16:9', imageUrls: [], videoUrls: [], audioUrls: [],
  });
  console.log('Request:', JSON.stringify(payload));
  const response = await fetch(`${base}/v1/videos`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
  const body = await response.text();
  console.log('Submit:', response.status, body);
  fs.writeFileSync(path.join(outputDir, 'submit.json'), body);
  if (!response.ok) process.exit(1);
  const job = JSON.parse(body);
  taskId = job.task_id || job.id || job.request_id;
  if (!taskId) throw new Error('No task ID; do not resubmit before checking saved response');
}
console.log('Task:', taskId);
for (let attempt = 0; attempt < 120; attempt++) {
  const response = await fetch(`${base}/v1/videos/${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  fs.writeFileSync(path.join(outputDir, 'latest.json'), body);
  if (!response.ok) { console.log('Poll:', response.status, body.slice(0, 1000)); process.exit(1); }
  const job = JSON.parse(body);
  const status = job.status || job.data?.status;
  console.log(new Date().toISOString(), status, job.progress ?? '');
  if (['failed', 'error', 'cancelled'].includes(status)) { console.log(body); process.exit(1); }
  if (['completed', 'succeeded', 'success'].includes(status)) {
    console.log('Completed:', body);
    // Test the authenticated content endpoint used by this provider, without forwarding credentials to other origins.
    const content = await fetch(`${base}/v1/videos/${encodeURIComponent(taskId)}/content`, { headers, signal: AbortSignal.timeout(120000) });
    console.log('Content:', content.status, content.headers.get('content-type'));
    if (!content.ok || !content.headers.get('content-type')?.startsWith('video/')) {
      console.log((await content.text()).slice(0, 1000)); process.exit(2);
    }
    const videoPath = path.join(outputDir, `${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`);
    fs.writeFileSync(videoPath, Buffer.from(await content.arrayBuffer()));
    console.log('Saved:', videoPath);
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw new Error(`Polling timed out; resume with task ID ${taskId}`);
