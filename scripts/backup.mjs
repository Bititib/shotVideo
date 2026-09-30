import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function verifyBackup(directory) {
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
  for(const file of manifest.files) {
    const target=path.resolve(directory,file.path);
    if(!target.startsWith(path.resolve(directory)+path.sep))throw new Error('Invalid backup path');
    const bytes=await fs.readFile(target);
    if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Backup verification failed: ${file.path}`);
  }
  const database=new Database(path.join(directory,'app.db'),{readonly:true,fileMustExist:true});
  try {if(database.pragma('quick_check',{simple:true})!=='ok')throw new Error('Database integrity check failed');} finally {database.close();}
  return manifest;
}

export async function createBackup(dataDirectory, destination) {
  const data=path.resolve(dataDirectory), target=path.resolve(destination);
  if(target===data||target.startsWith(data+path.sep))throw new Error('Backup must be outside the live data directory');
  await fs.mkdir(target,{recursive:false});
  const database=new Database(path.join(data,'app.db'),{readonly:true,fileMustExist:true});
  try {await database.backup(path.join(target,'app.db'));}finally{database.close();}
  for(const directory of ['uploads','private-media']) {
    try {await fs.cp(path.join(data,directory),path.join(target,directory),{recursive:true,errorOnExist:true,force:false,filter:source=>!source.endsWith('.tmp')});}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const files=[];
  const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const filename=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('Backup cannot contain symbolic links');
    if(entry.isDirectory())await walk(filename);
    else {const bytes=await fs.readFile(filename);files.push({path:path.relative(target,filename).split(path.sep).join('/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }};
  await walk(target);
  const manifest={version:1,createdAt:new Date().toISOString(),files};
  await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2));
  await verifyBackup(target);
  return {directory:target,files:files.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const destination=process.argv[3]||path.resolve('backups',new Date().toISOString().replace(/[:.]/g,'-'));
    if(process.argv[2]==='--verify') {console.log(await verifyBackup(process.argv[3]));}
    else {await fs.mkdir(path.dirname(destination),{recursive:true});console.log(await createBackup(process.env.DATA_DIR||'data',destination));}
  } catch(e){console.error(`Backup failed: ${e.message}`);process.exitCode=1;}
}
