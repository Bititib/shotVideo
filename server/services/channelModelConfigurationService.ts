import { enrichImage2proCatalog } from './image2proPublicCapabilities.js';
import { image2proModels } from './image2proAdapter.js';
import { image2proLimits, image2proMediaSupported, image2proImageOptions, validImage2proRatio, validImage2proResolution } from './image2proCapabilities.js';
import { buildImage2proVideoPayload, buildImage2proImagePayload } from './image2proPayload.js';
import { wanfengVideoCatalog, wanfengVideoLimits } from '../../shared/wanfengVideo.js';
import { allowsDuration } from '../../shared/modelRouting.js';
import { buildWanfengVideoPayload } from './wanfengVideoAdapter.js';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { channelVideoProtocols, CHANNEL_MODEL_ROUTE_PREFIX, STANDARD_CHANNEL_IMAGE_RATIOS, STANDARD_CHANNEL_VIDEO_RATIOS,
  type ChannelModelCatalogEntry, type ChannelModelConfigurations, type ChannelModelDraft, type ChannelModelRequestPreview,
  type ChannelVideoProtocol } from '../../shared/channelModelConfiguration.js';
import { LEGACY_VX_LE_SEEDANCE_MODEL, VX_LE_SEEDANCE_MODEL } from '../../shared/asyncVideo.js';
import { megabyVideoLimits, MEGABY_VIDEO_MODELS } from '../../shared/megabyVideo.js';
import { routingMismatches, type ModelRoute } from '../../shared/modelRouting.js';
import type { V6kRequestSample } from '../../shared/v6kModelConfiguration.js';
import { isRetiredVideoModel, RETIRED_VIDEO_MODEL_MESSAGE } from '../../shared/retiredVideoModels.js';
import { isSupportedChannelType } from '../../shared/channelTypes.js';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { allowsChannelModelConfigurationRoute, allowsStandardChannelModelConfiguration, channelCatalogBindings, getChannelVideoProtocol } from './channelCatalogBindings.js';
import { fetchAsyncVideoModels, buildAsyncVideoPayload } from './asyncVideoAdapter.js';
import { buildMjNewApiVideoPayload } from './mjNewApiAdapter.js';
import { buildNewTokenVideoPayload, NEWTOKEN_SEEDANCE_PROTOCOL_MODEL } from './newTokenAdapter.js';
import { buildMegabyVideoPayload, fetchMegabyAuthorizedModels } from './megabyVideoAdapter.js';
import { imageSize, standardVideoFormFields } from './specificationAdapters.js';
import { getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { rememberPublicModelNames, resolvePublicModelId, validatePublicModelName } from './publicModelNameService.js';
import { diagnosticJson, responseDiagnostic, transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

type Channel = typeof channels.$inferSelect;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/;

function getChannel(id: number) {
  const channel = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!channel) throw fail('渠道不存在', 404);
  return channel;
}

function readConfiguration(channel: Channel) {
  const specs = getModelSpecifications();
  const savedModels = new Map(db.select().from(models).all().map(model => [model.modelId, model]));
  const supported = JSON.parse(channel.supportedModels || '[]') as string[];
  const mapping = JSON.parse(channel.modelMapping || '{}') as Record<string, string>;
  const linkedSpecs = specs.filter(spec => spec.routes.some(route => route.channelId === channel.id));
  const ids = new Set([...supported, ...Object.keys(mapping), ...linkedSpecs.map(spec => spec.modelId)]);
  const protocol = getChannelVideoProtocol(channel);
  const canAdd = Boolean(channel.type === 'image2pro' || protocol || allowsStandardChannelModelConfiguration(sqlite, channel));
  const rows = [...ids].filter(id => id !== '*' && !isRetiredVideoModel(id)).map(modelId => {
    const model = savedModels.get(modelId);
    const spec = linkedSpecs.find(row => row.modelId === modelId);
    const routes = spec?.routes.filter(route => route.channelId === channel.id) ?? [];
    const capabilities: string[] = JSON.parse(model?.capabilities || '[]');
    const kind = capabilities.includes('video') ? 'video' : capabilities.some(capability => ['image', 'image_gen'].includes(capability)) ? 'image' : null;
    const editable = Boolean(channel.type === 'image2pro' && model?.provider === 'image2pro' && capabilities.includes('text') && !spec && mapping[modelId] === modelId) || Boolean(canAdd && model && spec?.routes.length === 1 && (routes[0]?.id.startsWith(CHANNEL_MODEL_ROUTE_PREFIX) || channel.type === 'image2pro' && routes[0]?.id.startsWith('image2pro-' + channel.id + '-'))
      && routes[0].executionModel === modelId && allowsChannelModelConfigurationRoute(sqlite, channel, routes[0].id));
    return {
      modelId, displayName: model?.displayName || modelId,
      upstreamModel: [...new Set(routes.map(route => route.upstreamModel))].join('、')
        || (Object.hasOwn(mapping, modelId) ? mapping[modelId] : modelId),
      capabilities, enabled: model?.isActive === 1 && spec?.enabled !== false && (!routes.length || routes.some(route => route.enabled)),
      limits: spec?.limits ?? (kind ? existingModelLimits(modelId, kind) : null), editable,
      specificationEnabled: spec?.enabled, routeEnabled: routes.length === 1 ? routes[0].enabled : undefined,
    };
  });
  const version = createHash('sha256').update(JSON.stringify([
    channel.id, channel.updatedAt, channel.baseUrl, channel.type, supported, mapping, rows, linkedSpecs,
  ])).digest('hex');
  const canSync = isSupportedChannelType(channel.type);
  const result: ChannelModelConfigurations = { models: rows, version, canAdd, canSync };
  if (protocol) result.protocol = protocol;
  if (channel.type === 'image2pro') result.image2pro = true;
  if (!canAdd) result.addUnavailableReason = canSync
    ? '此渠道尚未开放后台新增型号。可同步和查看已接入的型号。'
    : '当前版本未接入此渠道类型的生成协议。可以查看已有配置。';
  return { result, specs, savedModels, supported, mapping };
}

export function listChannelModelConfigurations(channelId: number) {
  return readConfiguration(getChannel(channelId)).result;
}

async function fetchCatalog(channel: Channel): Promise<ChannelModelCatalogEntry[]> {
  if (!channel.apiKey.trim()) throw fail('请先在渠道配置中保存 API Key', 409);
  const protocol = getChannelVideoProtocol(channel);
  if (channel.type === 'image2pro') return (await image2proModels(channel))
    .filter(m => m.metadata.type === 'text' || image2proMediaSupported(m))
    .map(m => ({ id: m.id, kind: m.metadata.type, ...(m.metadata.type === 'text' ? {} : { limits: image2proLimits(m), ...(m.metadata.type === 'image' ? {imageOptions:image2proImageOptions(m)} : {}) }) }));
  if (protocol === 'wanfeng') return wanfengVideoCatalog();
  if (protocol === 'async-video' || protocol === 'megaby') {
    try {
      if (protocol === 'megaby') return (await fetchMegabyAuthorizedModels(channel))
        .filter(id => !(MEGABY_VIDEO_MODELS as readonly string[]).includes(id))
        .map(id => ({ id, limits: megabyVideoLimits() }));
      const entries = await fetchAsyncVideoModels(channel);
      return entries.filter(({ name }) => ![VX_LE_SEEDANCE_MODEL, LEGACY_VX_LE_SEEDANCE_MODEL].includes(name))
        .map(({ name, limits }) => ({ id: name, limits }));
    } catch (error) {
      throw fail(error instanceof TypeError ? transportDiagnostic(channelVideoProtocols[protocol].label, '读取模型授权目录', error, channel.apiKey)
        : (error as Error).message, 502);
    }
  }
  const url = channel.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') + '/v1/models';
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch (error) { throw fail(transportDiagnostic(channel.type, '读取模型授权目录', error, channel.apiKey), 502); }
  if (!response.ok) throw fail(await responseDiagnostic(channel.type, '读取模型授权目录', response, channel.apiKey), 502);
  const payload = await diagnosticJson(channel.type, '读取模型授权目录', response, channel.apiKey);
  if (payload?.error) throw fail(upstreamDiagnostic(channel.type, '读取模型授权目录', payload, channel.apiKey, response.status), 502);
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(entries)) throw fail('上游未返回可识别的授权模型目录', 502);
  const compatible = protocol ? entries.filter((row: any) => !['chat', 'text', 'image', 'embedding', 'tts', 'audio', 'speech'].includes(
    String(row?.type || row?.category || '').toLowerCase())) : entries;
  return [...new Set<string>(compatible.map((row: any) => typeof row === 'string' ? row : row?.id ?? row?.model ?? row?.model_id)
    .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())
      && (protocol !== 'newtoken' || /seedance/i.test(id))))].sort().map(id => ({ id }));
}

