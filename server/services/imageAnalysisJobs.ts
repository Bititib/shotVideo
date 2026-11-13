import { sqlite } from '../db/index.js';
import { AIService } from './aiService.js';
import { ContentService } from './contentService.js';
import { ImageAnalysisJobStore } from './imageAnalysisJobStore.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';
import type { ImageAnalysisResult } from '../../shared/imageAnalysis.js';

export const imageAnalysisJobs = new ImageAnalysisJobStore(sqlite);
let running = false;
let started = false;
export async function runImageAnalysisJobs() {
  if (running) return;
  running = true;
  try {
    let item: any;
    while ((item = imageAnalysisJobs.claim())) {
      let result: ImageAnalysisResult;
      let modelName: string | undefined;
      try {
        const model: any = sqlite.prepare('SELECT id,model_id AS modelId,api_key AS apiKey,is_active FROM models WHERE id=?').get(item.model_id);
        if (!model?.is_active) throw new Error('所选分析模型已停用或不存在，未提交分析');
        modelName = model.modelId;
        const user: any = sqlite.prepare('SELECT is_active FROM users WHERE id=?').get(item.owner);
        if (!user?.is_active) throw new Error('账号已停用，未提交分析');
        result = await AIService.analyzeImage({ path: item.file_path, mimetype: item.mime, originalname: `image-${item.position + 1}.jpg` } as Express.Multer.File, !!item.requires_text, model);
        if (!result || typeof result.overallConcept !== 'string' || typeof result.reversePrompt !== 'string' || !result.reversePrompt.trim()
          || typeof result.reversePromptTranslation !== 'string' || !Array.isArray(result.keywords) || !Array.isArray(result.styleTags)) {
          throw new Error('图片分析响应缺少有效解析或提示词，未自动重复提交');
        }
      } catch (error: any) {
        const reason = sanitizedGenerationReason(error?.message || '图片分析未返回具体错误原因');
        if (error?.imageOutcome === 'unknown') imageAnalysisJobs.uncertain(item, `${reason}；分析提交结果待核实，未自动重发。`);
        else imageAnalysisJobs.finish(item, null, reason);
        continue;
      }
      // Keep successful results even when content-library persistence fails; never regenerate.
      try {
        imageAnalysisJobs.finish(item, result, null, () => {
          ContentService.save({ userId: item.owner, orgId: item.org_id, type: 'analysis', title: `图片逆向 · 第 ${item.position + 1} 张`,
            modelId: modelName, resultText: JSON.stringify(result), metadata: { imageAnalysisJobId: item.job_id, imageIndex: item.position }, cost: 0 });
        });
      } catch {
        imageAnalysisJobs.finish(item, result, '分析结果已保留，内容库保存未完成。');
      }
    }
  } finally { running = false; }
}
export function wakeImageAnalysisJobs() { void runImageAnalysisJobs().catch(error => console.error('[image-analysis-worker]', sanitizedGenerationReason(error?.message))); }
export function startImageAnalysisWorker() {
  if (started) return;
  started = true;
  imageAnalysisJobs.recover();
  wakeImageAnalysisJobs();
  setInterval(wakeImageAnalysisJobs, 5000).unref();
}
