import { zhiyingBindings } from './zhiyingModelBindings.js';
import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { imageSpecificationId } from '../../shared/modelRouting.js';
import { GOOGLE_SYNC_MODEL_IDS } from '../../shared/googleSyncModels.js';
import { HAYA_MODEL_IDS, hayaUpstreamModelId } from '../../shared/hayaVideo.js';
import { HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP, getHmStudioUpstreamVideoModel } from '../../shared/hmStudioVideo.js';
import { HUSS_HSS_MODEL, HUSS_BB_A_MODEL, HUSS_HSS_B_MODEL } from '../../shared/hussBbVideo.js';
import { HUSS_MJ_MODEL } from '../../shared/hussMidjourney.js';
import { MJ_MODEL_ID, MJ_UPSTREAM_MODEL } from '../../shared/mj.js';
import { MEGABY_VIDEO_MODELS, megabyPublicModelId } from '../../shared/megabyVideo.js';
import { FUNAI_IMAGE_MODELS, FUNAI_VIDEO_MODELS, FUNAI_MODEL_PREFIX, FUNAI_OMNI_FLASH_11_MODEL,
  FUNAI_OMNI_FLASH_ENTRY, funAiSaleModel, funAiModelLimits } from '../../shared/funAi.js';
import { VX_LE_SEEDANCE_MODEL, LEGACY_VX_LE_SEEDANCE_MODEL, asyncVideoPublicModelId } from '../../shared/asyncVideo.js';
import { ZHIYING_CHANNEL_TYPE, ZHIYING_VIDEO_MODELS } from '../../shared/zhiyingVideo.js';
import { LONGXIA_MODELS } from '../../shared/longxiaVideo.js';
import { isRetiredVideoModel } from '../../shared/retiredVideoModels.js';
import { BB_HSS_KK_ENTRIES } from '../../shared/bbHssKk.js';
import { BB_HSS_SOURCES } from '../../shared/bbHssSources.js';
import { isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';
import { isMegabyChannel } from './megabyVideoAdapter.js';
import { isFunAiChannel } from './funAiAdapter.js';
import { isHussChannel } from './hussVideoAdapter.js';
import { isMjChannel } from './mjAdapter.js';
import { isAsyncVideoChannel } from './asyncVideoAdapter.js';
import { isHayaChannel } from './hayaVideoAdapter.js';
import { isLongxiaChannel } from './longxiaVideoAdapter.js';
import { isMiaowuChannel, MIAOWU_DEFAULT_VIDEO_MODELS } from './miaowuVideoAdapter.js';
import { isMingFeiImageChannel, MINGFEI_IMAGE_MODEL, MINGFEI_UPSTREAM_IMAGE_MODEL } from './mingFeiImageAdapter.js';
import { isDedicatedPidoiImageChannel, isPidoiImageChannel, PIDOI_IMAGE_MODEL } from './pidoiImageAdapter.js';
import { isWxHaidiYueChannel, WX_HAIDIYUE_MODELS } from './wxHaidiYueAdapter.js';
import { isSnumomWanChannel, SNUMOM_VIDEO_MODELS } from './snumomWanAdapter.js';
import { isNewTokenChannel, NEWTOKEN_VIDEO_MODELS } from './newTokenAdapter.js';
import { isMjNewApiChannel } from './mjNewApiAdapter.js';
import { isJulunChannel, JULUN_MINIMAX_H3_MODEL, JULUN_SD25_MODEL, JULUN_SD25_UPSTREAM_MODEL } from './julunMinimaxAdapter.js';
import { isZonghengChannel } from './zonghengAdapter.js';
import { readBbHssSources } from './bbHssSourcePolicy.js';
import { bbHssKkManaged } from './bbHssKkMigration.js';

type ChannelBindings = { id: number; name: string; type: string; baseUrl: string; modelMapping: string };
type Channel = ChannelBindings & { supportedModels: string };
const CONFIG = 'model_specification_routes_v1';
class CatalogConfigurationError extends Error {}
const identity = (ids: readonly string[]) => new Map(ids.map(id => [id, id]));
export const MJ_NEW_API_CATALOG_BINDINGS = {
  'cd-seedance-2.0-720p': 'cd-seedance 2.0 720p',
  'nd-seedance-2.0-480p': 'nd-seedance-2.0 480p',
  'ad-seedance-2.5-480p': 'ad-seedance-2.5-480p',
  'vd-seedance-2.5-480p': 'vd-seedance-2.5-480p',
  'vd-seedance-2.5-720p': 'vd-seedance-2.5-720p',
  'td-seedance-2.5-720p': 'td-seedance-2.5-720p',
  'xd-seedance-2.5-720p': 'xd-seedance-2.5-720p',
};
export const SUDA_SHUI_CATALOG_MODELS = [
  'sdas-my-seedance-2.0-fast-720p', 'ld-sdas-cvk-pro-933-720p', 'sdas-mj-minimax-h3-2k',
  'sdas-bl-sd2.0-933-pro-720p', 'sdas-bl-sd2.0-933-pro-noface-720p',
];

function dedicatedBindings(sqlite: Database.Database, c: ChannelBindings): Map<string, string> | undefined {
  if (c.type === ZHIYING_CHANNEL_TYPE) return new Map([...identity(ZHIYING_VIDEO_MODELS), ...zhiyingBindings(sqlite).filter(row => row.channelId === c.id).map(row => [row.modelId, row.upstreamModel] as [string, string])]);
  if (isDedicatedPidoiImageChannel(c)) return identity([PIDOI_IMAGE_MODEL]);
  if (isPidoiImageChannel(c)) return new Map();
  if (isMingFeiImageChannel(c)) return new Map([[MINGFEI_IMAGE_MODEL, MINGFEI_UPSTREAM_IMAGE_MODEL]]);
  if (isMegabyChannel(c)) return new Map(MEGABY_VIDEO_MODELS.map(id => [megabyPublicModelId(id), id]));
  if (isMjChannel(c)) return new Map([[MJ_MODEL_ID, MJ_UPSTREAM_MODEL]]);
  if (isAsyncVideoChannel(c)) return new Map([
    [asyncVideoPublicModelId(c.id, VX_LE_SEEDANCE_MODEL), VX_LE_SEEDANCE_MODEL],
    [asyncVideoPublicModelId(c.id, LEGACY_VX_LE_SEEDANCE_MODEL), VX_LE_SEEDANCE_MODEL],
  ]);
  if (isFunAiChannel(c)) {
    const bindings = new Map<string, string>();
    for (const upstream of [...FUNAI_VIDEO_MODELS, FUNAI_OMNI_FLASH_11_MODEL]) {
      if (upstream !== FUNAI_OMNI_FLASH_ENTRY) bindings.set(FUNAI_MODEL_PREFIX + funAiSaleModel(upstream), upstream);
    }
    for (const upstream of FUNAI_IMAGE_MODELS) {
      for (const resolution of funAiModelLimits(upstream).resolutions) {
        bindings.set(imageSpecificationId(FUNAI_MODEL_PREFIX + upstream, resolution), upstream);
      }
    }
    return bindings;
  }
  if (isHussChannel(c) || isHayaChannel(c)) {
    const huss = isHussChannel(c);
    const bindings = huss ? identity([HUSS_MJ_MODEL])
      : new Map(HAYA_MODEL_IDS.map(id => [id, hayaUpstreamModelId(id)]));
    const selected = readBbHssSources(sqlite);
    for (const id of BB_HSS_KK_ENTRIES) {
      const choice = selected[id];
      if (choice && (choice.channelId === c.id || (!huss && choice.source === 'MO' && choice.channelId === 0))
        && BB_HSS_SOURCES[choice.source]?.type === (huss ? 'huss' : 'haya')) {
        bindings.set(id, BB_HSS_SOURCES[choice.source].upstreamModel);
      } else if (huss && !bbHssKkManaged(sqlite, id)) {
        const mapping = JSON.parse(c.modelMapping || '{}');
        bindings.set(id, id === HUSS_HSS_MODEL && mapping[id] === HUSS_HSS_B_MODEL ? HUSS_HSS_B_MODEL : HUSS_BB_A_MODEL);
      }
    }
    return bindings;
  }
  if (isWxHaidiYueChannel(c)) return identity(WX_HAIDIYUE_MODELS);
  if (isLongxiaChannel(c)) return identity(LONGXIA_MODELS);
  if (isMiaowuChannel(c)) return identity(MIAOWU_DEFAULT_VIDEO_MODELS);
  if (isSnumomWanChannel(c)) return identity(SNUMOM_VIDEO_MODELS);
  if (isNewTokenChannel(c)) {
    const bindings = identity(NEWTOKEN_VIDEO_MODELS);
    bindings.set('nd-seedance-2.0-480p', 'nd-seedance-2.0 480p');
    bindings.set('nd-seedance-2.0-720p', 'nd-seedance-2.0 720p');
    return bindings;
  }
  if (isMjNewApiChannel(c)) return new Map(Object.entries(MJ_NEW_API_CATALOG_BINDINGS));
  if (isJulunChannel(c)) return new Map([['wan3.0th', 'wan3.0th'], [JULUN_MINIMAX_H3_MODEL, JULUN_MINIMAX_H3_MODEL],
    [JULUN_SD25_MODEL, JULUN_SD25_UPSTREAM_MODEL]]);
  if (c.type === 'hmstudio') return new Map(Object.entries(HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP));
  if (c.type === 'gemini') return identity(GOOGLE_SYNC_MODEL_IDS);
  if (c.type === 'sudashui' || /^https?:\/\/(?:[^/]+\.)?sudashuiapi\.com(?=[:/]|$)/i.test(c.baseUrl)) return identity(SUDA_SHUI_CATALOG_MODELS);
  return undefined;
}

function loadRoutes(sqlite: Database.Database) {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG) as { value: string } | undefined;
  const specs: ModelSpecification[] = JSON.parse(row?.value || '[]');
  if (!Array.isArray(specs) || specs.some(spec => !Array.isArray(spec?.routes))) {
    throw new CatalogConfigurationError('模型规格配置无效，未清理渠道关联');
  }
  return specs;
}

