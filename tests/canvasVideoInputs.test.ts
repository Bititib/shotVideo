// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newNode, parseDocument, newDocument } from '../client/src/canvas/model';
import { readVideoDuration, connectionError, videoInputError, VIDEO_EDIT_MODEL } from '../client/src/canvas/videoInputs';
import { canvasVideoReferenceLimits } from '../shared/canvasVideoReferences';
const options = { kind: 'video' as const, videoMode: 'edit' as const, model: VIDEO_EDIT_MODEL, ratio: '16:9', seconds: 10 };
const video = { ...newNode('video', { x: 0, y: 0 }), src: '/original.mp4' };
afterEach(() => vi.restoreAllMocks());
describe('canvas video editing constraints', () => {
  it('uses model-specific reference image caps and keeps unknown models at ten', () => {
    const image={...newNode('image',{x:0,y:0}),src:'/image.jpg'};
    const ref={...options,videoMode:'reference' as const,model:'sd2.5-933'};
    expect(videoInputError(ref,Array(9).fill(image))).toBe('');
    expect(videoInputError(ref,Array(10).fill(image))).toContain('9 张参考图片');
    expect(videoInputError({...ref,model:'test-video'},Array(11).fill(image))).toContain('10 张参考图片');
    const multi={...ref,videoMode:'multimodal' as const};
    const audio={...newNode('audio',{x:0,y:0}),src:'/audio.mp3'};
    const refs=[...Array(9).fill(image),...Array(3).fill(video),...Array(3).fill(audio)];
    expect(videoInputError(multi,refs)).toBe('');
    for(const extra of [image,video,audio]) expect(videoInputError(multi,[...refs,extra])).toContain('最多支持 9 张图片、3 个视频、3 段音频');
  });


  it('uses Seedance 2.0 limits of 9 images and 3 audios without enabling video references',()=>{
    const image={...newNode('image',{x:0,y:0}),src:'/image.jpg'};
    const audio={...newNode('audio',{x:0,y:0}),src:'/voice.mp3'};
    const multi={...options,model:'ZH-XXsedanco2.0',seconds:15,videoMode:'multimodal' as const};
    const refs=[...Array(9).fill(image),...Array(3).fill(audio)];
    expect(videoInputError(multi,refs)).toBe('');
    for(const extra of [image,video,audio])expect(videoInputError(multi,[...refs,extra])).toContain('最多支持 9 张图片、0 个视频、3 段音频');
  });


  // V6K cutover deliberately removed the old MM and TTsedanco spellings.
  it.each(['ZH-TTseadanco2.5-480YT','ZH-TTseadanco2.5-480','ZH-TTseadanco2.5-720'])('accepts full ZH reference sets for %s in canvas and rejects each excess', model => {
    const image={...newNode('image',{x:0,y:0}),src:'/photo.jpg'};
    const audio={...newNode('audio',{x:0,y:0}),src:'/voice.mp3'};
    const multi={...options,model,videoMode:'multimodal' as const};
    const refs=[...Array(30).fill(image),...Array(10).fill(video),...Array(10).fill(audio)];
    expect(videoInputError(multi,refs)).toBe('');
    for(const extra of [image,video,audio]) expect(videoInputError(multi,[...refs,extra])).toContain('最多支持 30 张图片、10 个视频、10 段音频');
    expect(videoInputError({...multi,videoMode:'reference'},Array(30).fill(image))).toBe('');
    expect(videoInputError({...multi,videoMode:'reference'},Array(31).fill(image))).toContain('最多支持');
    expect(videoInputError(multi,[video,audio])).toBe('');
  });

  it.each(['ZH-MMseadanco2.5-PRO','ZH-TTsedanco2.5-480','ZH-sedanco2.0-300秒必出'])('does not silently infer V6K multimodal capability for retired %s',model=>{
    expect(canvasVideoReferenceLimits(model)).toBeUndefined();
    expect(videoInputError({...options,model,videoMode:'multimodal'},[video])).toBe('请选择支持视频 / 音频参考的模型。');
  });

  it('allows Fast C2 video and audio references with its own channel limits', () => {
    const audio = { ...newNode('audio', { x: 0, y: 0 }), src: '/voice.mp3' };
    const multi = { ...options, videoMode: 'multimodal' as const, model: 'seedance-2.0-fast-c2' };
    expect(videoInputError(multi, [video, audio])).toBe('');
    expect(videoInputError(multi, [video, video])).toContain('1 个视频');
    expect(videoInputError(multi, Array(4).fill(audio))).toContain('3 段音频');
    expect(videoInputError({ ...multi, model: 'seedance-2.0-c2' }, [video])).toContain('0 个视频');
  });
  it('accepts multimodal references only for supported models and respects audio formats and limits', () => {
    const audio = { ...newNode('audio', { x: 0, y: 0 }), src: 'data:audio/mpeg;base64,eA==' };
    const multi = { ...options, videoMode: 'multimodal' as const, model: 'ad-seedance-2.5-480p' };
    expect(videoInputError(multi, [video, audio])).toBe('');
    expect(videoInputError({ ...multi, model: 'seedance_v2.5' }, [video, audio])).toContain('请选择支持');
    expect(videoInputError({ ...multi, model: 'wan3.0th' }, [audio])).toContain('WAV');
    expect(videoInputError({ ...multi, model: 'wan3.0th' }, [{ ...audio, src: 'data:audio/wav;base64,eA==' }])).toBe('');
    expect(videoInputError({ ...multi, model: 'vd-seedance-2.5-480p' }, [audio])).toContain('0 段音频');
    expect(videoInputError(multi, Array(11).fill(video))).toContain('最多支持');
  });
  it('requires one video and rejects unsupported audio, ratio and duration', () => {
    expect(videoInputError(options, [video])).toBe('');
    expect(videoInputError(options, [])).toContain('一个原视频');
    expect(videoInputError(options, [video, video])).toContain('一个原视频');
    expect(videoInputError(options, [video, { ...newNode('audio', { x: 0, y: 0 }), src: '/sound.wav' }])).toContain('不支持音频');
    expect(videoInputError({ ...options, ratio: '1:1' }, [video])).toContain('画幅');
    expect(videoInputError({ ...options, seconds: 5 }, [video])).toContain('10 秒');
    expect(videoInputError({ ...options, videoMode: 'reference', model: 'test-video' }, [video])).toContain('切换视频编辑');
  });
  it('persists edit mode through project import and reload', () => {
    const doc = parseDocument({ ...newDocument(), drafts: { editor: { ...options, prompt: '修改背景', resolution: '720p' } } });
    expect(doc.drafts?.editor.videoMode).toBe('edit');
  });
  it('reads metadata through the playback proxy and rejects videos over 15 seconds', async () => {
    const element = document.createElement('video');
    vi.spyOn(document, 'createElement').mockReturnValue(element);
    vi.spyOn(element, 'load').mockImplementation(() => {});
    Object.defineProperty(element, 'duration', { value: 16, configurable: true });
    const pending = readVideoDuration('/original.mp4', new AbortController().signal);
    expect(element.getAttribute('src')).toBe('/api/video/play?url=%2Foriginal.mp4');
    element.dispatchEvent(new Event('loadedmetadata'));
    await expect(pending).rejects.toThrow('超过 15 秒');
    expect(element.getAttribute('src')).toBeNull();
  });
  it('accepts playable short videos and cleans up when cancelled', async () => {
    const element = document.createElement('video');
    vi.spyOn(document, 'createElement').mockReturnValue(element);
    vi.spyOn(element, 'load').mockImplementation(() => {});
    Object.defineProperty(element, 'duration', { value: 10 });
    const pending = readVideoDuration('/short.mp4', new AbortController().signal);
    element.dispatchEvent(new Event('loadedmetadata')); await expect(pending).resolves.toBe(10);
    const controller = new AbortController(); const cancelled = readVideoDuration('/short.mp4', controller.signal);
    controller.abort(); await expect(cancelled).rejects.toThrow('已取消');
  });
});


describe('connection compatibility', () => {
  it('rejects incompatible media before adding an edge, but allows unfinished compatible nodes', () => {
    const image=newNode('image',{x:0,y:0}), audio=newNode('audio',{x:0,y:0}), text=newNode('text',{x:0,y:0});
    expect(connectionError(video,image)).toContain('不支持');
    expect(connectionError(image,audio)).toContain('只支持文字');
    expect(connectionError(text,audio)).toBe('');
    expect(connectionError(image,video)).toBe('');
    expect(connectionError(image,{...video,job:{status:'running',message:'生成中'}})).toContain('正在生成');
  });
});
