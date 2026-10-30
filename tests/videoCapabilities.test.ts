import { describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/modelRoutingService.js', () => ({ getModelSpecification: () => null }));
import { videoCapabilities, normalizeVideoParameters, type ParameterSchema } from '../server/services/videoCapabilities.js';
import { buildSnumomWanPayload } from '../server/services/snumomWanAdapter.js';

describe('typed video capabilities contract', () => {
  it('publishes only documented per-channel extras, with labels outside JSON Schema for older clients', () => {
    expect(videoCapabilities('MiniMax-H3').parameterSchema.properties.function_mode.enum).toEqual(['first_last_frames','omni_reference']);
    expect(videoCapabilities('seedance_v2.0-933').parameterSchema.properties.function_mode.enum).toEqual(['multi_frame','omni_reference']);
    expect(videoCapabilities('funai-veo-3.1-lite').parameterSchema.properties.audio.type).toBe('boolean');
    expect(videoCapabilities('funai-gemini-omni-flash').parameterEnumLabels.reference_mode).toEqual(['首帧','风格参考','元素参考']);
    expect(videoCapabilities('funai-gemini-omni-flash').parameterSchema.properties.reference_mode).not.toHaveProperty('enumLabels');
    for(const id of ['grok-imagine-video-1.5','hss-2.5-301010']) {
      expect(videoCapabilities(id).parameterSchema.properties).toEqual({}); expect(videoCapabilities(id).parameterNote).toBeTruthy();
    }
    // Same public spelling on a different, unknown execution protocol is not evidence.
    expect(videoCapabilities('veo-3.1').parameterSchema.properties).toEqual({});
  });
  it('exposes verified declarations and never invents controls for unknown models', () => {
    expect(videoCapabilities('wan3.0-video-nsfw').parameterSchema.properties.prompt_extend.type).toBe('boolean');
    expect(videoCapabilities('unseen-model')).toMatchObject({ capabilityVersion: 1, routingLimits: undefined, parameterSchema: { properties: {} } });
    expect(videoCapabilities('TTTseadanco2.5/720').parameterSchema.properties).toEqual({});
    expect(videoCapabilities('MiniMax-H3').routingLimits).toMatchObject({ maxImages: 9, maxVideos: 3, maxAudios: 3 });
  });
  it('preserves false through JSON and multipart into the actual Wan payload', () => {
    const schema = videoCapabilities('wan3.0-video-nsfw').parameterSchema;
    for (const [body, multipart] of [[{ model_parameters: { prompt_extend: false } }, false], [{ model_parameters: '{"prompt_extend":false}' }, true], [{ prompt_extend: 'false' }, true]] as const) {
      const request: any = { ...body }; normalizeVideoParameters(request, schema, multipart);
      expect(request.prompt_extend).toBe(false);
      const payload = buildSnumomWanPayload({ model: 'wan3.0-video-nsfw', prompt: 'test', seconds: 5, aspectRatio: '16:9', resolution: '720p', promptExtend: request.prompt_extend });
      expect(payload.parameters).toMatchObject({ prompt_extend: false });
    }
  });
  it('enforces future numeric, enum and text rules with one validator', () => {
    const schema: ParameterSchema = { type: 'object', additionalProperties: false, required: ['seed'], properties: {
      seed: { type: 'integer', title: 'seed', minimum: 0, maximum: 10, multipleOf: 2 },
      style: { type: 'string', title: 'style', enum: ['a','b'] }, note: { type: 'string', title: 'note', maxLength: 4 },
    } };
    const body: any = { model_parameters: { seed: 0, style: 'a' } }; normalizeVideoParameters(body, schema); expect(body.seed).toBe(0);
    for (const values of [{}, {seed: -1}, {seed: 1}, {seed: true}, {seed: 0, style: 'c'}, {seed: 0, note: '12345'}, {seed:0, model:'other'}]) expect(() => normalizeVideoParameters({ model_parameters:values }, schema)).toThrow();
  });
  it('omits extras when any enabled route cannot consume them', () => {
    const spec: any = { kind: 'video', routes: [{ enabled: true, executionModel: 'wan3.0-video-nsfw' }, { enabled: true, executionModel: 'other' }] };
    expect(videoCapabilities('mixed', spec).parameterSchema.properties).toEqual({});
    spec.routes[1].enabled=false;
    expect(videoCapabilities('mixed', spec).parameterSchema.properties.prompt_extend.type).toBe('boolean');
  });
});
