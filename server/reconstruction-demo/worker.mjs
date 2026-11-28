import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { styles, mockAnalysis } from './fixtures.mjs';
import { animateFrame, assemble, ffmpeg, fixtureFrame } from './media.mjs';
import { analyzeGemini, redact } from './gemini-analysis.mjs';

export const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const taskFile = (store, task) => path.join(store.root, task.project, task.id + (['video', 'film'].includes(task.kind) ? '.mp4' : '.png'));

// Local simulation only: each candidate shifts its crop and tone so variants are visibly different.
const VARIANT_SHIFTS = [[0, 0], [-0.12, 0.03], [0.12, -0.02], [-0.06, 0.05], [0.07, 0.04], [-0.1, -0.03]];
async function variantCrop(file, crop, variant = 0) {
  const { width, height } = await sharp(file).metadata();
  const [fx, fy] = VARIANT_SHIFTS[(variant || 0) % VARIANT_SHIFTS.length];
  const w = Math.min(crop.width, width);
  const h = Math.min(crop.height, height);
  const left = Math.max(0, Math.min(width - w, Math.round(crop.left + fx * crop.width)));
  const top = Math.max(0, Math.min(height - h, Math.round(crop.top + fy * crop.height)));
  return { left, top, width: w, height: h };
}
const variantTone = (variant = 0) => [
  { brightness: 1, saturation: 1 }, { brightness: 1.04, saturation: 0.92 }, { brightness: 0.96, saturation: 1.08 },
  { brightness: 1.02, saturation: 1.04, hue: 6 }, { brightness: 0.98, saturation: 0.95, hue: -6 }, { brightness: 1.05, saturation: 1 },
][(variant || 0) % 6];

