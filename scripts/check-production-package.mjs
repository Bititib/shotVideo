import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Reproduce the Docker runtime files without copying credentials or live data.
const root=process.cwd();
await fs.mkdir(path.join(root,'output'),{recursive:true});
const directory=await fs.mkdtemp(path.join(root,'output','production-package-'));
for(const entry of ['server','shared','tsconfig.json','package.json'])await fs.cp(path.join(root,entry),path.join(directory,entry),{recursive:true});
await fs.cp(path.join(root,'client/dist'),path.join(directory,'client/dist'),{recursive:true});
await fs.writeFile(path.join(directory,'smoke.mjs'),`
import {createApp} from './server/app.ts';
const app=await createApp();
const server=app.listen(0,'127.0.0.1',async()=>{
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const health=await fetch(base+'/api/health');
    if(health.status!==200||(await health.json()).status!=='ok')throw new Error('Health check failed');
    if((await fetch(base+'/api/canvas/workspace')).status!==401)throw new Error('Canvas route protection failed');
    const page=await fetch(base+'/');if(page.status!==200||!(await page.text()).includes('<html'))throw new Error('Frontend missing');
    console.log('Production package startup, health, canvas authentication and frontend: PASS');
    server.close(()=>{process.exitCode=0;});
  }catch(e){console.error(e.message);server.close(()=>{process.exitCode=1;});}
});
`);
const child=spawn(process.execPath,['--import','tsx','smoke.mjs'],{
  cwd:directory,stdio:'inherit',windowsHide:true,
  env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,
    NODE_ENV:'production',JWT_SECRET:randomBytes(32).toString('hex'),ADMIN_PASSWORD:randomBytes(20).toString('hex'),
    BACKEND_URL:'https://smoke.example.test',ALLOWED_ORIGINS:'https://smoke.example.test'},
});
const timer=setTimeout(()=>child.kill(),30000);
const code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('exit',code=>resolve(code??1));});
clearTimeout(timer);
console.log('Isolated smoke directory:',directory);
process.exitCode=code;
