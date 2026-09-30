import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applicationCors } from '../server/middleware/cors';
import { validateProductionConfig } from '../server/config/production';
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(applicationCors({ NODE_ENV:'production', BACKEND_URL:'https://studio.test' }));
  app.get('/api/account', (_req,res) => res.json({ok:true}));
  app.post('/v1/chat/completions', (_req,res) => res.status(401).json({error:'Missing API key'}));
  server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
it('allows missing or blank optional origins at startup',()=>{
  const config={NODE_ENV:'production',JWT_SECRET:'b8a4d021861e4bb2b5f3dbd3f90eb617',ADMIN_PASSWORD:'random-secret-299374',BACKEND_URL:'https://studio.test'};
  expect(()=>validateProductionConfig(config)).not.toThrow();
  expect(()=>validateProductionConfig({...config,ALLOWED_ORIGINS:'  '})).not.toThrow();
});
it('accepts API preflight from an arbitrary customer frontend with authorization',async()=>{
  const r=await fetch(`${base}/v1/chat/completions`,{method:'OPTIONS',headers:{Origin:'https://customer.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
  expect(r.status).toBe(204);expect(r.headers.get('access-control-allow-origin')).toBe('*');
  expect(r.headers.get('access-control-allow-headers')).toContain('authorization');
  expect(r.headers.get('access-control-allow-credentials')).toBeNull();
});
it('adds public CORS headers without bypassing API authentication',async()=>{
  const r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{Origin:'https://customer.test'}});
  expect(r.status).toBe(401);expect(r.headers.get('access-control-allow-origin')).toBe('*');
  expect(r.headers.get('access-control-expose-headers')).toContain('X-Billing-Reservation');
});
it('defaults website CORS to BACKEND_URL and does not expose it to customer origins',async()=>{
  const own=await fetch(`${base}/api/account`,{headers:{Origin:'https://studio.test'}});
  expect(own.headers.get('access-control-allow-origin')).toBe('https://studio.test');
  const other=await fetch(`${base}/api/account`,{headers:{Origin:'https://customer.test'}});
  expect(other.headers.get('access-control-allow-origin')).toBeNull();
});
