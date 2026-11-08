import { describe, expect, it } from 'vitest';
import { parseMediaReferences, prepareMediaSubmission, renderMediaReferences } from '../shared/mediaReferences';

describe('shared media submission references', () => {
  it('normalizes mixed historical spellings without changing roles or dialogue', () => {
    const prompt = '参考图片1 是张三，张三使用 ＠音频1。@图片2 是小红，参考 @video1 的动作。@Image3 是李四，使用 @audio2。三人说：欢迎。';
    expect(renderMediaReferences(prompt)).toBe('@Image1 是张三，张三使用 @Audio1。@Image2 是小红，参考 @Video1 的动作。@Image3 是李四，使用 @Audio2。三人说：欢迎。');
  });
  it('keeps 1 and 10 separate and normalization is idempotent', () => {
    const result = renderMediaReferences('@图10 @图1 [ref_0.jpg] [ref_video_2] [ref_audio]');
    expect(result).toBe('@Image10 @Image1 @Image1 @Video2 @Audio1');
    expect(renderMediaReferences(result)).toBe(result);
  });
  it('does not interpret English names, emails or longer identifiers as media tokens', () => {
    const text = '@ImageSomething @Audio @VideoPlayer user@Image1.com @Image1abc @Audio2_suffix';
    expect(parseMediaReferences(text)).toEqual([]);
    expect(renderMediaReferences(text)).toBe(text);
  });
  it.each(['@Image0', '@Audio3', '@Video1', '@Image9007199254740992'])('rejects missing reference %s without dropping assets', token => {
    expect(() => prepareMediaSubmission(token, { images:['i'], videos:[], audios:['a','b'] })).toThrow('没有对应素材');
  });
  it('preserves media order, duplicates and inputs while copying arrays', () => {
    const assets = { images:['i2','i1','i1'], videos:['v2','v1'], audios:['a2','a1'] };
    const result = prepareMediaSubmission('参考图片3使用@音频2，参考@视频1', assets);
    expect(result.prompt).toBe('@Image3使用@Audio2，参考@Video1');
    expect(result.images).toEqual(assets.images);
    expect(result.videos).toEqual(assets.videos);
    expect(result.audios).toEqual(assets.audios);
    expect(result.images).not.toBe(assets.images);
    expect(result.audios).not.toBe(assets.audios);
    expect(assets.audios).toEqual(['a2','a1']);
  });
  it('leaves legacy placeholders for channel-specific numbering and supports separate frames', () => {
    expect(prepareMediaSubmission('[ref_1] @Image2', {images:[],videos:[],audios:[]}, 2).prompt).toBe('[ref_1] @Image2');
    expect(renderMediaReferences('[ref_1]', { index: ref => Number(ref.rawIndex) || 1 })).toBe('@Image1');
    expect(renderMediaReferences('[ref_1]')).toBe('@Image2');
  });
});