export function createWorker(store, { settings, analysisTransport, externalExecutor } = {}) {
  const inFlight = new Set();
  const MAX_CONCURRENCY = 3;
  let timer;
  async function execute(task) {
    const input = JSON.parse(task.input);
    const directory = path.join(store.root, task.project);
    const output = taskFile(store, task);
    const temp = output.replace(/\.(png|mp4)$/, '.part.$1');
    const state = store.project(task.project);
    try {
      if (externalExecutor && await externalExecutor({ task, input, state, directory, output, temp, store })) {
        // Handled by real website channel executor
      } else if (task.kind === 'analysis') {
        const source = path.join(directory, 'source.mp4');
        let plan;
        if (input.mode === 'real') {
          const receipt = path.join(directory, task.id + '.receipt.json');
          const result = await analyzeGemini({ input, source, receipt,
            apiKey: existsSync(receipt) ? '' : settings.credentials(input), transport: analysisTransport,
            markSending() { store.sql.prepare("INSERT INTO analysis_attempts(task_id,phase) VALUES (?,'sending') ON CONFLICT(task_id) DO UPDATE SET phase='sending'").run(task.id); } });
          plan = result.plan;
          store.sql.prepare("UPDATE analysis_attempts SET phase='received',evidence=? WHERE task_id=?").run(JSON.stringify(result.evidence), task.id);
        } else plan = mockAnalysis(state.preset);
        for (const shot of plan.shots) {
          await ffmpeg(['-ss', String(shot.start), '-i', source, '-frames:v', '1', '-vf', 'scale=360:-2',
            '-threads', '1', path.join(directory, 'original-' + shot.id + '.png')]);
        }
        store.sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(plan), task.project);
      } else if (task.kind === 'role') {
        const style = styles.find(style => style.id === input.style);
        const roleIndex = Math.max(0, state.plan?.characters?.findIndex(c => c.id === input.roleId) ?? 0);
        const crop = roleIndex === 0
          ? { left: 340, top: 50, width: 820, height: 900 }
          : roleIndex === 1
            ? { left: 160, top: 110, width: 720, height: 840 }
            : { left: 520, top: 110, width: 720, height: 840 };
        let pipeline = sharp(path.join(fixtureRoot, style.image + '.webp')).extract(await variantCrop(path.join(fixtureRoot, style.image + '.webp'), crop, input.variant));
        if (roleIndex === 1) pipeline = pipeline.modulate({ brightness: 0.94, saturation: 0.85, hue: 14 });
        else if (roleIndex > 1) pipeline = pipeline.modulate({ brightness: 1.03, saturation: 0.88, hue: -14 });
        await pipeline.resize(576, 720, { fit: 'cover' }).modulate(variantTone(input.variant)).png().toFile(temp);
      } else if (task.kind === 'frame') {
        // The selected role asset supplies the pixels for character shots.
        const roleTask = input.roles[0]?.taskId;
        const file = roleTask ? taskFile(store, store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(roleTask))
          : path.join(fixtureRoot, styles.find(style => style.id === input.style).image + '.webp');
        const crop = roleTask ? input.roleCrop : input.crop;
        await fixtureFrame(file, temp, crop ? await variantCrop(file, crop, input.variant) : crop, state.aspectRatio);
      } else if (task.kind === 'video') {
        const frame = store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(input.firstFrameTask);
        await animateFrame(taskFile(store, frame), temp, input.duration, input.variant, input.camera, state.aspectRatio);
      } else if (task.kind === 'film') {
        const files = input.clips.map(id => taskFile(store, store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(id)));
        await assemble(files, temp, state.plan, {
          audioMode: input.audioMode || state.audioMode,
          sourceFile: path.join(directory, 'source.mp4'),
        });
      }
      if (task.kind !== 'analysis') await fs.rename(temp, output);
      store.sql.prepare("UPDATE tasks SET status='completed',error=NULL WHERE id=?").run(task.id);
    } catch (error) {
      const sent = store.sql.prepare('SELECT phase FROM analysis_attempts WHERE task_id=?').get(task.id);
      const taskStatus = error.taskStatus || (input.mode === 'real' && sent ? 'result_error' : 'failed');
      const message = redact(error.message);
      store.sql.prepare('UPDATE tasks SET status=?,error=? WHERE id=?').run(taskStatus, message, task.id);
      console.error('[reconstruction-demo]', task.id, message);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async function tick() {
    while (inFlight.size < MAX_CONCURRENCY) {
      const task = store.sql.transaction(() => {
        const row = store.sql.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY rowid LIMIT 1").get();
        if (row) store.sql.prepare("UPDATE tasks SET status='running' WHERE id=?").run(row.id);
        return row;
      }).immediate();
      if (!task) break;
      const p = execute(task).finally(() => {
        inFlight.delete(p);
        if (timer) void tick().catch(console.error);
      });
      inFlight.add(p);
    }
    if (inFlight.size) await Promise.race([...inFlight]);
  }
  return {
    start() {
      for (const task of store.sql.prepare("SELECT * FROM tasks WHERE status='running'").all()) {
        const input = JSON.parse(task.input);
        const sent = store.sql.prepare('SELECT phase FROM analysis_attempts WHERE task_id=?').get(task.id);
        const receipt = path.join(store.root, task.project, task.id + '.receipt.json');
        const unknown = input.mode === 'real' && sent && !existsSync(receipt);
        store.sql.prepare('UPDATE tasks SET status=?,error=? WHERE id=?').run(unknown ? 'needs_review' : 'queued',
          unknown ? '进程中断：原分析已开始发送，但没有完整回执；请核对上游记录，不会自动重发' : null, task.id);
      }
      timer = setInterval(() => void tick().catch(console.error), 160);
      timer.unref();
      void tick();
    },
    tick,
    stop() { clearInterval(timer); timer = null; },
    async idle() { while (inFlight.size) await Promise.allSettled([...inFlight]); },
  };
}

export async function prepareReference(root) {
  const destination = path.join(root, 'sample-reference.mp4');
  try { await fs.stat(destination); return destination; } catch {}
  const plan = mockAnalysis();
  const parts = [];
  for (const shot of plan.shots) {
    const frame = path.join(root, 'sample-frame-' + shot.id + '.png');
    const clip = path.join(root, 'sample-video-' + shot.id + '.mp4');
    await fixtureFrame(path.join(fixtureRoot, 'cinematic.webp'), frame, shot.crop);
    await animateFrame(frame, clip, shot.end - shot.start);
    parts.push(clip);
  }
  await assemble(parts, destination, plan);
  return destination;
}
