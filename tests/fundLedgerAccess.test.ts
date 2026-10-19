import {describe,it,expect,vi} from 'vitest';
import express from 'express';
vi.mock('../server/middleware/auth.js',()=>({authMiddleware:(req:any,res:any,next:any)=>{if(!req.headers['x-test-role'])return res.sendStatus(401);req.userRole=req.headers['x-test-role'];next();}}));
vi.mock('../server/db/index.js',()=>({sqlite:{}}));
vi.mock('../server/db/fundLedger.js',()=>({ensureFundLedger:vi.fn()}));
vi.mock('../server/services/fundLedgerQuery.js',()=>({listFundLedger:vi.fn(()=>({items:[],total:0}))}));
import router from '../server/routes/fundLedger';
import {listFundLedger} from '../server/services/fundLedgerQuery';
it('requires super administrator authorization on the server, not just a hidden menu',async()=>{const app=express();app.use('/fund-ledger',router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as any).port+'/fund-ledger';try{for(const role of ['', 'user','org_admin','org_owner']){const res=await fetch(url,{headers:role?{'x-test-role':role}:{}});expect(res.status).toBe(role?403:401);}expect(listFundLedger).not.toHaveBeenCalled();for(const role of ['admin','super_admin']){const res=await fetch(url,{headers:{'x-test-role':role}});expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');}}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}});
