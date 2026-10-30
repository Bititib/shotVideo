import { afterAll, beforeAll, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { pluginUpdateRouter } from '../server/routes/pluginUpdates.js';
let server: Server, base: string;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxu-releases-'));
beforeAll(async () => {
  fs.writeFileSync(path.join(dir,'latest.json'), '{"version":"1.1.0"}'); fs.writeFileSync(path.join(dir,'config.json'),'private');
  fs.writeFileSync(path.join(dir,'lingxu-video-1.1.0.zip'),'release');
  const app=express(); app.use('/plugin-updates/video_plugin_site_api',pluginUpdateRouter(dir));
  await new Promise<void>(resolve => { server=app.listen(0,'127.0.0.1',resolve); }); base='http://127.0.0.1:'+(server.address() as any).port+'/plugin-updates/video_plugin_site_api/';
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true});});
it('serves public releases and never caches the version pointer', async()=>{
  const response=await fetch(base+'latest.json');expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({version:'1.1.0'});expect(await (await fetch(base+'lingxu-video-1.1.0.zip')).text()).toBe('release');
});
it('cannot expose config or files outside the allowlist', async()=>{
  for(const file of ['config.json','.state','%2e%2e%2fconfig.json','main.py']) expect((await fetch(base+file)).status).toBe(404);
});
