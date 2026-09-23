/**
 * KugelAudio TypeScript/JavaScript SDK
 *
 * Official client for KugelAudio TTS API.
 *
 * @example
 * ```typescript
 * import { KugelAudio } from 'kugelaudio';
 *
 * const client = new KugelAudio({ apiKey: 'your_api_key' });
 *
 * // List available models
 * const models = await client.models.list();
 *
 * // List available voices
 * const voices = await client.voices.list();
 *
 * // Generate audio (non-streaming)
 * const audio = await client.tts.generate({
 *   text: 'Hello, world!',
 *   modelId: 'kugel-3',
 *   voiceId: 123,
 * });
 *
 * // Generate audio (streaming)
 * await client.tts.stream(
 *   { text: 'Hello, world!', modelId: 'kugel-3' },
 *   {
 *     onChunk: (chunk) => {
 *       // Process audio chunk
 *     },
 *     onFinal: (stats) => {
 *       console.log(`Generated ${stats.durationMs}ms of audio`);
 *     },
 *   }
 * );
 * ```
 *
 * @packageDocumentation
 */

// Main client and session classes
export { KugelAudio } from './client';

// Types
export type {
    AudioChunk,
    AudioResponse,
    BulkReplaceResult,
    ContextVoiceSettings,
    CreateDictionaryOptions,
    CreateVoiceOptions,
    Dictionary,
    DictionaryEntry,
    DictionaryEntryInput,
    DictionaryEntryListResponse,
    EffectiveSettings,
    GenerateOptions,
    GenerationStats,
    KugelAudioOptions,
    Model,
    Region,
    MultiContextAudioChunk,
    MultiContextCallbacks,
    MultiContextConfig,
    SessionUsage,
    SettingsUpdate,
    StreamCallbacks,
    StreamConfig,
    SpellingAlternative,
    StreamingAudioChunk,
    StreamingTranscriptionConfig,
    StreamingTranscriptionResult,
    TranscribeOptions,
    TranscriptionResponse,
    StreamingSessionCallbacks,
    UpdateDictionaryEntryOptions,
    UpdateDictionaryOptions,
    UpdateVoiceOptions,
    Voice,
    VoiceAge,
    VoiceCategory,
    VoiceDetail,
    VoiceListResponse,
    VoiceQuality,
    VoiceReference,
    VoiceSex,
    WordAlternatives,
    WordTimestamp
} from './types';
export { parseSessionUsage } from './types';

export { DictionariesResource, DictionaryEntriesResource } from './dictionaries';

// Errors
export {
    AuthenticationError,
    ConnectionError,
    ErrorCodes,
    InsufficientCreditsError,
    KugelAudioError,
    NotFoundError,
    RateLimitError,
    ServerRestartingError,
    ValidationError,
    WsCloseCodes,
    classifyHttpError,
    classifyWsClose,
    classifyWsFrame,
    classifyWsHandshakeError,
    isWsErrorCloseCode,
} from './errors';
export type { ErrorCode, KugelAudioErrorOptions } from './errors';

// Client-error diagnostics are internal: the only public knob is the
// `telemetry` client option (and the KUGELAUDIO_TELEMETRY env var).

// Utilities
export {
    base64ToArrayBuffer,
    createWavBlob,
    createWavFile,
    decodePCM16
} from './utils';
