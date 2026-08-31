import { and, desc, eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { apiTokens, contents } from '../db/schema.js';
import { BalanceService } from '../services/balanceService.js';
import { ChannelService } from '../services/channelService.js';
import { hmStudioTaskUrl, normalizeHmStudioTask } from '../services/hmStudioAdapter.js';
import {
  buildHmTimeoutRecoveredMetadata,
  getHmTimeoutRecoveryCharge,
  isHmTimedOutFailure,
  parseHmTimeoutRecoveryMetadata,
} from '../services/hmTimeoutRecoveryService.js';
import { TokenService } from '../services/tokenService.js';
import { downloadAndLocalizeVideo } from '../services/videoLocalizationService.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const idsArg = args.find(arg => arg.startsWith('--content-ids='));
const limit = Math.max(1, Number.parseInt(limitArg?.split('=')[1] || '100', 10) || 100);
const requestedIds = new Set(
  (idsArg?.split('=')[1] || '').split(',').map(value => Number.parseInt(value, 10)).filter(Number.isFinite),
);

type ChargeTarget = 'user_balance' | 'api_token' | 'not_charged';

function print(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function chargeRecoveredTask(record: any, metadata: Record<string, any>, amount: number): ChargeTarget {
  if (amount <= 0) return 'not_charged';
  const tokenId = Number(metadata.tokenId) || 0;
  const chargeToken = metadata.refundTarget === 'api_token' || metadata.billingSource === 'token';

  if (chargeToken) {
    if (!tokenId) throw new Error('原退款来源是 API Token，但记录缺少 tokenId');
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
    if (!token) throw new Error(`API Token ${tokenId} 不存在`);
    if (token.balance !== -1 && token.balance < amount) throw new Error(`API Token ${tokenId} 余额不足`);
    TokenService.deductBalance(tokenId, amount);
    return 'api_token';
  }

  const remaining = BalanceService.deduct(record.userId, amount, 'generate_video_recovery', {
    contentId: record.id,
    upstreamTaskId: metadata.videoId,
  });
  if (remaining === null) throw new Error(`用户 ${record.userId} 或所属组织余额不足`);
  // Linked unlimited tokens also had usedAmount reversed during the original refund.
  if (tokenId) TokenService.deductBalance(tokenId, amount);
  return 'user_balance';
}

async function run(): Promise<void> {
  const records = db.select().from(contents)
    .where(and(eq(contents.type, 'video'), eq(contents.modelId, 'seedance_v2.5'), eq(contents.status, 'failed')))
    .orderBy(desc(contents.id))
    .all()
    .filter(isHmTimedOutFailure)
    .filter(record => requestedIds.size === 0 || requestedIds.has(record.id))
    .slice(0, limit);

  print({ mode: apply ? 'apply' : 'dry-run', candidates: records.length, limit });
  let recoverable = 0;
  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    const metadata = parseHmTimeoutRecoveryMetadata(record.metadata);
    const taskId = String(metadata.videoId || '');
    const channel = metadata.channelId
      ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
      : null;
    const apiKey = process.env.HM_STUDIO_API_KEY || channel?.apiKey || '';
    const baseUrl = process.env.HM_STUDIO_BASE_URL || channel?.baseUrl || '';
    const chargeAmount = getHmTimeoutRecoveryCharge(metadata);

    if (!apiKey || !baseUrl) {
      failed++;
      print({ contentId: record.id, taskId, outcome: 'error', error: 'HM Studio API Key 或 Base URL 缺失' });
      continue;
    }
    if (chargeAmount <= 0) {
      skipped++;
      print({ contentId: record.id, taskId, outcome: 'skipped', reason: '原退款金额缺失或为0' });
      continue;
    }

    try {
      const response = await fetch(hmStudioTaskUrl(baseUrl, taskId), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      let raw: any = {};
      try { raw = JSON.parse(body); } catch { raw = { error: body }; }
      if (!response.ok) {
        skipped++;
        print({ contentId: record.id, taskId, outcome: 'skipped', httpStatus: response.status, error: raw.error || body });
        continue;
      }
      const normalized = normalizeHmStudioTask(raw, baseUrl);
      if (normalized.status !== 'success' || !normalized.resultUrl) {
        skipped++;
        print({ contentId: record.id, taskId, outcome: 'skipped', upstreamStatus: normalized.status, error: normalized.error || null });
        continue;
      }

      recoverable++;
      if (!apply) {
        print({ contentId: record.id, taskId, outcome: 'recoverable', chargeAmount, resultUrl: normalized.resultUrl });
        continue;
      }

      try {
        const localUrl = await downloadAndLocalizeVideo(
          normalized.resultUrl,
          taskId,
          record.modelId || 'seedance_v2.5',
          Number(metadata.channelId) || null,
          Number(metadata.channelApiKeyId) || null,
        );
        const recoveredAt = new Date().toISOString();

        const chargeTarget = sqlite.transaction(() => {
          const current = db.select().from(contents).where(eq(contents.id, record.id)).get();
          if (!current || current.status !== 'failed') throw new Error('记录已被其他恢复进程处理');
          const currentMetadata = parseHmTimeoutRecoveryMetadata(current.metadata);
          if (currentMetadata.recoveryChargedAt) throw new Error('该任务已经恢复并扣费');

          const target = chargeRecoveredTask(current, currentMetadata, chargeAmount);
          const completedMetadata = buildHmTimeoutRecoveredMetadata(currentMetadata, {
            localUrl,
            upstreamUrl: normalized.resultUrl,
            chargeAmount,
            chargeTarget: target,
            recoveredAt,
          });
          const update = db.update(contents).set({
            status: 'completed',
            resultUrl: localUrl,
            cost: chargeAmount,
            metadata: JSON.stringify(completedMetadata),
          }).where(and(eq(contents.id, record.id), eq(contents.status, 'failed'))).run();
          if (update.changes !== 1) throw new Error('恢复完成状态写入失败');
          return target;
        })();

        recovered++;
        print({ contentId: record.id, taskId, outcome: 'recovered', localUrl, chargeAmount, chargeTarget });
      } catch (error: any) {
        failed++;
        print({ contentId: record.id, taskId, outcome: 'error', error: error.message || String(error) });
      }
    } catch (error: any) {
      failed++;
      print({ contentId: record.id, taskId, outcome: 'error', error: error.message || String(error) });
    }
  }

  print({ summary: true, candidates: records.length, recoverable, recovered, skipped, failed });
}

run().catch(error => {
  print({ fatal: true, error: error.message || String(error) });
  process.exitCode = 1;
});
