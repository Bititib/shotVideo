// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useVideoQuote } from '../client/src/hooks/useVideoQuote';
import { fetchVideoQuote } from '../client/src/api/video';
import { getBillingUnit } from '../client/src/utils/billing';
vi.mock('../client/src/api/video',()=>({fetchVideoQuote:vi.fn()}));
const quote={model:'video-a',resolution:'720p',seconds:15,cost:1.5,rate:.1,billingType:'per_second' as const};
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();vi.mocked(fetchVideoQuote).mockResolvedValue(quote);});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function tick(){await act(async()=>{await vi.advanceTimersByTimeAsync(250);});}
describe('video customer price estimates',()=>{
  it('uses the server total and clears it immediately when duration changes',async()=>{
    const {result,rerender}=renderHook(({seconds})=>useVideoQuote('video-a','720p',seconds,true),{initialProps:{seconds:15}});
    await tick();expect(result.current.quote?.cost).toBe(1.5);
    rerender({seconds:5});expect(result.current.quote).toBeUndefined();expect(result.current.loading).toBe(true);
    vi.mocked(fetchVideoQuote).mockResolvedValueOnce({...quote,seconds:5,cost:.5});
    await tick();expect(result.current.quote?.cost).toBe(.5);
    expect(fetchVideoQuote).toHaveBeenLastCalledWith('video-a','720p',5,expect.any(AbortSignal));
  });
  it('ignores a late response for the previous model',async()=>{
    let resolveOld:(value:any)=>void;
    vi.mocked(fetchVideoQuote).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
    const {result,rerender}=renderHook(({model})=>useVideoQuote(model,'720p',15,true),{initialProps:{model:'video-a'}});
    await tick();rerender({model:'video-b'});
    vi.mocked(fetchVideoQuote).mockResolvedValueOnce({...quote,model:'video-b',billingType:'per_call',cost:3});
    await tick();expect(result.current.quote?.cost).toBe(3);
    await act(async()=>{resolveOld!(quote);});
    expect(result.current.quote?.model).toBe('video-b');expect(result.current.quote?.cost).toBe(3);
  });
  it('shows a failed estimate and refreshes without reusing the previous total',async()=>{
    vi.mocked(fetchVideoQuote).mockRejectedValueOnce(new Error('售价尚未配置'));
    const {result}=renderHook(()=>useVideoQuote('video-a','720p',15,true));
    await tick();expect(result.current.error).toBe('售价尚未配置');expect(result.current.quote).toBeUndefined();
    act(()=>result.current.refresh());expect(result.current.loading).toBe(true);
    await tick();expect(result.current.error).toBeUndefined();expect(result.current.quote?.cost).toBe(1.5);
  });
  it('does not request quotes while signed out or using another media type',async()=>{
    const {result}=renderHook(()=>useVideoQuote('video-a','720p',15,false));
    await tick();expect(fetchVideoQuote).not.toHaveBeenCalled();expect(result.current.quote).toBeUndefined();
    expect(getBillingUnit('per_call','video')).toBe('/条');expect(getBillingUnit('per_second','video')).toBe('/秒');
  });
});
