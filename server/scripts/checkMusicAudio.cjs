// Local, read-only inspection: no application imports, workers, HTTP or database writes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

function inspectMusic(contentId, dataDir = path.resolve('data')) {
  if (!Number.isSafeInteger(contentId) || contentId <= 0) throw new Error('内容编号无效');
  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true, fileMustExist: true, timeout: 3000 });
  let job, results;
  try {
    db.pragma('query_only = ON');
    db.transaction(() => {
      job = db.prepare('SELECT id, state FROM music_jobs WHERE content_id=?').get(contentId);
      if (!job) throw new Error('未找到原音乐订单 #' + contentId);
      results = db.prepare('SELECT id, upstream_id, status, saved FROM music_results WHERE job_id=? ORDER BY rowid').all(job.id);
    })();
  } finally { db.close(); }
  const root = fs.realpathSync(path.join(dataDir, 'private-music', 'results'));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const command = (name, args, timeout) => {
    const result = spawnSync(name, args, { encoding: 'utf8', timeout, maxBuffer: 1024*1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(name + ': ' + (result.error?.message || result.stderr || 'exit=' + result.status).trim().slice(0,600));
    return result.stdout;
  };
  const reports = results.map((result, index) => {
    const report = { song: index+1, result_id: result.id, upstream_id: result.upstream_id, status: result.status,
      saved: !!result.saved, bytes: null, duration_seconds: null, decoded_seconds: null, decode: '未检查', ok: false };
    try {
      if (!uuid.test(job.id) || !uuid.test(result.id)) throw new Error('本地编号格式异常，未读取文件');
      const file = fs.realpathSync(path.join(root, job.id+'-'+result.id+'.mp3'));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件不在音乐目录');
      const stat = fs.statSync(file); report.bytes = stat.size;
      if (!stat.isFile() || !stat.size) throw new Error('文件为空或不是普通文件');
      const info = JSON.parse(command('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-select_streams','a',
        '-show_entries','stream=codec_name,sample_rate,channels:format=duration','-of','json',file], 30000));
      report.duration_seconds = Number(info.format?.duration) || null;
      report.codec = info.streams?.[0]?.codec_name || null;
      if (report.codec !== 'mp3' || !Number.isFinite(report.duration_seconds) || !(report.duration_seconds > 0)) throw new Error('缺少有效 MP3 音轨或时长');
      const output = command('ffmpeg', ['-nostdin','-v','error','-xerror','-err_detect','explode','-protocol_whitelist','file,pipe',
        '-i',file,'-map','0:a:0','-progress','pipe:1','-f','null','-'], 120000);
      const times = [...output.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]));
      report.decoded_seconds = Math.max(0,...times)/1e6;
      if (!(report.decoded_seconds > 0)) throw new Error('解码后没有音频样本');
      report.decode = '正常'; report.ok = true;
    } catch (error) { report.decode = '异常'; report.error = String(error.message).slice(0,800); }
    return report;
  });
  return { content_id: contentId, job_id: job.id, order_state: job.state, expected_songs: 2, actual_songs: results.length,
    ok: results.length === 2 && reports.every(report => report.ok), reports };
}

module.exports = { inspectMusic };
if (require.main === module) {
  try {
    const result = inspectMusic(Number(process.argv[2] || 16045));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error('检查未完成：' + error.message); process.exitCode = 1; }
}
