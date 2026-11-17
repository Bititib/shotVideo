import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
const {inspectMusic}=createRequire(import.meta.url)('../server/scripts/checkMusicAudio.cjs');

it('checks both local songs without changing the database, identifies empty and missing audio',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'music-readonly-')),root=path.join(dir,'private-music','results');
  const dbPath=path.join(dir,'app.db'),job=randomUUID(),ids=[randomUUID(),randomUUID()];
  try {
    await fs.mkdir(root,{recursive:true});
    const db=new Database(dbPath);
    db.exec('CREATE TABLE music_jobs(id TEXT,content_id INTEGER,state TEXT); CREATE TABLE music_results(id TEXT,job_id TEXT,upstream_id TEXT,status TEXT,saved INTEGER)');
    db.prepare('INSERT INTO music_jobs VALUES(?,16045,?)').run(job,'completed');
    for(const id of ids)db.prepare('INSERT INTO music_results VALUES(?,?,?,?,1)').run(id,job,'upstream-'+id,'completed');
    db.close();
    const fixture=await fs.readFile(new URL('./fixtures/music-valid.mp3',import.meta.url));
    for(const id of ids)await fs.writeFile(path.join(root,job+'-'+id+'.mp3'),fixture);
    const before=await fs.readFile(dbPath),report=inspectMusic(16045,dir);
    expect(report.ok).toBe(true);expect(report.reports).toHaveLength(2);
    expect(report.reports.every((r:any)=>r.bytes===fixture.length&&r.duration_seconds>0&&r.decoded_seconds>0)).toBe(true);
    await fs.writeFile(path.join(root,job+'-'+ids[1]+'.mp3'),'');
    const empty=inspectMusic(16045,dir);expect(empty.ok).toBe(false);expect(empty.reports[1]).toMatchObject({bytes:0,decode:'异常'});
    await fs.rm(path.join(root,job+'-'+ids[1]+'.mp3'));
    expect(inspectMusic(16045,dir).reports[1].error).toContain('ENOENT');
    expect(await fs.readFile(dbPath)).toEqual(before);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
