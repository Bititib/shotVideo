import { expect, it } from 'vitest';
import { image2proUpstreamPricing, image2proPublicPricing } from '../server/services/image2proUpstreamPricing.js';
it('retains zero and distinct operation prices with units and query time',()=>{
 const p=image2proUpstreamPricing({text_to_image_price:0,image_to_image_price:1.5});
 expect(p).toMatchObject({textToImage:0,imageToImage:1.5,unit:'上游 API 积分 / 张'});expect(Number.isFinite(Date.parse(p.checkedAt))).toBe(true);
});
it.each([undefined,null,'', '1.5',-1,NaN,Infinity])('does not invent a price from %s',value=>{
 expect(image2proUpstreamPricing({text_to_image_price:value,image_to_image_price:value})).toMatchObject({textToImage:null,imageToImage:null});
});
it('never substitutes the text price for missing image price',()=>expect(image2proUpstreamPricing({text_to_image_price:2})).toMatchObject({textToImage:2,imageToImage:null}));

it('uses public per-request and per-video units without inventing token rates',()=>{
 expect(image2proPublicPricing('text',{textPricePerRequest:0,billingUnit:'request'})).toMatchObject({textPerRequest:0,unit:'上游 API 积分 / 次请求'});
 expect(image2proPublicPricing('video',{videoPrice:45,billingUnit:'video'})).toMatchObject({video:45,unit:'上游 API 积分 / 条视频'});
});
it.each(['second','token',undefined])('does not mislabel an unknown unit %s',billingUnit=>expect(image2proPublicPricing('video',{videoPrice:2,billingUnit})).toMatchObject({video:null,unit:'未公布或未识别'}));
