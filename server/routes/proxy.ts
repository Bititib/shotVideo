import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Readable } from 'stream';
import ytdl from '@distube/ytdl-core';

const router = Router();

// 视频提取代理
router.post('/video', authMiddleware, async (req: Request, res: Response) => {
  const { url } = req.body;
  try {
    let videoUrl = url;

    if (url.includes('tiktok.com') || url.includes('douyin.com')) {
      const tikwmRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const tikwmData = await tikwmRes.json();
      if (tikwmData.data && tikwmData.data.play) {
        videoUrl = tikwmData.data.play;
      } else {
        throw new Error('无法解析该 TikTok/Douyin 链接，请确保链接公开可用。');
      }
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try {
        const info = await ytdl.getInfo(url);
        let format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
        if (!format) throw new Error('找不到包含音视频的有效 YouTube 格式。');

        res.setHeader('Content-Type', 'video/mp4');
        if (format.contentLength) {
          if (parseInt(format.contentLength) > 150 * 1024 * 1024) {
            throw new Error('视频文件过大，当前支持最高150MB。');
          }
          res.setHeader('Content-Length', format.contentLength);
        }

        const videoStream = ytdl.downloadFromInfo(info, { format });
        videoStream.pipe(res);
        videoStream.on('error', (err) => {
          console.error('Youtube stream error:', err);
          if (!res.headersSent) res.status(500).json({ error: '视频流传输失败' });
          else res.end();
        });
        return;
      } catch (e: any) {
        if (e.message.includes('Sign in to confirm')) {
          throw new Error('YouTube 触发了反机器人验证，建议下载原始视频后通过本地上传导入。');
        }
        throw new Error('无法解析该 YouTube 链接: ' + e.message);
      }
    }

    // Direct URL fetch
    const videoRes = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': url,
      },
    });

    if (!videoRes.ok) throw new Error(`获取视频流失败 (HTTP ${videoRes.status})`);

    const contentType = videoRes.headers.get('content-type') || 'video/mp4';
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new Error('目标链接未返回有效的视频流');
    }

    const contentLength = videoRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 150 * 1024 * 1024) {
      throw new Error('视频文件过大，当前支持最高150MB。');
    }

    res.setHeader('Content-Type', contentType.startsWith('video/') ? contentType : 'video/mp4');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (videoRes.body) {
      const readable = Readable.fromWeb(videoRes.body as any);
      readable.pipe(res);
      readable.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: '视频流传输失败' });
        else res.end();
      });
    } else {
      throw new Error('No video body');
    }
  } catch (error: any) {
    console.error('Video extraction error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// 图片提取代理
router.post('/image', authMiddleware, async (req: Request, res: Response) => {
  const { url, mode } = req.body;
  try {
    let source: URL;
    try { source = new URL(url); } catch { return res.status(400).json({ error: '请输入有效的图片或图文链接' }); }
    if (!['http:', 'https:'].includes(source.protocol)) return res.status(400).json({ error: '仅支持 HTTP 或 HTTPS 链接' });
    let imageUrl = url;
    let images: string[] = [url];
    let audioUrl = '';
    let audioTitle = '';
    let audioAuthor = '';

    if (['tiktok.com', 'douyin.com'].some(domain => source.hostname === domain || source.hostname.endsWith(`.${domain}`))) {
      const tikwmRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30000) });
      if (!tikwmRes.ok) throw new Error(`图文链接解析失败 (HTTP ${tikwmRes.status})`);
      const tikwmData = await tikwmRes.json();
      if (!tikwmData.data) throw new Error('图文链接解析未返回图片数据');
      if (tikwmData.data) {
        if (tikwmData.data.images?.length > 0) {
          if (!Array.isArray(tikwmData.data.images) || !tikwmData.data.images.every((value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value))) throw new Error('图文链接返回的图片列表格式不正确');
          images = tikwmData.data.images;
          imageUrl = images[0];
        } else if (tikwmData.data.cover) {
          imageUrl = tikwmData.data.cover;
          images = [imageUrl];
        } else {
          throw new Error('无法解析该链接的图片。');
        }

        if (tikwmData.data.music_info) {
          audioUrl = tikwmData.data.music_info.play || '';
          audioTitle = tikwmData.data.music_info.title || '';
          audioAuthor = tikwmData.data.music_info.author || '';
        } else if (tikwmData.data.music) {
          audioUrl = tikwmData.data.music;
        }
      }
    }

    // Listing is read-only: do not download or analyze a default first image.
    if (mode === 'list') return res.json({ images, audioUrl, audioTitle, audioAuthor });

    const imageRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': url,
      },
    });

    if (!imageRes.ok) throw new Error(`获取图片失败 (HTTP ${imageRes.status})`);

    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new Error('目标链接未返回有效的图片数据');
    }

    const contentLength = imageRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
      throw new Error('图片文件过大，请使用小于10MB的图片');
    }

    res.setHeader('Content-Type', contentType.startsWith('image/') ? contentType : 'image/jpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const exposeHeaders = ['X-Audio-Url'];
    if (audioUrl) res.setHeader('X-Audio-Url', encodeURIComponent(audioUrl));
    if (audioTitle) { exposeHeaders.push('X-Audio-Title'); res.setHeader('X-Audio-Title', encodeURIComponent(audioTitle)); }
    if (audioAuthor) { exposeHeaders.push('X-Audio-Author'); res.setHeader('X-Audio-Author', encodeURIComponent(audioAuthor)); }
    if (exposeHeaders.length > 0) res.setHeader('Access-Control-Expose-Headers', exposeHeaders.join(', '));

    if (imageRes.body) {
      const readable = Readable.fromWeb(imageRes.body as any);
      readable.pipe(res);
      readable.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: '图片传输失败' });
        else res.end();
      });
    } else {
      throw new Error('No image body');
    }
  } catch (error: any) {
    console.error('Image extraction error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

export default router;