function supportsPair(channel: Channel, bindings: Map<string, string>, id: string, upstream: string) {
  const expected = bindings.get(id);
  if (expected === undefined) return false;
  if (expected === upstream) return true;
  if (channel.type === 'hmstudio') return expected === getHmStudioUpstreamVideoModel(upstream);
  return isAsyncVideoChannel(channel) && expected === VX_LE_SEEDANCE_MODEL && upstream === LEGACY_VX_LE_SEEDANCE_MODEL;
}

export function channelCatalogBindings(sqlite: Database.Database, channel: ChannelBindings) {
  const bindings = dedicatedBindings(sqlite, channel);
  if (!bindings) return undefined;
  const mapping: Record<string, string> = JSON.parse(channel.modelMapping || '{}');
  for (const [id, upstream] of Object.entries(mapping)) {
    if (!id || id === '*' || !upstream || upstream === '*' || isRetiredVideoModel(id) || bindings.has(id)) continue;
    // A separately named custom alias is an explicit mapping, unlike old auto-imported IDs.
    if (isAsyncVideoChannel(channel) && id !== upstream && id !== asyncVideoPublicModelId(channel.id, upstream)) bindings.set(id, upstream);
    if (channel.type === 'hmstudio' && id !== upstream) bindings.set(id, upstream);
    if (channel.type === 'gemini') bindings.set(id, upstream);
  }
  return bindings;
}