export async function listAuthorizedChannelModels(channelId: number) {
  const channel = getChannel(channelId);
  if (channel.type !== 'image2pro' && !getChannelVideoProtocol(channel) && !allowsStandardChannelModelConfiguration(sqlite, channel)) throw fail('请使用该渠道的专用同步或配置入口', 409);
  const catalog = await fetchCatalog(channel);
  return channel.type === 'image2pro' ? enrichImage2proCatalog(catalog) : catalog;
}

function validateDraft(draft: ChannelModelDraft, protocol?: ChannelVideoProtocol, image2pro = false) {
  if (!draft || typeof draft.modelId !== 'string' || !modelIdPattern.test(draft.modelId)
    || typeof draft.displayName !== 'string' || !draft.displayName.trim() || draft.displayName.length > 120
    || typeof draft.upstreamModel !== 'string' || !draft.upstreamModel.trim()
    || draft.upstreamModel !== draft.upstreamModel.trim() || draft.upstreamModel.length > 160 || draft.upstreamModel === '*'
    || /[\x00-\x1f\x7f]/.test(draft.upstreamModel)
    || !(image2pro ? ['image', 'video', 'text'] : ['image', 'video']).includes(draft.kind)
    || [draft.specificationEnabled, draft.routeEnabled].some(value => value !== undefined && typeof value !== 'boolean')) {
    throw fail('请填写有效的本站模型 ID、名称和上游型号');
  }
  if (isRetiredVideoModel(draft.modelId) || isRetiredVideoModel(draft.upstreamModel)) throw fail(RETIRED_VIDEO_MODEL_MESSAGE, 409);
  if (image2pro && draft.modelId !== draft.upstreamModel) throw fail('Image2Pro 本站模型 ID 必须与上游公开 ID 一致，不添加渠道前缀');
  if (image2pro && draft.kind === 'text') return;
  validateLimits(draft.limits);
  if (image2pro) {
    if (draft.limits.maxOutputs !== 1 || draft.limits.qualities.length || draft.limits.outputsPerTask && draft.limits.outputsPerTask !== 1) throw fail('Image2Pro 当前入口每次输出一份，不支持质量档位');

    return;
  }
  const limits = draft.limits;
  if (protocol && draft.kind !== 'video') throw fail('此协议只支持视频模型');
  if ((protocol !== 'wanfeng' && (limits.firstFrame || limits.lastFrame)) || ((!protocol || !channelVideoProtocols[protocol].multimedia) && (limits.maxVideos || limits.maxAudios))) {
    throw fail('此协议不支持所设置的音视频参考或独立首尾帧');
  }
  if (draft.kind === 'video') {
    const { min, max, step, values } = limits.duration;
    if (limits.maxOutputs !== 1 || limits.qualities.length || ![min, max, step, ...values].every(Number.isSafeInteger)) {
      throw fail('视频规格需要使用整数秒，每次输出一条');
    }
  }
  if (limits.maxReferences !== undefined && limits.maxReferences < limits.minImages) throw fail('素材合计上限不能小于最少参考图数');
  if (protocol === 'async-video' && (limits.resolutions.length !== 1 || limits.resolutions[0] !== 'default')) {
    throw fail('Vx-乐的输出分辨率由上游决定');
  }
  if (protocol === 'newtoken' && (limits.maxImages > 9 || limits.maxVideos > 3 || limits.maxAudios > 3)) {
    throw fail('NewToken Seedance 最多支持 9 图、3 视频、3 音频');
  }
  if (protocol === 'wanfeng') {
    const supported = wanfengVideoLimits(draft.upstreamModel);
    if (!supported) throw fail('请从晚风公开视频目录选择上游型号');
    const { duration } = limits;
    const seconds = duration.mode === 'options' ? duration.values : duration.mode === 'fixed' ? [duration.min]
      : Array.from({ length: Math.floor((duration.max - duration.min) / duration.step) + 1 }, (_, i) => duration.min + i * duration.step);
    if (!seconds.length || !seconds.every(value => allowsDuration(supported.duration, value))
      || limits.maxImages > supported.maxImages || limits.maxVideos > supported.maxVideos || limits.maxAudios > supported.maxAudios
      || limits.resolutions.some(value => !supported.resolutions.includes(value)) || limits.ratios.some(value => !supported.ratios.includes(value))) {
      throw fail('配置超出该晚风模型支持的时长、画幅、分辨率或素材数量');
    }
    return;
  }
  if (protocol && protocol !== 'newtoken') {
    if (!limits.ratios.every(ratio => /^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(ratio))) throw fail('请填写有效画幅');
    if (protocol === 'megaby') {
      const supported = megabyVideoLimits();
      if (limits.maxImages > supported.maxImages || limits.maxVideos > supported.maxVideos || limits.maxAudios > supported.maxAudios
        || limits.resolutions.some(resolution => !supported.resolutions.includes(resolution)) || limits.ratios.some(ratio => !supported.ratios.includes(ratio))
        || limits.duration.min < 4 || limits.duration.max > 15 || limits.duration.values.some(seconds => seconds < 4 || seconds > 15)) {
        throw fail('Megaby 支持 4–15 秒、720p/480p、16:9/9:16/1:1，最多 9 图、3 视频、3 音频');
      }
    }
    return;
  }
  const ratios: readonly string[] = protocol === 'newtoken' ? ['16:9', '9:16']
    : draft.kind === 'image' ? STANDARD_CHANNEL_IMAGE_RATIOS : STANDARD_CHANNEL_VIDEO_RATIOS;
  if (draft.limits.ratios.some(ratio => !ratios.includes(ratio))) throw fail('通用接口支持的比例为 ' + ratios.join('、'));
  if (draft.kind === 'image' && (draft.limits.resolutions.length !== 1 || draft.limits.resolutions[0] !== '1K')) {
    throw fail('通用图片接口仅支持 1K。其他分辨率需使用对应渠道的专用配置。');
  }
}

