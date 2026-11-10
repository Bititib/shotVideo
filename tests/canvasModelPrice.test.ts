import { expect, it } from 'vitest';
import { canvasModelPrice } from '../client/src/canvas/modelPrice';
import type { CanvasModel } from '../client/src/canvas/useCanvasModels';
const model = (fields: Partial<CanvasModel>): CanvasModel => ({id:'test',name:'Test',description:'',available:true,...fields});
it('shows resolution and explicit video units instead of implying equal task costs', () => {
  expect(canvasModelPrice(model({rates:{'720p':0.2,'1080p':0.4},billingType:'per_second'}),'video')).toBe('720p ¥0.20/秒 · 1080p ¥0.40/秒');
  expect(canvasModelPrice(model({rates:{'720p':2},billingType:'per_call'}),'video')).toBe('720p ¥2.00/条');
  expect(canvasModelPrice(model({rates:{'720p':2}}),'video')).toBe('计费方式待确认');
});
it('does not turn missing prices into zero and preserves free and tiny prices', () => {
  expect(canvasModelPrice(model({}),'image')).toBe('价格待确认');
  expect(canvasModelPrice(model({rate:0}),'image')).toBe('¥0.00/张');
  expect(canvasModelPrice(model({rate:0.0000001}),'audio')).not.toContain('¥0.00/');
  expect(canvasModelPrice(model({rate:NaN}),'audio')).toBe('价格待确认');
});
it('uses task units for fixed-output image models', () => {
  const fixed = model({rate:2,routingLimits:{outputsPerTask:4} as any});
  expect(canvasModelPrice(fixed,'image')).toBe('¥2.00/次');
  expect(canvasModelPrice(model({resolutionPrices:{'1K':0.1,'4K':0.5}}),'image')).toBe('1K ¥0.10/张 · 4K ¥0.50/张');
});
