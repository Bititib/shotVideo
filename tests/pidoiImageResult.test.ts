import { afterEach, expect, it, vi } from 'vitest';
import { downloadPidoiContent, pidoiContentUrl } from '../server/services/pidoiImageResult.js';
const auth={baseUrl:'https://pidoi.com/v1',apiKey:'test-secret',taskId:'task_original'};
const url='https://pidoi.com/v1/image/generations/task_original/content?index=0';
afterEach(()=>vi.unstubAllGlobals());
it('只向原 Pidoi 任务的鉴权图片地址发送原密钥，禁止重定向',async()=>{
  const bytes=Buffer.from('original-image-bytes');
  const f=vi.fn().mockResolvedValue(new Response(bytes));vi.stubGlobal('fetch',f);
  expect(await downloadPidoiContent(url,auth)).toEqual(bytes);
  expect(f).toHaveBeenCalledExactlyOnceWith(url,expect.objectContaining({method:'GET',headers:{Authorization:'Bearer test-secret'},redirect:'error'}));
  expect(pidoiContentUrl('/v1/image/generations/task_original/content?index=0',auth.baseUrl,auth.taskId)).toBe(url);
});
it.each(['https://cdn.test/image.png','https://pidoi.com.evil.test/v1/image/generations/task_original/content',
  'https://pidoi.com/v1/image/generations/task_other/content','https://pidoi.com/v1/image/generations/task_original/content?redirect=https://evil.test',
  'http://pidoi.com/v1/image/generations/task_original/content','https://user:password@pidoi.com/v1/image/generations/task_original/content'])('拒绝向非原任务内容地址传密钥：%s',async source=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);
  expect(pidoiContentUrl(source,auth.baseUrl,auth.taskId)).toBeNull();
  await expect(downloadPidoiContent(source,auth)).rejects.toThrow('不匹配');expect(f).not.toHaveBeenCalled();
});
it('下载鉴权错误保留 HTTP 状态，不把错误页当图片',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('Invalid token',{status:401})));
  await expect(downloadPidoiContent(url,auth)).rejects.toThrow('HTTP 401');
});
it('拒绝超出大小限制的结果',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('too big',{headers:{'content-length':String(21*1024*1024)}})));
  await expect(downloadPidoiContent(url,auth)).rejects.toThrow('超过 20MB');
});