export function previewChannelModelRequest(channelId: number, draft: ChannelModelDraft, sample: V6kRequestSample = {}): ChannelModelRequestPreview {
  const channel = getChannel(channelId), protocol = getChannelVideoProtocol(channel);
  if (!protocol && !allowsStandardChannelModelConfiguration(sqlite, channel)) throw fail('此渠道尚未开放后台新增型号', 409);
  validateDraft(draft, protocol, channel.type === 'image2pro');
  if (draft.kind === 'text') throw fail('文本预览请使用授权目录预览入口');
  const { limits } = draft, rule = limits.duration;
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw fail('预览参数无效');
  const seconds = sample.seconds ?? limits.defaultSeconds ?? (rule.mode === 'options' ? rule.values[0] : rule.min);
  const ratio = sample.ratio ?? limits.ratios[0], resolution = sample.resolution ?? limits.resolutions[0];
  const images = sample.images ?? limits.minImages, videos = sample.videos ?? 0, audios = sample.audios ?? 0;
  if (![images, videos, audios].every(count => Number.isSafeInteger(count) && count >= 0) || !Number.isSafeInteger(seconds)
    || typeof ratio !== 'string' || typeof resolution !== 'string') throw fail('预览参数无效');
  const mismatches = routingMismatches(limits, { seconds, ratio, resolution, images, videos, audios, outputs: 1, firstFrame: false, lastFrame: false }, draft.kind);
  if (mismatches.length) throw fail(mismatches.join('；'));
  const urls = (count: number, extension: string) => Array.from({ length: count }, (_, index) => `https://example.invalid/${extension}-${index + 1}.${extension}`);
  const model = draft.upstreamModel, prompt = '请求体预览示例';
  const media = { images: urls(images, 'jpg'), videos: urls(videos, 'mp4'), audios: urls(audios, 'wav') };
  const preview = (path: string, body: Record<string, unknown>) => ({ method: 'POST', path, body });
  if (protocol === 'async-video') return preview('/v1/videos/generations', buildAsyncVideoPayload({ model, prompt, seconds, ratio, ...media, firstFrame: '', lastFrame: '' }));
  if (protocol === 'mjnewapi') return preview('/v1/videos', buildMjNewApiVideoPayload({ model, prompt, duration: seconds, aspectRatio: ratio, resolution, ...media }));
  if (protocol === 'newtoken') return preview('/v1/videos', buildNewTokenVideoPayload({ model: NEWTOKEN_SEEDANCE_PROTOCOL_MODEL, upstreamModel: model, prompt, duration: seconds, aspectRatio: ratio, ...media }));
  if (protocol === 'megaby') return preview('/v1/videos', buildMegabyVideoPayload({ model, prompt, seconds, ratio, resolution, ...media, firstFrame: '', lastFrame: '' }, true));
  if (protocol === 'wanfeng') return preview('/v1/videos', buildWanfengVideoPayload({ model, prompt, seconds, ratio, resolution, ...media, firstFrame: '', lastFrame: '' }));
  if (draft.kind === 'image') return preview(images ? '/v1/images/edits' : '/v1/images/generations', { model, prompt, n: 1, size: imageSize(ratio), response_format: 'url', ...(images ? { 'image[]': media.images } : {}) });
  return preview('/v1/videos', { ...standardVideoFormFields(model, prompt, { seconds, ratio, resolution }), ...(images ? { 'input_reference[]': media.images } : {}) });
}

