import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { previewReviewedVideoRefunds, applyReviewedVideoRefunds } from '../services/reviewedVideoRefundPlan.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const planPath = path.resolve(args.find(a=>a.startsWith('--plan='))?.slice(7) || 'data/review-refund-plan.json');
const adminId = Number(args.find(a=>a.startsWith('--admin-id='))?.slice(11));

try {
  if (!apply) {
    const database = new Database(path.resolve('data/app.db'),{readonly:true,fileMustExist:true});
    try {
      const plan = previewReviewedVideoRefunds(database);
      fs.writeFileSync(planPath,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
      console.table(plan.items.map(i=>({订单:i.id,预扣金额:i.amount,处理:i.blockedReason || '待确认上游未接单'})));
      console.table(database.prepare("SELECT id AS 管理员ID,username AS 管理员 FROM users WHERE role='super_admin' AND is_active=1").all());
      const eligible = plan.items.filter(i=>!i.blockedReason);
      console.log(JSON.stringify({mode:'preview',plan:planPath,reviewCount:plan.items.length,candidateCount:eligible.length,
        candidateAmount:Number(eligible.reduce((n,i)=>n+i.amount,0).toFixed(6)),message:'仅生成清单，未修改订单或余额；清单不证明上游未接单'}));
    } finally { database.close(); }
  } else {
    if (!args.includes('--confirm-not-accepted')) throw new Error('请先核对候选订单上游未接单，再使用 --confirm-not-accepted');
    const plan = JSON.parse(fs.readFileSync(planPath,'utf8'));
    const { sqlite } = await import('../db/index.js');
    try {
      const { confirmReviewedVideoFailureAndRefund } = await import('../services/zonghengSubmissionResolutionService.js');
      const backupPath = `${planPath}.backup-${Date.now()}.db`;
      await sqlite.backup(backupPath);
      console.log(JSON.stringify({backup:backupPath,message:'数据库已备份，开始逐笔核对处理'}));
      const report = applyReviewedVideoRefunds(sqlite,plan,adminId,true,confirmReviewedVideoFailureAndRefund);
      console.table(report.results);
      const reportPath = `${planPath}.result-${Date.now()}.json`;
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
      console.log(JSON.stringify({...report,results:undefined,report:reportPath}));
      if (report.errorCount) process.exitCode = 2;
    } finally { sqlite.close(); }
  }
} catch (error:any) { console.error(error.message); process.exitCode = 1; }
