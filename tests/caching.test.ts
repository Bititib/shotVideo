import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cleanVideoCache, downloadAndLocalizeGrokVideo } from '../server/routes/video.js';

describe('Video Cache and Localization Tests', () => {
  const videoCacheDir = path.resolve('data/video_cache');

  it('cleanVideoCache should delete files older than 3 days', () => {
    if (!fs.existsSync(videoCacheDir)) {
      fs.mkdirSync(videoCacheDir, { recursive: true });
    }
    const testFileOld = path.join(videoCacheDir, 'test_old.mp4');
    const testFileNew = path.join(videoCacheDir, 'test_new.mp4');

    fs.writeFileSync(testFileOld, 'dummy content');
    fs.writeFileSync(testFileNew, 'dummy content');

    // 将旧文件修改时间设置为 4 天前
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    fs.utimesSync(testFileOld, fourDaysAgo, fourDaysAgo);

    // 将新文件修改时间设置为 1 天前
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    fs.utimesSync(testFileNew, oneDayAgo, oneDayAgo);

    // 执行清理
    cleanVideoCache();

    // 验证旧文件已删除，新文件仍保留
    expect(fs.existsSync(testFileOld)).toBe(false);
    expect(fs.existsSync(testFileNew)).toBe(true);

    // 清理测试生成的新文件
    if (fs.existsSync(testFileNew)) {
      fs.unlinkSync(testFileNew);
    }
  });

  it('downloadAndLocalizeGrokVideo should return immediately for local relative URLs', async () => {
    const filename = `local-video-test-${randomUUID()}.mp4`;
    const file = path.resolve('data/uploads', filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=10:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1']));
    try {
      const localized = await downloadAndLocalizeGrokVideo(`/uploads/${filename}`, '123', 'grok-imagine-video');
      expect(localized).toBe(`/uploads/${filename}`);
    } finally { fs.unlinkSync(file); }

    await expect(downloadAndLocalizeGrokVideo('', '123', 'grok-imagine-video')).rejects.toThrow('without a video URL');
  });
});
