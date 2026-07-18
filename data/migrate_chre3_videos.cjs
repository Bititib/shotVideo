/**
 * 一次性迁移脚本：将数据库中所有 4月天渠道 (llm.chre3.com) 的视频
 * 下载到本地并转码为 H.264，更新 result_url 为本地路径。
 *
 * 用法：node data/migrate_chre3_videos.cjs
 * 幂等安全：已迁移的记录会自动跳过。
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { promisify } = require('util');
const { exec } = require('child_process');
const execPromise = promisify(exec);

const db = new Database('data/app.db');
const uploadDir = path.resolve('data/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

async function migrateOne(row) {
  const { id, result_url, model_id } = row;

  // 跳过已经是本地路径的记录
  if (!result_url || result_url.startsWith('/') || result_url.includes('/uploads/')) {
    console.log(`  [跳过] ID=${id}: 已是本地路径`);
    return;
  }

  // 从 URL 中提取 task ID 作为文件名
  const taskMatch = result_url.match(/videos\/(task_[a-zA-Z0-9]+)/);
  const taskId = taskMatch ? taskMatch[1] : `chre3_${id}`;
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const finalFilename = `video_${safeId}.mp4`;
  const finalPath = path.join(uploadDir, finalFilename);

  // 如果文件已存在，只更新数据库
  if (fs.existsSync(finalPath)) {
    console.log(`  [已存在] ID=${id}: ${finalFilename}，仅更新数据库`);
    db.prepare('UPDATE contents SET result_url = ? WHERE id = ?').run(`/uploads/${finalFilename}`, id);
    return;
  }

  // 优先尝试从本地播放缓存 (video_cache) 恢复（应对上游链接过期 502 的情况）
  const hash = crypto.createHash('md5').update(result_url).digest('hex');
  const cachePath = path.join(process.cwd(), 'data/video_cache', `${hash}.mp4`);

  if (fs.existsSync(cachePath)) {
    console.log(`  [缓存命中] ID=${id}: 发现本地播放缓存 ${hash}.mp4，直接复制使用`);
    try {
      fs.copyFileSync(cachePath, finalPath);
      const localUrl = `/uploads/${finalFilename}`;
      db.prepare('UPDATE contents SET result_url = ? WHERE id = ?').run(localUrl, id);
      console.log(`  [完成] ID=${id}: → ${localUrl}`);
      return;
    } catch (copyErr) {
      console.error(`  [错误] 复制缓存文件失败: ${copyErr.message}`);
    }
  }

  const uuid = crypto.randomUUID();
  const tempDownload = path.join(uploadDir, `tmp_migrate_dl_${uuid}.mp4`);
  const tempTranscoded = path.join(uploadDir, `tmp_migrate_tc_${uuid}.mp4`);

  try {
    console.log(`  [下载] ID=${id}: ${result_url}`);

    // 获取渠道 API Key
    const channel = db.prepare("SELECT api_key FROM channels WHERE base_url LIKE '%llm.chre3.com%' AND status = 1 LIMIT 1").get();
    const headers = {};
    if (channel && channel.api_key) {
      headers['Authorization'] = `Bearer ${channel.api_key}`;
    }

    const resp = await fetch(result_url, { headers, signal: AbortSignal.timeout(300000) });
    if (!resp.ok) {
      console.error(`  [失败] ID=${id}: HTTP ${resp.status} ${resp.statusText}`);
      return;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tempDownload, buffer);
    console.log(`  [下载完成] ID=${id}: ${buffer.length} bytes`);

    // 检测编码
    let isHevc = false;
    try {
      const probeOut = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 "${tempDownload}"`,
        { encoding: 'utf8' }
      );
      isHevc = probeOut.includes('hevc');
      console.log(`  [编码] ID=${id}: ${probeOut.trim()} (HEVC=${isHevc})`);
    } catch {
      console.warn(`  [警告] ID=${id}: ffprobe 失败，默认视为 HEVC`);
      isHevc = true;
    }

    if (isHevc) {
      console.log(`  [转码] ID=${id}: H.265 → H.264...`);
      await execPromise(
        `ffmpeg -y -i "${tempDownload}" -c:v libx264 -pix_fmt yuv420p -preset superfast -movflags faststart -c:a copy "${tempTranscoded}"`
      );
      fs.renameSync(tempTranscoded, finalPath);
    } else {
      fs.renameSync(tempDownload, finalPath);
    }

    // 更新数据库
    const localUrl = `/uploads/${finalFilename}`;
    db.prepare('UPDATE contents SET result_url = ? WHERE id = ?').run(localUrl, id);
    console.log(`  [完成] ID=${id}: → ${localUrl}`);
  } catch (err) {
    console.error(`  [错误] ID=${id}: ${err.message}`);
  } finally {
    try { if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload); } catch {}
    try { if (fs.existsSync(tempTranscoded)) fs.unlinkSync(tempTranscoded); } catch {}
  }
}

async function main() {
  const rows = db.prepare(
    "SELECT id, result_url, model_id FROM contents WHERE type = 'video' AND status = 'completed' AND result_url LIKE '%llm.chre3.com%'"
  ).all();

  console.log(`\n🔍 找到 ${rows.length} 条 4月天渠道视频记录需要迁移\n`);

  if (rows.length === 0) {
    console.log('✅ 无需迁移，所有记录均已本地化。');
    return;
  }

  for (const row of rows) {
    await migrateOne(row);
  }

  console.log('\n✅ 迁移完成！\n');
}

main().catch(err => {
  console.error('迁移脚本执行失败:', err);
  process.exit(1);
});
