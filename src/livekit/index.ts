/**
 * KugelAudio TTS plugin for the LiveKit Agents (Node.js) framework.
 *
 * Import from `kugelaudio/livekit`. Requires `@livekit/agents` and its peer
 * `@livekit/rtc-node` to be installed (they are optional peer dependencies of
 * this SDK). This is the TypeScript counterpart to `kugelaudio.livekit` in the
 * Python SDK.
 *
 * @example
 * ```ts
 * import { TTS } from 'kugelaudio/livekit';
 *
 * const tts = new TTS({ voiceId: 1071, model: 'kugel-3', language: 'en' });
 * ```
 *
 * @packageDocumentation
 */

export { TTS, ChunkedStream, SynthesizeStream } from './tts';
export type { TTSOptions } from './tts';

export {
  DEFAULT_CFG_SCALE,
  DEFAULT_MAX_NEW_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE_ID,
  MAX_SPEED,
  MAX_TEMPERATURE,
  MIN_SPEED,
  MIN_TEMPERATURE,
  SUPPORTED_LANGUAGES,
  SUPPORTED_SAMPLE_RATES,
  validateLanguage,
  validateSpeed,
  validateTemperature,
} from './models';
export type { TTSModels } from './models';
