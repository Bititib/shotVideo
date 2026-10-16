// Local-only gallery acceptance fixture. No database, keys, or upstream requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('client/dist');
const rows = [
  { id: 8008, status: 'processing', inputText: '清晨的森林，柔和光线穿过树叶', metadata: { progresses: [65], count: 1 } },
  { id: 8007, status: 'completed', inputText: '品牌吉祥物，干净背景', resultUrl: '/brand/lingxu-mascot.png' },
  { id: 8006, status: 'failed', inputText: '一只金毛犬在花园里奔跑', metadata: { count: 1, failureReason: '上游提交失败，请检查后重新生成' } },
  { id: 8005, status: 'review', inputText: '海边木屋，日落时分', metadata: { count: 1, requiresReview: true, progressText: '提交结果待核实，请勿重复提交' } },
  { id: 8004, status: 'completed', inputText: '吉祥物的两张构图', resultUrl: '/brand/lingxu-mascot.png?one', metadata: { count: 2, imageUrls: ['/brand/lingxu-mascot.png?one', '/brand/lingxu-mascot.png?two'] } },
  { id: 8003, status: 'queued', inputText: '远处群山与湖面倒影', metadata: { count: 1 } },
].map((row, index) => ({ ...row, modelId: 'gpt-image-2', createdAt: new Date(Date.now() - index * 60_000).toISOString(), metadata: { aspectRatio: '16:9', ...row.metadata } }));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (req.method !== 'GET') { res.writeHead(405); res.end('Preview is read-only'); return; }
    if (url.pathname === '/api/auth/me') data = { id: 999, email: 'preview@example.invalid', username: '布局预览', role: 'super_admin', isActive: 1, hasActiveApiKey: true };
    else if (url.pathname === '/api/image-gen/models') data = [{ id: 'gpt-image-2', name: 'gpt-image-2 · Pidoi 原生', rate: .22, available: true, maxReferenceImages: 5 }];
    else if (url.pathname === '/api/contents') data = { items: rows, total: rows.length };
    else if (url.pathname === '/api/admin/settings' || url.pathname.includes('announcements')) data = [];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
    return;
  }
  const requested = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  const file = requested.startsWith(root + path.sep) && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(root, 'index.html');
  const ext = path.extname(file);
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' })[ext] || 'application/octet-stream');
  const body = fs.readFileSync(file);
  res.end(ext === '.html' ? body.toString().replace('<head>', '<head><script>localStorage.setItem("token","isolated-gallery-preview")</script>') : body);
});
server.listen(4179, '127.0.0.1', () => console.log('Gallery preview: http://127.0.0.1:4179/app/image-gen'));