export function allowsStandardChannelModelConfiguration(sqlite: Database.Database, channel: ChannelBindings) {
  return ['openai', 'custom'].includes(channel.type)
    && !isSiYueTianVideoHost(channel.baseUrl) && !isZonghengChannel(channel)
    && channelCatalogBindings(sqlite, channel) === undefined;
}

/** Keep the saved products and original task references. Only detach catalog associations and invalid routes. */
export function pruneChannelCatalogBindings(sqlite: Database.Database, channel: Channel): string[] {
  if (isSiYueTianVideoHost(channel.baseUrl) || isZonghengChannel(channel)) return [];
  return sqlite.transaction(() => {
    const supported: string[] = JSON.parse(channel.supportedModels || '[]');
    const mapping: Record<string, string> = JSON.parse(channel.modelMapping || '{}');
    if (!Array.isArray(supported) || supported.some(id => typeof id !== 'string')
      || !mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.values(mapping).some(value => typeof value !== 'string')) {
      throw new CatalogConfigurationError('渠道模型关联格式无效，未清理配置');
    }
    const approved = channelCatalogBindings(sqlite, channel);
    const specs = loadRoutes(sqlite);
    const routes = specs.flatMap(spec => spec.routes.filter(route => route.channelId === channel.id));
    const retainedRoutes = routes.filter(route => !isRetiredVideoModel(route.executionModel)
      && (!approved || supportsPair(channel, approved, route.executionModel, route.upstreamModel)
        || (isFunAiChannel(channel) && approved.has(route.executionModel))));
    const approvedRouteIds = new Set(retainedRoutes.map(route => route.executionModel));
    const keepMapping = (id: string) => !isRetiredVideoModel(id)
      && (approved ? supportsPair(channel, approved, id, mapping[id])
        : id !== '*' && Boolean(mapping[id]?.trim() && mapping[id].trim() !== '*'));
    const keepSupported = (id: string) => !isRetiredVideoModel(id)
      && (approvedRouteIds.has(id) || (approved
        ? approved.has(id) && (!Object.hasOwn(mapping, id) || keepMapping(id))
        : id === '*' || keepMapping(id)));
    const removedSupported = supported.filter(id => !keepSupported(id));
    const removedMapping = Object.fromEntries(Object.entries(mapping).filter(([id]) => !keepMapping(id)));
    const removed = [...new Set([...removedSupported, ...Object.keys(removedMapping)])];
    const rejectedRoutes = new Set(routes.filter(route => !retainedRoutes.includes(route)));
    if (!removed.length && !rejectedRoutes.size) return [];
    const key = 'removed_catalog_bindings_' + channel.id;
    const previous = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    const archive = JSON.parse(previous?.value || '[]');
    archive.push({ supportedModels: removedSupported, modelMapping: removedMapping,
      routes: specs.flatMap(spec => spec.routes.filter(route => rejectedRoutes.has(route)).map(route => ({ modelId: spec.modelId, route }))) });
    if (previous) sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(archive), key);
    else sqlite.prepare("INSERT INTO settings(key,value,label) VALUES(?,?,'历史渠道关联归档')").run(key, JSON.stringify(archive));
    sqlite.prepare("UPDATE channels SET supported_models=?,model_mapping=?,updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(supported.filter(keepSupported)), JSON.stringify(Object.fromEntries(Object.entries(mapping).filter(([id]) => keepMapping(id)))), channel.id);
    if (rejectedRoutes.size) {
      for (const spec of specs) spec.routes = spec.routes.filter(route => !rejectedRoutes.has(route));
      sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), CONFIG);
    }
    return [...new Set([...removed, ...[...rejectedRoutes].map(route => route.executionModel)])];
  })();
}

export function pruneAllChannelCatalogBindings(sqlite: Database.Database) {
  const channels = sqlite.prepare(`SELECT id,name,type,base_url AS baseUrl,
    supported_models AS supportedModels,model_mapping AS modelMapping FROM channels`).all() as Channel[];
  for (const channel of channels) {
    try {
      const removed = pruneChannelCatalogBindings(sqlite, channel);
      if (removed.length) console.info(`[渠道目录] #${channel.id} 已归档并解除 ${removed.length} 个旧型号关联`);
    } catch (error) {
      if (!(error instanceof CatalogConfigurationError) && !(error instanceof SyntaxError)) throw error;
      console.warn(`[渠道目录] #${channel.id} 配置格式无效，跳过清理并保留原配置`);
    }
  }
}
