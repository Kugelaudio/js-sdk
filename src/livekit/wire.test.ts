import { describe, it, expect } from 'vitest';
import {
  appendSdkQuery,
  buildClosePayload,
  buildMultiWsUrl,
  buildTextPayload,
  wordTimestampsToTimed,
  type WireOptions,
} from './wire';

const opts: WireOptions = {
  model: 'kugel-3',
  voiceId: 1071,
  sampleRate: 24000,
  cfgScale: 2.0,
  maxNewTokens: 2048,
  wordTimestamps: false,
  normalize: true,
};

describe('buildMultiWsUrl', () => {
  it('rewrites https to wss and targets /ws/tts/multi with the api key', () => {
    const url = buildMultiWsUrl('https://api.kugelaudio.com', 'secret');
    expect(url).toContain('wss://api.kugelaudio.com/ws/tts/multi');
    expect(url).toContain('api_key=secret');
  });

});

describe('appendSdkQuery', () => {
  it('uses ? for the first param and & thereafter', () => {
    expect(appendSdkQuery('https://x/y')).toContain('?sdk=js');
    expect(appendSdkQuery('https://x/y?a=b')).toContain('&sdk=js');
  });
});

describe('buildTextPayload', () => {
  it('sends a bare text frame when config is not requested', () => {
    const msg = buildTextPayload('ctx1', 'hello', opts);
    expect(msg).toEqual({ text: 'hello', context_id: 'ctx1' });
  });

  it('marks flush when requested', () => {
    expect(buildTextPayload('ctx1', 'hi', opts, { flush: true })).toMatchObject({ flush: true });
  });

  it('attaches session + voice config on the first frame', () => {
    const msg = buildTextPayload('ctx1', 'hi', opts, { includeConfig: true });
    expect(msg).toMatchObject({
      model_id: 'kugel-3',
      sample_rate: 24000,
      word_timestamps: false,
      normalize: true,
      voice_settings: { voice_id: 1071 },
    });
  });

  it('omits default generation params from voice_settings', () => {
    const msg = buildTextPayload('ctx1', 'hi', opts, { includeConfig: true });
    expect(msg.voice_settings).toEqual({ voice_id: 1071 });
  });

  it('includes non-default cfg_scale and max_new_tokens', () => {
    const msg = buildTextPayload('ctx1', 'hi', { ...opts, cfgScale: 1.5, maxNewTokens: 4096 }, {
      includeConfig: true,
    });
    expect(msg.voice_settings).toMatchObject({ cfg_scale: 1.5, max_new_tokens: 4096 });
  });

  it('omits voice_settings entirely when the voice is the server default', () => {
    const msg = buildTextPayload('ctx1', 'hi', { ...opts, voiceId: null }, { includeConfig: true });
    expect(msg).not.toHaveProperty('voice_settings');
  });

  it('includes language only when set', () => {
    expect(buildTextPayload('c', 'x', opts, { includeConfig: true })).not.toHaveProperty('language');
    const withLang = buildTextPayload('c', 'x', { ...opts, language: 'de' }, { includeConfig: true });
    expect(withLang).toMatchObject({ language: 'de' });
  });

  // `/ws/tts/multi` parses `speed` off the TOP LEVEL of the frame
  // (`StreamUpdate` in `services/ingress/src/ingress/routes/ws_multi.py`). A
  // `speed` nested inside `voice_settings` is dropped with only a server-side
  // log warning — silently producing unmodified-rate audio.
  it('emits speed as a top-level key of the config frame, never inside voice_settings', () => {
    const msg = buildTextPayload('c', 'x', { ...opts, speed: 1.1 }, { includeConfig: true });
    expect(msg.speed).toBe(1.1);
    expect(msg.voice_settings).not.toHaveProperty('speed');
  });

  // Same StreamUpdate rule as speed: top-level or silently dropped.
  it('emits temperature as a top-level key of the config frame, never inside voice_settings', () => {
    const msg = buildTextPayload('c', 'x', { ...opts, temperature: 0.3 }, { includeConfig: true });
    expect(msg.temperature).toBe(0.3);
    expect(msg.voice_settings).not.toHaveProperty('temperature');
  });

  it('sends temperature 0 (a real value, not "unset")', () => {
    const msg = buildTextPayload('c', 'x', { ...opts, temperature: 0 }, { includeConfig: true });
    expect(msg.temperature).toBe(0);
  });

  it('omits temperature when unset and from bare text frames', () => {
    expect(buildTextPayload('c', 'x', opts, { includeConfig: true })).not.toHaveProperty(
      'temperature',
    );
    expect(buildTextPayload('c', 'x', { ...opts, temperature: 0.5 })).not.toHaveProperty(
      'temperature',
    );
  });
});

describe('buildClosePayload', () => {
  it('drains by default', () => {
    expect(buildClosePayload('ctx1')).toEqual({ close_context: true, context_id: 'ctx1' });
  });

  it('sets immediate for barge-in', () => {
    expect(buildClosePayload('ctx1', true)).toMatchObject({ immediate: true });
  });
});

describe('wordTimestampsToTimed', () => {
  it('converts server milliseconds to seconds', () => {
    const timed = wordTimestampsToTimed([
      { word: 'Hallo', start_ms: 0, end_ms: 500 },
      { word: 'Welt', start_ms: 500, end_ms: 1200 },
    ]);
    expect(timed).toEqual([
      { text: 'Hallo', startTime: 0, endTime: 0.5 },
      { text: 'Welt', startTime: 0.5, endTime: 1.2 },
    ]);
  });
});

describe('buildTextPayload — pronunciation dictionaries', () => {
  it('sends dictionary_ids with its project on the config frame', () => {
    const msg = buildTextPayload('ctx1', 'hello', {
      ...opts,
      dictionaryIds: [120],
      projectId: 7,
    }, { includeConfig: true });
    expect(msg.dictionary_ids).toEqual([120]);
    expect(msg.project_id).toBe(7);
  });

  it('omits an EMPTY selection rather than sending it', () => {
    // `dictionary_ids: []` is an explicit opt-out server-side, not "unset", so
    // sending it in place of nothing silently disables the project's defaults.
    const msg = buildTextPayload('ctx1', 'hello', {
      ...opts,
      dictionaryIds: [],
      projectId: 7,
    }, { includeConfig: true });
    expect(msg).not.toHaveProperty('dictionary_ids');
    expect(msg.project_id).toBe(7);
  });

});
