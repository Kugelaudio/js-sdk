/**
 * KugelAudio TTS and STT plugins for the LiveKit Agents (Node.js) framework.
 *
 * Import from `kugelaudio/livekit`. Requires `@livekit/agents` and its peer
 * `@livekit/rtc-node` to be installed (they are optional peer dependencies of
 * this SDK). This is the TypeScript counterpart to `kugelaudio.livekit` in the
 * Python SDK.
 *
 * @example
 * ```ts
 * import { voice } from '@livekit/agents';
 * import { STT, TTS } from 'kugelaudio/livekit';
 *
 * const session = new voice.AgentSession({
 *   stt: new STT({ language: 'en' }),
 *   turnHandling: { turnDetection: 'stt' }, // the server's end of turn drives turns
 *   tts: new TTS({ voiceId: 1071, model: 'kugel-3.5', language: 'en' }),
 *   // ...vad, llm
 * });
 * ```
 *
 * @packageDocumentation
 */

export { TTS, ChunkedStream, SynthesizeStream } from './tts';
export type { TTSOptions } from './tts';

export { STT, SpeechStream, DEFAULT_STT_SAMPLE_RATE } from './stt';
export type { STTOptions } from './stt';

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