export async function saveChannelModelConfiguration(channelId: number, draft: ChannelModelDraft, version: string) {
  const channel = getChannel(channelId);
  const protocol = getChannelVideoProtocol(channel);
  validateDraft(draft, protocol, channel.type === 'image2pro');
  const original = readConfiguration(channel);
  const assertVersion = (current: typeof original) => {
    if (!current.result.canAdd) throw fail(current.result.addUnavailableReason!, 409);
    if (current.result.version !== version) throw fail('渠道模型配置已变化，请重新打开后保存', 409);
    const existing = current.result.models.find(row => row.modelId === draft.modelId);
    if (existing && (!existing.editable || !existing.capabilities.includes(draft.kind))) throw fail('此模型使用已有接入配置，不能通过通用入口更换协议或能力', 409);
    if (protocol && current.result.models.some(row => row.modelId !== draft.modelId && row.upstreamModel === draft.upstreamModel)) {
      throw fail('此上游型号已关联本站模型，请编辑已有配置', 409);
    }
    if (!existing && protocol) {
      const bindings = channelCatalogBindings(sqlite, channel);
      if (bindings?.has(draft.modelId) || (bindings && [...bindings.values()].includes(draft.upstreamModel))) {
        throw fail('该型号属于渠道内置配置，请通过已接入型号管理', 409);
      }
    }
    const occupied = current.savedModels.get(draft.modelId);
    if (!existing && (occupied || current.specs.some(spec => spec.modelId === draft.modelId
      || spec.aliases.includes(draft.modelId) || spec.routes.some(route => route.executionModel === draft.modelId))
      || resolvePublicModelId(draft.modelId) !== draft.modelId
      || db.select().from(channels).all().some(other => other.id !== channelId
        && (JSON.parse(other.supportedModels || '[]').includes(draft.modelId)
          || Object.hasOwn(JSON.parse(other.modelMapping || '{}'), draft.modelId))))) {
      throw fail('本站模型 ID 已被其他模型或渠道占用', 409);
    }
    validatePublicModelName(draft.modelId, draft.displayName.trim(), occupied?.id);
    return occupied;
  };
  assertVersion(original);
  const catalogEntry = (await fetchCatalog(channel)).find(entry => entry.id === draft.upstreamModel);
  if (!catalogEntry) throw fail('该上游型号未出现在此 Key 的授权目录中，或不支持在此添加', 409);
  if (channel.type === 'image2pro') validateImage2proCatalogDraft(draft, catalogEntry);
  if (protocol === 'async-video') {
    const { duration, ratios } = catalogEntry.limits!;
    const rule = draft.limits.duration;
    const allowed = duration.values.length ? duration.values : [duration.min];
    const configured = rule.mode === 'options' ? rule.values : rule.mode === 'fixed' ? [rule.min]
      : Array.from({ length: Math.floor((rule.max - rule.min) / rule.step) + 1 }, (_, index) => rule.min + index * rule.step);
    if (configured.some(seconds => !allowed.includes(seconds))
      || draft.limits.ratios.some(ratio => !ratios.includes(ratio))) throw fail('Vx-乐的时长和画幅须在授权目录给出的范围内');
  }

  return sqlite.transaction(() => {
    const live = getChannel(channelId);
    if (live.apiKey !== channel.apiKey) throw fail('核对授权期间渠道 Key 已修改，请重新打开后保存', 409);
    const current = readConfiguration(live);
    const model = assertVersion(current);
    if (!model) db.insert(models).values({
      provider: live.type, modelId: draft.modelId, displayName: draft.displayName.trim(),
      capabilities: JSON.stringify([draft.kind]), isActive: 0,
    }).run();
    else if (model.displayName !== draft.displayName.trim()) {
      rememberPublicModelNames(model);
      db.update(models).set({ displayName: draft.displayName.trim() }).where(eq(models.id, model.id)).run();
    }
    if (draft.kind !== 'text') {
    const spec = current.specs.find(row => row.modelId === draft.modelId);
    const originalRoute = spec?.routes[0];
    const cost = originalRoute?.upstreamModel === draft.upstreamModel ? originalRoute : undefined;
    const { limits } = draft;
    const route: ModelRoute = {
      id: originalRoute?.id ?? (live.type === 'image2pro' ? 'admin-channel-model-image2pro-' : protocol ? channelVideoProtocols[protocol].prefix : CHANNEL_MODEL_ROUTE_PREFIX) + randomUUID(), channelId, executionModel: draft.modelId,
      upstreamModel: draft.upstreamModel, enabled: draft.routeEnabled ?? originalRoute?.enabled ?? true, limits,
      cost: cost?.cost ?? null, costUnit: cost?.costUnit ?? 'unknown',
      resolutionCosts: cost?.resolutionCosts ?? {}, priority: originalRoute?.priority ?? live.priority,
    };
    saveModelSpecification({
      modelId: draft.modelId, kind: draft.kind, enabled: draft.specificationEnabled ?? spec?.enabled ?? true,
      aliases: spec?.aliases ?? [], limits, routes: [route],
    });
    }
    db.update(channels).set({
      supportedModels: JSON.stringify([...new Set([...current.supported, draft.modelId])]),
      modelMapping: JSON.stringify({ ...current.mapping, [draft.modelId]: draft.upstreamModel }),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channelId)).run();
    return readConfiguration(getChannel(channelId)).result;
  }).immediate();
}

