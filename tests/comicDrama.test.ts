import { afterEach, describe, expect, it } from 'vitest';
import { sqlite } from '../server/db/index.js';
import { ComicDramaProjectService } from '../server/services/comicDramaProjectService.js';
import {
  buildScriptBlocks,
  seriesPlanningPrompt,
  storyboardDirectorPrompt,
  storyboardDirectorSchema,
  videoQualityPrompt,
  visualBiblePrompt,
} from '../server/prompts/comicDrama.js';

describe('漫剧下一阶段制作约束', () => {
  it('整部剧本会转换成稳定编号的原文段落', () => {
    const script = Array.from({ length: 18 }, (_, index) => `第${index + 1}行剧情`).join('\n');
    const blocks = buildScriptBlocks(script);
    expect(blocks.length).toBe(3);
    expect(blocks[0].id).toBe(1);
    expect(blocks.map(block => block.text).join('\n')).toContain('第18行剧情');
    const prompt = seriesPlanningPrompt(script, { targetDuration: 90, requestedEpisodes: 3 });
    expect(prompt).toContain('[B0001]');
    expect(prompt).toContain('用户希望约 3 集');
    expect(prompt).toContain('不得改写、删减或重新输出原文');
  });

  it('后续剧集会带入全剧共享资产上下文', () => {
    const prompt = visualBiblePrompt('第二集剧本', {
      visualStyle: '国漫厚涂',
      sharedAssets: [{ kind: '角色', name: '林晚', aliases: ['晚晚'], locked: true }],
    });
    expect(prompt).toContain('全剧视觉上下文');
    expect(prompt).toContain('林晚');
    expect(prompt).toContain('晚晚');
    expect(prompt).toContain('不得为同一对象另起一套设定');
  });

  it('分镜导演必须输出首尾连续性状态', () => {
    const prompt = storyboardDirectorPrompt('打斗剧本', {});
    const shotRequired = (storyboardDirectorSchema.properties.scenes.items.properties.shots.items as any).required;
    expect(prompt).toContain('continuityStart');
    expect(prompt).toContain('起势、攻击、闪避/格挡、命中反馈、收势');
    expect(shotRequired).toContain('continuityStart');
    expect(shotRequired).toContain('continuityEnd');
  });

  it('视频质检覆盖变脸、闪烁和动作完整性', () => {
    const prompt = videoQualityPrompt({
      name: '镜头1', expectedPrompt: '角色向前挥剑', visualStyle: '国漫',
      continuityStart: '右手持剑', continuityEnd: '剑停在左侧',
    });
    expect(prompt).toContain('变脸闪烁');
    expect(prompt).toContain('动作可读');
    expect(prompt).toContain('右手持剑');
  });
});

describe('漫剧批量分析与全剧进度', () => {
  const userId = 900000000 + Math.floor(Math.random() * 1000000);
  const projectIds: number[] = [];

  afterEach(() => {
    for (const projectId of projectIds.splice(0)) {
      sqlite.prepare('DELETE FROM comic_drama_tasks WHERE project_id = ?').run(projectId);
      sqlite.prepare('DELETE FROM comic_drama_episodes WHERE project_id = ?').run(projectId);
      sqlite.prepare('DELETE FROM comic_drama_projects WHERE id = ?').run(projectId);
    }
  });

  it('持久化每集分析状态并按制作阶段汇总', () => {
    const created: any = ComicDramaProjectService.createSeries({
      userId, title: '批量测试剧', originalScript: '整部剧本',
      plan: { visualStyle: '国漫厚涂', episodes: [
        { title: '第一集', script: '第一集剧情内容足够长，用于测试批量分析状态。' },
        { title: '第二集', script: '第二集剧情内容足够长，用于测试批量分析状态。' },
      ] },
    });
    projectIds.push(created.id);
    const episodeIds = created.episodes.map((episode: any) => episode.id);
    expect(ComicDramaProjectService.queueEpisodeAnalysis(created.id, userId)).toEqual(episodeIds);
    ComicDramaProjectService.setEpisodeAnalysisStatus(created.id, episodeIds[0], userId, 'analysis_failed', '模拟失败');
    ComicDramaProjectService.saveEpisodeAnalysis(created.id, episodeIds[1], userId, '第二集剧情内容足够长，用于测试批量分析状态。', {
      title: '第二集', logline: '测试', genre: '动作', visualStyle: '国漫厚涂', estimatedDuration: 10,
      characters: [{ name: '主角', role: '主角', description: '人物', assetPrompt: '黑衣少年' }], props: [],
      scenes: [{ sceneNumber: 1, title: '屋顶', location: '屋顶', time: '夜', summary: '交锋', assetPrompt: '城市屋顶', shots: [{ shotNumber: 1, duration: 5, shotSize: '中景', camera: '固定', action: '拔剑', dialogue: '', characters: ['主角'], imagePrompt: '拔剑', videoPrompt: '拔剑动作', continuityStart: '站立', continuityEnd: '持剑' }] }],
    });
    ComicDramaProjectService.finishBatchAnalysis(created.id, userId);
    const project: any = ComicDramaProjectService.get(created.id, userId);
    expect(project.status).toBe('analysis_failed');
    expect(project.overview.episodes).toMatchObject({ total: 2, analyzed: 1, failed: 1 });
    expect(project.episodes[0].analysisError).toBe('模拟失败');
    expect(project.overview.asset.total).toBe(2);
    expect(project.overview.storyboard.total).toBe(1);
    expect(project.overview.video.total).toBe(1);
  });
});
