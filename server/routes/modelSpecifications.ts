import { createVideoAliasChecker, createModelSalePriceResolver } from '../services/modelSaleService.js';
import { suggestedModelSpecifications } from '../services/modelSpecificationPresets.js';
import { Router } from 'express';
import { AdminService } from '../services/adminService.js';
import { db, sqlite } from '../db/index.js';
import { models } from '../db/schema.js';
import { getModelSpecifications, getModelSpecification, saveModelSpecification, deleteModelSpecification, inspectModelRoutes, selectModelRoutes, resetRouteHealth } from '../services/modelRoutingService.js';
import { specificationRequest } from '../services/specificationGenerationService.js';
import { routingMismatches } from '../../shared/modelRouting.js';
const router = Router();
router.get('/suggestions', (_req, res, next) => { try { const modelSalePrice = createModelSalePriceResolver(); res.json(suggestedModelSpecifications().map(spec => ({ ...spec, salePrice: modelSalePrice(spec.modelId, spec.limits.resolutions) }))); } catch (error) { next(error); } });
router.get('/', (_req, res, next) => {
  try {
    const registry = db.select().from(models).all(), checkAlias = createVideoAliasChecker(), modelSalePrice = createModelSalePriceResolver();
    res.json(getModelSpecifications().map(spec => {
      const details = inspectModelRoutes(spec);
      return { ...spec, displayName: registry.find(m => m.modelId === spec.modelId)?.displayName || spec.modelId,
        salePrice: modelSalePrice(spec.modelId, spec.limits.resolutions),
        aliasIssues: spec.aliases.flatMap(modelId => { const reason = checkAlias(spec, modelId); return reason ? [{ modelId, reason }] : []; }),
        channelCount: new Set(spec.routes.map(r => r.channelId)).size,
        availableRouteCount: details.filter(d => !d.reasons.length).length,
        routeStatus: details.map(({ route, reasons, health }) => ({ id: route.id, reasons, health })) };
    }));
  } catch (e) { next(e); }
});
router.put('/:modelId', (req, res, next) => {
  try {
    if (req.params.modelId !== req.body?.modelId) return res.status(400).json({ error: '规格 ID 不一致' });
    const saved = sqlite.transaction(() => {
      if (req.body.displayName !== undefined) {
        const model = db.select().from(models).all().find(m => m.modelId === req.body.modelId);
        if (!model) AdminService.createModel({ modelId: req.body.modelId, displayName: req.body.displayName, provider: 'routing', capabilities: [req.body.kind], isActive: req.body.enabled ? 1 : 0 });
        else if (model.displayName !== req.body.displayName) AdminService.updateModel(model.id, { displayName: req.body.displayName });
      }
      return saveModelSpecification(req.body);
    })();
    res.json(saved);
  } catch (e) { next(e); }
});
router.delete('/:modelId', (req, res, next) => {
  try { deleteModelSpecification(req.params.modelId); res.json({ message: '已解除规格配置，原模型保留' }); }
  catch (e) { next(e); }
});
router.post('/:modelId/simulate', (req, res, next) => {
  try {
    const spec = getModelSpecification(req.params.modelId);
    if (!spec) return res.status(404).json({ error: '规格不存在' });
    const request = specificationRequest({ prompt: '模拟选路', ...req.body }, spec.kind, 'https://simulation.invalid');
    const mismatches = routingMismatches(spec.limits, request.input, spec.kind);
    const items = inspectModelRoutes(spec, request.input).map(({ route, reasons, cost, health }) => ({
      routeId: route.id, channelId: route.channelId, reasons: [...mismatches, ...reasons], estimatedCost: cost, health, priority: route.priority,
    })).sort((a, b) => Number(a.reasons.length > 0) - Number(b.reasons.length > 0)
      || (a.estimatedCost ?? Infinity) - (b.estimatedCost ?? Infinity) || a.priority - b.priority);
    res.json({ selectedRouteId: mismatches.length ? null : selectModelRoutes(spec, request.input)[0]?.route.id || null, items });
  } catch (e) { next(e); }
});
router.post('/:modelId/reset-health', (req, res, next) => {
  try {
    const spec = getModelSpecification(req.params.modelId), key = String(req.body?.key || '');
    if (!spec || !inspectModelRoutes(spec).some(item => item.health.some(h => h.key === key))) return res.status(404).json({ error: '线路不存在' });
    resetRouteHealth(key); res.json({ message: '健康状态已重置；手动禁用开关保持原状' });
  } catch (e) { next(e); }
});
export default router;