function validateImage2proCatalogDraft(draft: ChannelModelDraft, entry: ChannelModelCatalogEntry) {
  if (entry.kind !== draft.kind) throw fail('Image2Pro 型号类型与授权目录不一致');
  if (draft.kind === 'text') return;
  const supported = entry.limits!;
  const l = draft.limits;
  const rule = l.duration;
  const seconds = rule.mode === 'options' ? rule.values : rule.mode === 'fixed' ? [rule.min]
    : Array.from({ length: Math.floor((rule.max-rule.min)/rule.step)+1 }, (_,i)=>rule.min+i*rule.step);
  if (l.maxImages > (entry.imageOptions?.maxImages ?? supported.maxImages) || l.minImages < supported.minImages
    || l.maxVideos > supported.maxVideos || l.maxAudios > supported.maxAudios
    || l.firstFrame && !supported.firstFrame || l.lastFrame && !supported.lastFrame
    || l.resolutions.some(v => entry.imageOptions?.customResolutions ? !validImage2proResolution(v) : !supported.resolutions.includes(v)) || l.ratios.some(v => entry.imageOptions?.customRatios ? !validImage2proRatio(v) : !supported.ratios.includes(v))
    || draft.kind === 'video' && (!seconds.length || seconds.some(v => !Number.isSafeInteger(v) || !allowsDuration(supported.duration,v)))) {
    throw fail('Image2Pro 配置超出授权目录公布的时长、分辨率、画幅或素材能力');
  }
}

