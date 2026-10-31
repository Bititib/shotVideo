import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index';
import { users, tiers } from '../server/db/schema';
import authRouter, { registrationLimiter } from '../server/routes/auth';
import { env } from '../server/config/env';

let server: Server, origin: string;
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/api/auth',authRouter);
  server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin='http://127.0.0.1:'+(server.address() as any).port;});
beforeEach(()=>{registrationLimiter.resetKey('127.0.0.1');registrationLimiter.resetKey('::ffff:127.0.0.1');db.delete(users).run();db.delete(tiers).run();
  db.insert(tiers).values({id:1,name:'free',displayName:'免费用户',dailyQuota:3,allowedFeatures:'[]'}).run();});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();});
const valid={email:'new@example.com',username:'New user',password:'correct-password'};
const register=(body:any)=>fetch(origin+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

describe('public self registration through the real auth route',()=>{
  it('creates and logs in a normal free user with no balance or role assignment from the request',async()=>{
    const response=await register({...valid,email:' NEW@Example.COM ',username:' New user ',role:'super_admin',balance:999,tierId:99,orgId:5,isActive:0});
    expect(response.status).toBe(201);const result=await response.json() as any;
    const row=db.select().from(users).get()!;
    expect(row).toMatchObject({email:'new@example.com',username:'New user',role:'user',tierId:1,orgId:null,balance:0,isActive:1});
    expect(row.passwordHash).not.toBe(valid.password);expect(await bcrypt.compare(valid.password,row.passwordHash)).toBe(true);
    expect(jwt.verify(result.token,env.JWT_SECRET)).toMatchObject({userId:row.id,role:'user',orgId:null});
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    const profile=await fetch(origin+'/api/auth/me',{headers:{Authorization:'Bearer '+result.token}});
    expect(profile.status).toBe(200);expect(await profile.json()).toMatchObject({id:row.id,balance:0,hasActiveApiKey:false});
    const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'NEW@EXAMPLE.COM',password:valid.password})});
    expect(login.status).toBe(200);expect(sqlite.prepare('SELECT COUNT(*) AS n FROM api_tokens').get()).toEqual({n:0});
  });
  it.each([{...valid,email:'invalid'},{...valid,password:'123'},{...valid,password:'x'.repeat(73)},{...valid,username:' '},{...valid,email:{}},{...valid,password:null}])('rejects invalid input before creating any account: %j',async body=>{
    expect((await register(body)).status).toBe(400);expect(db.select().from(users).all()).toEqual([]);
  });
  it('returns a specific duplicate error for normalized emails and concurrent registrations',async()=>{
    const results=await Promise.all([register(valid),register(valid)]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    const duplicate=await register({...valid,email:' NEW@EXAMPLE.COM '});expect(duplicate.status).toBe(409);expect(await duplicate.json()).toEqual({error:'该邮箱已被注册'});
    expect(db.select().from(users).all()).toHaveLength(1);
  });
  it('limits repeated registration attempts and does not enable self recharge',async()=>{
    for(let i=0;i<10;i++)expect((await register({})).status).toBe(400);
    expect((await register({})).status).toBe(429);
    const recharge=await fetch(origin+'/api/auth/recharge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:999})});
    expect(recharge.status).toBe(401);expect(db.select().from(users).all()).toEqual([]);
  });
});
