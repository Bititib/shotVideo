import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { reconstructionAnalysisCatalog, publicAnalysisCatalog } from '../services/reconstructionAnalysisCatalog.mjs';
export function websiteAnalysisCatalog(filename) {
  function read(action) {
    if(!filename || !existsSync(filename)) return null;
    const db=new Database(filename,{readonly:true,fileMustExist:true});
    try { return action(db); } finally { db.close(); }
  }
  return {
    get:()=>read(publicAnalysisCatalog) || {items:[],selected:null,note:'未连接当前网站数据库'},
    selection:()=>read(db=>{
      const result=reconstructionAnalysisCatalog(db);
      if(result.saved && !result.selected) throw Object.assign(new Error('原拉片选择已失效，请到网站现有后台「渠道管理」重新选择'),{status:409});
      return result.selected;
    }),
    resolve:(channelId,modelId)=>read(db=>reconstructionAnalysisCatalog(db).routes.find(route=>route.channelId===channelId && route.modelId===modelId && route.selectable)),
  };
}