/** The Image2Pro preview reads current capabilities but never sends a generation request. */
export async function previewAuthorizedChannelModelRequest(channelId: number, draft: ChannelModelDraft, sample: V6kRequestSample = {}): Promise<ChannelModelRequestPreview> {
  const channel = getChannel(channelId);
  if (channel.type !== 'image2pro') return previewChannelModelRequest(channelId, draft, sample);
  validateDraft(draft, undefined, true);
  const model = (await image2proModels(channel)).find(m => m.id === draft.upstreamModel);
  if (!model) throw fail('该上游型号未出现在此 Key 的授权目录中',409);
  const kind = model.metadata.type;
  validateImage2proCatalogDraft(draft, {id:model.id, kind, ...(kind === 'text' ? {} : {limits:image2proLimits(model), ...(kind === 'image'?{imageOptions:image2proImageOptions(model)}:{})})});
  const prompt = '请求体预览示例';
  if (draft.kind === 'text') return {method:'POST',path:'/v1/chat/completions',body:{model:model.id,messages:[{role:'user',content:prompt}]}};
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw fail('预览参数无效');
  const l=draft.limits;
  const input={seconds:sample.seconds ?? l.defaultSeconds ?? (l.duration.mode==='options'?l.duration.values[0]:l.duration.min),ratio:sample.ratio??l.ratios[0],resolution:sample.resolution??l.resolutions[0],images:sample.images??l.minImages,videos:sample.videos??0,audios:sample.audios??0,outputs:1,firstFrame:sample.firstFrame??false,lastFrame:sample.lastFrame??false};
  if (!Number.isSafeInteger(input.seconds) || typeof input.ratio !== 'string' || typeof input.resolution !== 'string') throw fail('预览参数无效');
  if (![input.images,input.videos,input.audios].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=100)) throw fail('预览素材数量无效');
  if(typeof input.firstFrame!=='boolean'||typeof input.lastFrame!=='boolean')throw fail('首尾帧预览参数无效');
  const mismatches=routingMismatches(l,input,draft.kind); if(mismatches.length)throw fail(mismatches.join('；'));
  const urls=(count:number,ext:string)=>Array.from({length:count},(_,i)=>'https://example.invalid/'+ext+'-'+(i+1)+'.'+ext);
  const images=urls(input.images,'jpg');
  if(draft.kind==='image')return {method:'POST',path:'/v1/images/tasks',body:buildImage2proImagePayload(model.id,{prompt,input,images})};
  const built=buildImage2proVideoPayload(model,{prompt,input,images,videos:urls(input.videos,'mp4'),audios:urls(input.audios,'wav'),firstFrame:input.firstFrame?'https://example.invalid/first.jpg':'',lastFrame:input.lastFrame?'https://example.invalid/last.jpg':''});
  return {method:'POST',path:'/v1/videos',body:built.payload,...(built.standard?{headers:{'X-Xiaojuzi-Media-Contract':'1'}}:{})};
}
