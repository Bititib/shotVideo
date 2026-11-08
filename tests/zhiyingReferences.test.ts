import { expect, it } from 'vitest';
import { normalizeZhiyingReferencePrompt } from '../shared/zhiyingReferences';
import { validateZhiyingVideoInput } from '../shared/zhiyingVideo';
it('uses native Chinese per-kind names, with one-based numbers and zero-based legacy images', () => {
  const source='参考图片1 参考图片10 @视频2 ＠音频1 [ref_0.jpg] [ref_9.png] @2；人物台词保持原样';
  const expected='图片1 图片10 视频2 音频1 图片1 图片10 图片2；人物台词保持原样';
  expect(normalizeZhiyingReferencePrompt(source)).toBe(expected);
  expect(normalizeZhiyingReferencePrompt(expected)).toBe(expected);
});
it.each(['图片0','视频2','@音频2','[ref_1.jpg]','@2','参考音频10'])('rejects missing native and legacy references: %s', prompt => {
  expect(validateZhiyingVideoInput('sd-2.5-fullblood',prompt,{images:1,videos:1,audios:1,outputs:1,seconds:5,resolution:'720p',ratio:'16:9',firstFrame:false,lastFrame:false}).join()).toContain('没有对应素材');
});
