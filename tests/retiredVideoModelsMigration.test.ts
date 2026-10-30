import Database from 'better-sqlite3';
import { expect,it } from 'vitest';
import { retireRemovedVideoModels } from '../server/services/retiredVideoModelsMigration';
import { RETIRED_VIDEO_MODELS } from '../shared/retiredVideoModels';

it('removes obsolete live bindings idempotently without changing historical tasks, prices, funds or other models',()=>{
  const db=new Database(':memory:');
  try {
    db.exec(`CREATE TABLE models(model_id TEXT PRIMARY KEY,is_active INTEGER);
      CREATE TABLE channels(id INTEGER PRIMARY KEY,supported_models TEXT,model_mapping TEXT);
      CREATE TABLE model_pricing(model_pattern TEXT,input_price REAL);
      CREATE TABLE contents(id INTEGER PRIMARY KEY,model_id TEXT,status TEXT,cost REAL,metadata TEXT);
      CREATE TABLE users(id INTEGER PRIMARY KEY,balance REAL);
      CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,balance REAL,used_amount REAL);
      CREATE TABLE fund_ledger(id INTEGER PRIMARY KEY,amount REAL);`);
    for(const id of [...RETIRED_VIDEO_MODELS,'wan3.0-video-nsfw','sd-mini'])db.prepare('INSERT INTO models VALUES(?,1)').run(id);
    for(const id of RETIRED_VIDEO_MODELS){
      db.prepare('INSERT INTO model_pricing VALUES(?,0.47)').run(id);
      db.prepare("INSERT INTO contents(model_id,status,cost,metadata) VALUES(?,'processing',3.9,?)").run(id,JSON.stringify({videoId:'task_original',channelId:1}));
    }
    db.prepare('INSERT INTO channels VALUES(1,?,?)').run(JSON.stringify([...RETIRED_VIDEO_MODELS,'alias','*','sd-mini']),JSON.stringify({[RETIRED_VIDEO_MODELS[0]]:RETIRED_VIDEO_MODELS[0],alias:RETIRED_VIDEO_MODELS[1],'sd-mini':'operator-upstream'}));
    db.exec('INSERT INTO users VALUES(1,42.3);INSERT INTO api_tokens VALUES(1,-1,123.4);INSERT INTO fund_ledger VALUES(1,-3.9)');
    const snapshot=()=>JSON.stringify(['model_pricing','contents','users','api_tokens','fund_ledger'].map(t=>db.prepare('SELECT * FROM '+t).all()));
    const before=snapshot();retireRemovedVideoModels(db);const after=JSON.stringify(db.prepare('SELECT * FROM channels').all());
    retireRemovedVideoModels(db);expect(snapshot()).toBe(before);expect(JSON.stringify(db.prepare('SELECT * FROM channels').all())).toBe(after);
    for(const id of RETIRED_VIDEO_MODELS)expect(db.prepare('SELECT is_active FROM models WHERE model_id=?').get(id)).toEqual({is_active:0});
    expect(db.prepare("SELECT is_active FROM models WHERE model_id='wan3.0-video-nsfw'").get()).toEqual({is_active:1});
    const channel=db.prepare('SELECT * FROM channels').get() as any;
    expect(JSON.parse(channel.supported_models)).toEqual(['*','sd-mini']);expect(JSON.parse(channel.model_mapping)).toEqual({'sd-mini':'operator-upstream'});
  } finally {db.close();}
});
