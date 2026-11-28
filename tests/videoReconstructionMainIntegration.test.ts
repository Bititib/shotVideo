import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore
import { createStore } from '../server/reconstruction-demo/store.mjs';
// @ts-ignore
import { createWorker, prepareReference, taskFile } from '../server/reconstruction-demo/worker.mjs';
// @ts-ignore
import { probe } from '../server/reconstruction-demo/media.mjs';
// @ts-ignore
import { analyzeGemini, AnalysisError, validatePlan } from '../server/reconstruction-demo/gemini-analysis.mjs';

describe('Video Reconstruction Commercial Integration (Multi-Tenant, Aspect Ratio, Audio & Temp Cleanup)', () => {
  it('enforces user_id ownership, aspect ratio dimensions (16:9), audio track preservation, and temp file cleanup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recon-main-test-'));
    const store = createStore(dir);
    const worker = createWorker(store);
    try {
      const sample = await prepareReference(dir);
      const pid = store.create('横屏带音轨测试', '', { aspectRatio: '16:9', userId: 42, orgId: 7 });
      await fs.copyFile(sample, path.join(dir, pid, 'source.mp4'));

      let state = store.project(pid);
      expect(state.userId).toBe(42);
      expect(state.orgId).toBe(7);
      expect(state.aspectRatio).toBe('16:9');
      expect(state.audioMode).toBe('original');

      // Invalid aspect ratio or audio mode rejected with 422
      expect(() => store.setAspectRatio(pid, '4:5')).toThrow();
      expect(() => store.setAudioMode(pid, 'invalid')).toThrow();

      // Valid switch before frame generation
      state = store.setAspectRatio(pid, '1:1');
      expect(state.aspectRatio).toBe('1:1');
      state = store.setAudioMode(pid, 'mute');
      expect(state.audioMode).toBe('mute');
      state = store.setAudioMode(pid, 'original');
      expect(state.audioMode).toBe('original');

      // Run breakdown + role + frame + video + film at 1:1 (960x960)
      store.enqueue(pid, 'analysis', 'main', { requestKey: 'analysis-' + pid });
      await worker.tick();
      await worker.idle();
      state = store.project(pid);
      expect(state.plan.shots.length).toBe(3);
      expect(state.plan.characters[0].kind).toBe('person');
      expect(state.plan.shots.map((s: any) => s.camera)).toEqual(['push_in', 'tilt_down', 'pull_out']);

      const roleId = store.enqueue(pid, 'role', 'ning', { prompt: '阿宁', requestKey: 'role-ning-' + pid });
      await worker.tick();
      await worker.idle();
      store.confirm(pid, 'role', 'ning', roleId);

      for (const shot of state.plan.shots) {
        const fid = store.enqueue(pid, 'frame', shot.id, { prompt: shot.framePrompt, requestKey: `frame-${shot.id}-${pid}` });
        await worker.tick();
        await worker.idle();
        store.confirm(pid, 'frame', shot.id, fid);
      }

      // Changing aspect ratio after frame generation is rejected with 409
      expect(() => store.setAspectRatio(pid, '9:16')).toThrow(/已有生成分镜/);

      for (const shot of state.plan.shots) {
        const vid = store.enqueue(pid, 'video', shot.id, { prompt: shot.videoPrompt, camera: 'push_in', requestKey: `video-${shot.id}-${pid}` });
        await worker.tick();
        await worker.idle();
        store.confirm(pid, 'video', shot.id, vid);
      }

      const filmTaskId = store.enqueue(pid, 'film', 'main', { audioMode: 'original', requestKey: 'film-orig-' + pid });
      await worker.tick();
      await worker.idle();

      const filmRow = store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(filmTaskId);
      expect(filmRow.status).toBe('completed');
      const filmFile = taskFile(store, filmRow);
      const info = await probe(filmFile);
      const videoStream = info.streams.find((s: any) => s.codec_type === 'video');
      const audioStream = info.streams.find((s: any) => s.codec_type === 'audio');
      expect(videoStream.width).toBe(960);
      expect(videoStream.height).toBe(960);
      expect(audioStream.codec_name).toBe('aac');

      // Verify temporary slice files were cleaned up while captions.vtt remains
      const projectDir = path.join(dir, pid);
      expect(existsSync(path.join(projectDir, 'assemble-0.mp4'))).toBe(false);
      expect(existsSync(path.join(projectDir, 'concat.txt'))).toBe(false);
      expect(existsSync(path.join(projectDir, 'captions.srt'))).toBe(false);
      expect(existsSync(path.join(projectDir, 'captions.vtt'))).toBe(true);
    } finally {
      worker.stop();
      await worker.idle();
      store.sql.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it('validates skill-structured breakdown plans (product kind, 12-camera normalization, minimal backward compat)', () => {
    const rich = validatePlan({
      title: '精华液开箱对比',
      hook: '开场 1 秒滴管挤出金色精华微距拉近',
      continuity: '明亮柔光卧室梳妆台，琥珀玻璃瓶贯穿全片',
      characters: [
        { id: 'host', kind: 'person', name: '林夏', appearance: '25岁女性，低马尾，米白真丝衬衫' },
        { id: 'serum', kind: 'product', name: '琥珀精华瓶', appearance: '15cm柱状磨砂玻璃瓶，黑色胶头滴管' },
      ],
      shots: [
        {
          id: '01',
          start: 0,
          end: 2.5,
          title: '产品微距钩子',
          characters: ['serum'],
          scene: '日间 · 梳妆台微距 · 晨光侧逆光',
          action: '玻璃滴管悬停在琥珀瓶口上方，挤出一滴晶莹液体',
          speaker: '旁白',
          audio: '轻微玻璃轻响与明快电子节拍起拍',
          camera: 'zoom_in',
          framePrompt: '微距特写，琥珀精华瓶居中于大理石桌面，滴管悬在瓶口，右侧柔光照射。',
          videoPrompt: '镜头缓缓推近滴管末端，金色精华凝成水滴垂落，背景虚化柔光泛起。',
          caption: '熬夜暗沉脸救星来了',
        },
        {
          id: '02',
          start: 2.5,
          end: 6,
          title: '人物涂抹体验',
          characters: ['host', 'serum'],
          camera: 'orbit',
          framePrompt: '中近景，林夏面对镜头左手托起精华瓶，右手轻点面部。',
          videoPrompt: '机位轻柔环绕半圈，林夏微笑推开精华，皮肤呈现自然光泽。',
          caption: '上脸三秒化水吸收',
        },
        {
          id: '03',
          start: 6,
          end: 10,
          title: '桌面定格收尾',
          characters: ['serum'],
          camera: 'unrecognized_fancy_cam',
          framePrompt: '平视桌面全景，精华瓶置于右侧三分线处。',
          videoPrompt: '镜头保持平稳落幅收尾。',
          caption: '',
        },
      ],
    }, 10);

    expect(rich.characters[0].kind).toBe('person');
    expect(rich.characters[1].kind).toBe('product');
    expect(rich.shots[0].camera).toBe('push_in');
    expect(rich.shots[0].scene).toContain('梳妆台');
    expect(rich.shots[0].speaker).toBe('旁白');
    expect(rich.shots[1].camera).toBe('orbit');
    expect(rich.shots[2].camera).toBe('auto');

    const minimal = validatePlan({
      title: '极简兼容样例',
      characters: [{ id: 'p1', name: '主演', appearance: '黑衣短发' }],
      shots: [{ id: '01', start: 0, end: 5, title: '开场', characters: ['p1'], framePrompt: '半身近景', videoPrompt: '固定拍摄', caption: '你好' }],
    }, 5);
    expect(minimal.characters[0].kind).toBe('person');
    expect(minimal.shots[0].camera).toBe('auto');
    expect(minimal.shots[0].scene).toBe('');

    expect(() => validatePlan({
      title: '非法主体类型',
      characters: [{ id: 'x1', kind: 'alien', name: '未知', appearance: '未知外观' }],
      shots: [{ id: '01', start: 0, end: 5, title: '空', characters: [], framePrompt: 'a', videoPrompt: 'b', caption: '' }],
    }, 5)).toThrow(AnalysisError);
  });

  it('uses Resumable Gemini Files API for large videos, polls PROCESSING -> ACTIVE, cleans up remote file, and isolates upload vs send receipts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recon-resumable-'));
    try {
      const sample = await prepareReference(dir);
      const receipt = path.join(dir, 'analysis.receipt.json');
      const calls: Array<{ method: string; url: string; headers: any }> = [];
      let pollCount = 0;
      let markSendingCount = 0;

      const planPayload = {
        title: '长视频拆解',
        hook: '实拍导入测试',
        continuity: '自然室内光',
        characters: [{ id: 'p1', kind: 'person', name: '主角', appearance: '深蓝卫衣' }],
        shots: [{
          id: '01', start: 0, end: 15, title: '完整单镜', characters: ['p1'],
          scene: '室内 · 桌面 · 柔和自然光', action: '主角在桌前展示产品细节', speaker: '主角', audio: '清晰人声讲解',
          camera: 'static', framePrompt: '桌面中景，主角坐在木桌前展示产品。', videoPrompt: '固定机位，主角自然手势讲解。', caption: '今天来看这款新品',
        }],
      };

      const transport = async (url: string, options: any) => {
        calls.push({ method: options.method, url, headers: options.headers });
        if (url === 'https://gemini.example/upload/v1beta/files') {
          return new Response('', {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://gemini.example/upload/v1beta/files?upload_id=up-123' },
          });
        }
        if (url === 'https://gemini.example/upload/v1beta/files?upload_id=up-123') {
          return new Response(JSON.stringify({
            file: { name: 'files/vid-abc', uri: 'https://gemini.example/v1beta/files/vid-abc', mimeType: 'video/mp4', state: 'PROCESSING' },
          }), { status: 200 });
        }
        if (url === 'https://gemini.example/v1beta/files/vid-abc' && options.method === 'GET') {
          pollCount += 1;
          return new Response(JSON.stringify({
            name: 'files/vid-abc',
            uri: 'https://gemini.example/v1beta/files/vid-abc',
            mimeType: 'video/mp4',
            state: pollCount >= 2 ? 'ACTIVE' : 'PROCESSING',
          }), { status: 200 });
        }
        if (url === 'https://gemini.example/v1beta/models/gemini-2.5-pro:generateContent') {
          const parsedBody = JSON.parse(options.body);
          expect(parsedBody.contents[0].parts[0].fileData).toEqual({
            mimeType: 'video/mp4',
            fileUri: 'https://gemini.example/v1beta/files/vid-abc',
          });
          expect(parsedBody.contents[0].parts[0].inlineData).toBeUndefined();
          return new Response(JSON.stringify({
            responseId: 'resp-large-1',
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(planPayload) }] } }],
          }), { status: 200, headers: { 'x-request-id': 'req-large-1' } });
        }
        if (url === 'https://gemini.example/v1beta/files/vid-abc' && options.method === 'DELETE') {
          return new Response('{}', { status: 200 });
        }
        throw new Error(`Unexpected call: ${options.method} ${url}`);
      };

      const res = await analyzeGemini({
        input: { baseUrl: 'https://gemini.example', model: 'gemini-2.5-pro' },
        source: sample,
        apiKey: 'secret-gemini-key',
        receipt,
        markSending: () => { markSendingCount += 1; },
        transport,
        inlineLimitBytes: 128,
        uploadPollMs: 5,
      });

      expect(res.plan.shots[0].camera).toBe('static');
      expect(markSendingCount).toBe(1);
      expect(pollCount).toBe(2);
      expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'POST /upload/v1beta/files',
        'POST /upload/v1beta/files',
        'GET /v1beta/files/vid-abc',
        'GET /v1beta/files/vid-abc',
        'POST /v1beta/models/gemini-2.5-pro:generateContent',
        'DELETE /v1beta/files/vid-abc',
      ]);

      // Failure during upload step does not markSending (no generation bill yet), cleanly fails
      const failReceipt = path.join(dir, 'fail-upload.receipt.json');
      let failMarkSending = 0;
      await expect(analyzeGemini({
        input: { baseUrl: 'https://gemini.example', model: 'gemini-2.5-pro' },
        source: sample,
        apiKey: 'secret-key-xyz',
        receipt: failReceipt,
        markSending: () => { failMarkSending += 1; },
        inlineLimitBytes: 128,
        transport: async () => new Response(JSON.stringify({ error: { code: 403, message: 'denied https://gemini.example/internal secret-key-xyz' } }), { status: 403 }),
      })).rejects.toMatchObject({ taskStatus: 'failed' });
      expect(failMarkSending).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it('creates a script-only project without source.mp4 and completes role -> frame -> video -> film cleanly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recon-script-only-'));
    const store = createStore(dir);
    const worker = createWorker(store);
    try {
      const pid = store.createFromScript({
        title: '无原片咖啡馆剧本',
        aspectRatio: '16:9',
        scriptText: [
          '【第 1 场｜0s–4s｜推门入店｜日间 · 咖啡馆】',
          '出镜：林夏',
          '画面：林夏推开木门走进阳光斜照的咖啡馆。',
          '林夏：“请问有人在吗？”',
          '音效：风铃轻响',
          '',
          '【第 2 场｜4s–9s｜微笑回应｜日间 · 吧台前】',
          '出镜：顾沉',
          '画面：顾沉抬起头从吧台后递出咖啡杯。',
          '顾沉：“刚煮好的拿铁，请慢用。”',
        ].join('\n'),
      }, { userId: 9 });

      const state0 = store.project(pid);
      expect(state0.hasSource).toBe(false);
      expect(state0.source).toBe('');
      expect(state0.aspectRatio).toBe('16:9');
      expect(state0.plan.characters.map((c: any) => c.name)).toEqual(['林夏', '顾沉']);
      expect(state0.plan.shots).toHaveLength(2);
      expect(state0.plan.shots[0].caption).toContain('请问有人在吗');

      for (const r of state0.plan.characters) {
        const rid = store.enqueue(pid, 'role', r.id, { prompt: r.appearance, requestKey: `script-role-${r.id}-${pid.slice(0, 8)}` });
        await worker.tick();
        await worker.idle();
        store.confirm(pid, 'role', r.id, rid);
      }
      for (const s of state0.plan.shots) {
        const fid = store.enqueue(pid, 'frame', s.id, { prompt: s.framePrompt, requestKey: `script-frame-${s.id}-${pid.slice(0, 8)}` });
        await worker.tick();
        await worker.idle();
        store.confirm(pid, 'frame', s.id, fid);
      }
      for (const s of state0.plan.shots) {
        const vid = store.enqueue(pid, 'video', s.id, { prompt: s.videoPrompt, camera: 'static', requestKey: `script-video-${s.id}-${pid.slice(0, 8)}` });
        await worker.tick();
        await worker.idle();
        store.confirm(pid, 'video', s.id, vid);
      }
      const filmId = store.enqueue(pid, 'film', 'main', { audioMode: 'original', requestKey: `script-film-main-${pid.slice(0, 8)}` });
      await worker.tick();
      await worker.idle();

      const filmRow = store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(filmId);
      expect(filmRow.status).toBe('completed');
      expect(existsSync(taskFile(store, filmRow))).toBe(true);
    } finally {
      worker.stop();
      await worker.idle();
      store.sql.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it('parses rich Markdown scripts without an 80-shot cap and splits scenes by selected video model duration limits', async () => {
    // @ts-ignore
    const { parsePlainScriptToPlan } = await import('../server/reconstruction-demo/script-parser.mjs');

    const mdScript = [
      '# 益生菌爆珠 3D 剧场',
      '',
      '## 人物设定表',
      '| 角色名 | 核心外貌特征 |',
      '| :--- | :--- |',
      '| **菌哥** | 圆滚滚紫黑色坏菌，戴金属铆钉项圈，性格嚣张 |',
      '| **Dr. Mint（薄荷博士）** | 蓝白宇航服风格 3D 益生菌战士，佩戴薄荷叶护目镜 |',
      '',
      '## 第一幕：危机降临',
      '**【00:00 - 00:25】口腔派对：坏菌狂欢**',
      '* **画面**：显微镜视角下的粉色口腔隧道，菌哥踩在滑板上大笑，随后 Dr. Mint 从天而降。',
      '* **菌哥**：',
      '> "Time to party all night!"',
      '> （今晚狂欢到底！）',
      '* **Dr. Mint**：',
      '> "Not on my watch!"',
      '> （有我在休想！）',
    ].join('\n');

    // Model A: max 10s (e.g. Kling [5, 10]) -> 25s scene splits into 3 shots <= 10s
    const klingPlan = parsePlainScriptToPlan(mdScript, {
      videoModel: 'kling-2-1',
      allowedSeconds: [5, 10],
    });
    expect(klingPlan.title).toBe('益生菌爆珠 3D 剧场');
    expect(klingPlan.characters.length).toBe(2);
    expect(klingPlan.characters[0].appearance).toContain('金属铆钉项圈');
    expect(klingPlan.shots.length).toBe(3);
    for (const s of klingPlan.shots) {
      expect(s.end - s.start).toBeLessThanOrEqual(10);
      expect([5, 10]).toContain(s.end - s.start);
    }
    expect(klingPlan.shots.some((s: any) => s.caption.includes('Time to party all night'))).toBe(true);

    // Model B: max 25s (e.g. Seedance 2.5m [4..25]) -> same 25s scene stays 1 shot
    const longModelPlan = parsePlainScriptToPlan(mdScript, {
      videoModel: 'seedance-2.5m',
      allowedSeconds: Array.from({ length: 22 }, (_, i) => i + 4),
    });
    expect(longModelPlan.shots).toHaveLength(1);
    expect(longModelPlan.shots[0].end - longModelPlan.shots[0].start).toBe(25);

    // No 80-shot cap: 95 scenes should all be preserved
    const manyScenes = Array.from({ length: 95 }, (_, idx) => [
      `【第 ${idx + 1} 场｜${idx * 5}s-${(idx + 1) * 5}s】`,
      `出镜：主角`,
      `画面：第 ${idx + 1} 场动作推进。`,
      `主角：“台词 ${idx + 1}”`,
    ].join('\n')).join('\n\n');
    const largePlan = parsePlainScriptToPlan(manyScenes, { allowedSeconds: [5, 10] });
    expect(largePlan.shots).toHaveLength(95);
    expect(largePlan.shots[94].id).toBe('95');
  });
});
