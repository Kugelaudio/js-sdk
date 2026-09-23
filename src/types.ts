/**
 * Type definitions for KugelAudio SDK.
 */

import type { ServerRestartingError } from './errors';

/**
 * TTS model information.
 */
export interface Model {
  id: string;
  name: string;
  description: string;
  parameters: string;
  maxInputLength: number;
  sampleRate: number;
}

// ─── Speech-to-text ─────────────────────────────────────────────────────────

export interface SpellingAlternative {
  spelling: string;
  probability: number;
}

export interface WordAlternatives {
  raw_word_index: number;
  word: string;
  alternatives: SpellingAlternative[];
}

export interface TranscriptionResponse {
  /** OpenAI-compatible transcript field. */
  text: string;
  /** KugelAudio's retained backward-compatible transcript field. */
  transcript: string;
  language: string;
  duration_s: number;
  model: string;
  model_revision?: string;
  word_alternatives: WordAlternatives[];
  [key: string]: unknown;
}

export interface TranscribeOptions {
  audio: Blob;
  filename?: string;
  language?: string;
  model?: 'luchs-1';
}

export interface StreamingTranscriptionConfig {
  type: 'config';
  sample_rate: number;
  language?: string;
  boosted_phrases?: string[];
  vad_silence_signals?: boolean;
  server_flush?: boolean;
}

export interface StreamingAudioChunk {
  type: 'audio_chunk';
  /** Base64-encoded mono PCM16 at the configured sample rate. */
  audio_b64: string;
}

export interface StreamingTranscriptionResult {
  /** `alternatives` is an additive post-final uncertainty update. */
  type: 'partial' | 'alternatives';
  /** Complete rolling hypothesis; replace the previous value. */
  partial_text: string;
  is_final: boolean;
  /** Backend model identity is populated on final frames. */
  model?: string;
  model_revision?: string;
  turn_end_reason?:
    | 'client_end_of_speech'
    | 'model_end_of_turn'
    | 'silence_timeout';
  turn_end_confidence?: number;
  turn_end_inference_ms?: number;
  word_alternatives: WordAlternatives[];
  [key: string]: unknown;
}

/**
 * Voice category types.
 */
export type VoiceCategory = 'premade' | 'cloned' | 'designed' | 'conversational' | 'narrative' | 'narrative_story' | 'characters';

/**
 * Voice sex types.
 */
export type VoiceSex = 'male' | 'female' | 'neutral';

/**
 * Voice age types.
 */
export type VoiceAge = 'young' | 'middle_aged' | 'old';

/**
 * Voice information.
 */
export interface Voice {
  id: number;
  name: string;
  description?: string;
  category?: VoiceCategory;
  sex?: VoiceSex;
  age?: VoiceAge;
  quality?: string;
  supportedLanguages: string[];
  sampleText?: string;
  avatarUrl?: string;
  sampleUrl?: string;
  isPublic: boolean;
  verified: boolean;
}

/**
 * Paginated response from the voices list endpoint.
 */
export interface VoiceListResponse {
  voices: Voice[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Voice quality levels.
 */
export type VoiceQuality = 'low' | 'mid' | 'high';

// ─── Dictionaries ────────────────────────────────────────────────────────────

/**
 * A per-project pronunciation dictionary.
 */
export interface Dictionary {
  id: number;
  projectId: number;
  name: string;
  description?: string;
  language?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single word → replacement / IPA mapping within a dictionary.
 */
export interface DictionaryEntry {
  id: number;
  dictionaryId: number;
  word: string;
  replacement: string;
  ipa?: string;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Paginated response from listing entries.
 */
export interface DictionaryEntryListResponse {
  entries: DictionaryEntry[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Counts returned by `entries.replaceAll`.
 */
export interface BulkReplaceResult {
  upserted: number;
  deleted: number;
  total: number;
}

/**
 * Options for creating a dictionary.
 */
export interface CreateDictionaryOptions {
  name: string;
  description?: string;
  language?: string;
}

/**
 * Options for updating a dictionary. Only provided fields are changed.
 */
export interface UpdateDictionaryOptions {
  name?: string;
  description?: string;
  language?: string;
  isActive?: boolean;
}

/**
 * Payload for creating or replacing a single entry.
 */
export interface DictionaryEntryInput {
  word: string;
  replacement: string;
  ipa?: string;
  caseSensitive?: boolean;
}

/**
 * Options for updating an entry.
 */
export interface UpdateDictionaryEntryOptions {
  word?: string;
  replacement?: string;
  ipa?: string;
  caseSensitive?: boolean;
}

/**
 * Extended voice information returned by voice management endpoints.
 */
export interface VoiceDetail {
  id: number;
  name: string;
  description: string;
  generativeVoiceDescription: string;
  supportedLanguages: string[];
  category: string;
  age?: string;
  sex?: string;
  quality: string;
  isPublic: boolean;
  verified: boolean;
  pendingVerification: boolean;
  sampleUrl?: string;
  avatarUrl?: string;
  sampleText: string;
}

/**
 * Voice reference audio metadata.
 */
export interface VoiceReference {
  id: number;
  voiceId: number;
  name: string;
  referenceText: string;
  s3Path: string;
  audioUrl?: string;
  isGenerated: boolean;
}

/**
 * Options for creating a new voice.
 */
export interface CreateVoiceOptions {
  name: string;
  sex: string;
  description?: string;
  category?: string;
  age?: string;
  quality?: string;
  supportedLanguages?: string[];
  isPublic?: boolean;
  sampleText?: string;
  /** Reference audio files (File objects in browser, Buffer/Blob in Node.js) */
  referenceFiles?: Array<File | Blob>;
}

/**
 * Options for updating an existing voice.
 */
export interface UpdateVoiceOptions {
  name?: string;
  description?: string;
  category?: string;
  age?: string;
  sex?: string;
  quality?: string;
  supportedLanguages?: string[];
  isPublic?: boolean;
  sampleText?: string;
}

/**
 * Word-level timestamp from server-side forced alignment.
 */
export interface WordTimestamp {
  /** The aligned word */
  word: string;
  /** Start time in milliseconds (relative to chunk/audio start) */
  startMs: number;
  /** End time in milliseconds (relative to chunk/audio start) */
  endMs: number;
  /** Start character offset in the original text */
  charStart: number;
  /** End character offset in the original text */
  charEnd: number;
  /** Alignment confidence score (0.0 - 1.0) */
  score: number;
}

/**
 * TTS generation request options.
 */
export interface GenerateOptions {
  /** Text to synthesize */
  text: string;
  /** Model to use. Default: 'kugel-3'. Legacy ids (kugel-2.5, kugel-1-turbo, …) still accepted; they alias to kugel-3 server-side. */
  modelId?: string;
  /** Voice ID to use */
  voiceId?: number;
  /** Classifier-free guidance scale. Clamped to [1.2, 2.5] (default: 2.0). */
  cfgScale?: number;
  /**
   * Sampling variance. Range [0.0, 1.0]. 0 = most stable (near-greedy),
   * 1 = most variance. Default: 0.5.
   *
   * Lower values produce more consistent reads across regenerations —
   * useful for stable voiceovers, IVR prompts, and e-learning.
   */
  temperature?: number;
  /** Maximum tokens to generate (default: 2048) */
  maxNewTokens?: number;
  /** Output sample rate (default: 24000) */
  sampleRate?: number;
  /**
   * Combined codec+rate token, e.g. 'ulaw_8000' / 'alaw_8000' / 'pcm_8000'.
   * Opt-in; when set it is authoritative and must not contradict sampleRate.
   * Absent ⇒ legacy PCM16 at sampleRate.
   */
  outputFormat?: string;
  /**
   * Enable text normalization (converts numbers, dates, etc. to spoken words).
   * When true, text will be normalized before TTS generation.
   * Default: true
   * 
   * Set `language` when the text is not in the voice's primary language;
   * normalization does not detect the language from the text.
   */
  normalize?: boolean;
  /**
   * ISO 639-1 language code for text normalization (e.g., 'de', 'en', 'fr').
   * If not provided, the server uses the voice's primary language, falling back
   * to English. The language is not detected from the text.
   * 
   * Supported: de, en, fr, es, it, pt, nl, pl, sv, da, no, fi, cs, hu, ro,
   *            el, uk, bg, tr, vi, ar, hi, zh, ja, ko, sk, sl, hr, sr, ru,
   *            he, fa, ur, bn, ta, yue, th, id, ms
   */
  language?: string;
  /**
   * Request word-level timestamps alongside audio.
   * When true, the server performs forced alignment and returns per-word timing boundaries.
   * Default: false
   */
  wordTimestamps?: boolean;
  /**
   * Playback speed multiplier (0.8 = slower, 1.0 = normal, 1.2 = faster).
   *
   * Uses pitch-preserving time-stretching (WSOLA); applies to the whole
   * request. Wrap text in `<prosody rate="slow|medium|fast|0.8-1.2">` to
   * override the rate for a span (the span rate wins inside the span).
   * Range: [0.8, 1.2]. Default: 1.0.
   */
  speed?: number;
  /**
   * Optional project ID for project-scoped features (custom dictionary
   * replacements, per-project rate limits). The caller MUST verify the
   * authenticated user has access to this project before passing it; the
   * server treats the value as trusted once received.
   */
  projectId?: number;
  /**
   * Per-request dictionary selection. Omit for the default behavior (all
   * active dictionaries of the project apply, filtered by language). An
   * empty array disables dictionaries for this request. A list of
   * dictionary IDs applies exactly those dictionaries — including
   * inactive ones — bypassing the language filter.
   */
  dictionaryIds?: number[];
}

/**
 * Streaming session configuration for `/ws/tts/stream`.
 *
 * The server accumulates LLM tokens internally and starts generation at natural
 * sentence boundaries. Use {@link chunkLengthSchedule} to tune how eagerly the
 * server begins generating, or set {@link autoMode} to start at the very first
 * clean boundary — equivalent to ElevenLabs' `auto_mode=true`.
 *
 * @example Low-latency preset
 * ```typescript
 * const session = client.tts.streamingSession({
 *   voiceId: 123,
 *   autoMode: true,
 *   chunkLengthSchedule: [50, 100, 150, 250],
 * });
 * ```
 */
export interface StreamConfig {
  /** Voice ID to use */
  voiceId?: number;
  /** Model ID. Default: 'kugel-3'. Legacy ids still accepted; they alias to kugel-3 server-side. */
  modelId?: string;
  /** Classifier-free guidance scale. Clamped to [1.2, 2.5] (default: 2.0). */
  cfgScale?: number;
  /**
   * Sampling variance. Range [0.0, 1.0]. 0 = most stable, 1 = most variance.
   * Default: 0.5.
   */
  temperature?: number;
  /** Maximum tokens per generation */
  maxNewTokens?: number;
  /** Output sample rate */
  sampleRate?: number;
  /** Combined codec+rate token (e.g. 'ulaw_8000'); opt-in, set-once per session. */
  outputFormat?: string;
  /** Auto-flush timeout in milliseconds */
  flushTimeoutMs?: number;
  /** Maximum buffer length */
  maxBufferLength?: number;
  /**
   * Enable text normalization (converts numbers, dates, etc. to spoken words).
   * Default: true
   */
  normalize?: boolean;
  /**
   * ISO 639-1 language code for text normalization (e.g., 'de', 'en', 'fr').
   * If not provided, the voice's primary language is used (English if none).
   */
  language?: string;
  /**
   * Request word-level timestamps alongside audio.
   * Default: false
   */
  wordTimestamps?: boolean;
  /**
   * Minimum buffer sizes (in characters) the server must accumulate before
   * auto-emitting each successive chunk. Entry `i` applies to chunk `i`; the
   * last value is reused for all subsequent chunks.
   *
   * Smaller values produce lower TTFA at the cost of less prosody context.
   * Larger values improve naturalness but increase TTFA.
   *
   * @example
   * ```typescript
   * chunkLengthSchedule: [50, 100, 150, 250]  // low-latency
   * chunkLengthSchedule: [120, 200, 300]       // high-quality prosody
   * ```
   */
  chunkLengthSchedule?: number[];
  /**
   * When `true`, the server starts generating audio at the very first clean
   * sentence boundary, regardless of `chunkLengthSchedule`. Equivalent to
   * ElevenLabs' `auto_mode=true`. Prioritises low TTFA; may produce slightly
   * less natural prosody on the first chunk.
   */
  autoMode?: boolean;
  /**
   * Playback speed multiplier (0.8 = slower, 1.0 = normal, 1.2 = faster).
   *
   * Uses pitch-preserving time-stretching (WSOLA); applies to the whole
   * request. Wrap text in `<prosody rate="slow|medium|fast|0.8-1.2">` to
   * override the rate for a span (the span rate wins inside the span).
   * Range: [0.8, 1.2]. Default: 1.0.
   */
  speed?: number;
  /**
   * Per-request dictionary selection. Omit for the default behavior (all
   * active dictionaries of the project apply, filtered by language). An
   * empty array disables dictionaries for this request. A list of
   * dictionary IDs applies exactly those dictionaries — including
   * inactive ones — bypassing the language filter.
   */
  dictionaryIds?: number[];
}

/**
 * Generation parameters changeable mid-connection via
 * {@link StreamingSession.updateSettings} / {@link MultiContextSession.updateSettings}
 * (KUG-1166). Every field is optional; an update changes only the fields it
 * carries. Identity / audio-format fields (`voiceId`, `modelId`, `sampleRate`,
 * `outputFormat`, `dictionaryIds`) are NOT here — they are fixed for the
 * connection's lifetime and the server rejects them in an update.
 */
export interface SettingsUpdate {
  /** Classifier-free guidance scale (0.0–10.0). */
  cfgScale?: number;
  /** Sampling variance (0.0–1.0). */
  temperature?: number;
  /** Playback speed multiplier (0.8–1.2). */
  speed?: number;
  /** Maximum tokens per generation (1–2048). */
  maxNewTokens?: number;
  /** Language code for normalization (e.g. `'de'`). */
  language?: string;
  /** Enable text normalization. */
  normalize?: boolean;
}

/**
 * The generation parameters in effect after an
 * {@link StreamingSession.updateSettings} call — the server's echo. Fields the
 * session never set come back `null` (e.g. `temperature`, `language`).
 */
export interface EffectiveSettings {
  cfgScale?: number;
  temperature?: number | null;
  speed?: number;
  maxNewTokens?: number;
  language?: string | null;
  normalize?: boolean;
}

/**
 * Event callbacks for a streaming session (`/ws/tts/stream`).
 *
 * This is the LLM-integration endpoint: forward raw tokens via
 * {@link StreamingSession.send} and the server auto-chunks them at sentence
 * boundaries.
 */
export interface StreamingSessionCallbacks {
  /** Called when an audio chunk arrives for any segment. */
  onChunk?: (chunk: AudioChunk) => void;
  /**
   * Called when all audio for one flushed text segment is complete.
   * Carries the segment index, total audio duration, and generation time.
   */
  onChunkComplete?: (chunkId: number, audioSeconds: number, genMs: number) => void;
  /**
   * Called when the server marks the end of a turn's audio
   * (`{"final": true, ...}` — sent after the last audio frame of every
   * gracefully completed turn, right before `session_closed`). The
   * ElevenLabs `isFinal` equivalent: once this fires, no further audio
   * for the turn will arrive. Not fired on a barge-in cancel — that
   * path fires {@link onInterrupted} instead.
   */
  onFinal?: (totalAudioSeconds: number, totalTextChunks: number, totalAudioChunks: number) => void;
  /**
   * Called when the session is fully closed (after `session.close()`).
   * Fires right after {@link onFinal} and additionally carries usage.
   */
  onSessionClosed?: (totalAudioSeconds: number, totalTextChunks: number, totalAudioChunks: number) => void;
  /** Called when the server begins generating audio for a text segment. */
  onGenerationStarted?: (chunkId: number, text: string) => void;
  /** Called when word-level timestamps arrive (requires `wordTimestamps: true`). */
  onWordTimestamps?: (timestamps: WordTimestamp[]) => void;
  /**
   * Called when the server acknowledges a barge-in
   * ({@link StreamingSession.cancelCurrent}). After this fires, no further
   * audio chunks from the cancelled turn will arrive and the session is
   * ready for the next `send()`.
   */
  onInterrupted?: () => void;
  /** Called on any error. */
  onError?: (error: Error) => void;
  /**
   * Called when a rolling deploy closed the socket (close code 1012 / 1013)
   * and the SDK is about to reconnect after `error.retryAfter` seconds and
   * replay the current turn transparently. Informational only: `send()`
   * keeps working meanwhile. When a replay would repeat audio that was
   * already delivered, or the turn was replayed once before, {@link onError}
   * fires with the same error instead and the session stays disconnected.
   */
  onServerRestart?: (error: ServerRestartingError) => void;
}

/**
 * Per-session usage reported in the `session_closed` frame (KUG-1192).
 *
 * Lets you bill your own customers per conversation. `costCents` is the
 * actual amount charged in **EUR cents**. When the charge could not be
 * determined at session end (e.g. a transient billing error) `costCents` is
 * `null` and `costAvailable` is `false` — never a misleading `0`.
 * `audioSeconds` is always reported. On `/ws/tts/multi` usage is reported per
 * context (per conversation) on each `context_closed` frame, not aggregated
 * across contexts.
 */
export interface SessionUsage {
  /** Total audio generated this session, in seconds (the unit we bill on). */
  audioSeconds: number;
  /** Actual amount charged in EUR cents, or `null` if undetermined. */
  costCents: number | null;
  /** Currency of `costCents` (`"eur"`); present only when `costCents` is set. */
  currency?: string;
  /** Total input characters submitted this session, if reported. */
  characters?: number;
  /** Model that produced the audio, if reported. */
  modelId?: string;
  /** `true` when an authoritative charge was returned for this session. */
  costAvailable: boolean;
}

/**
 * Parse the raw `usage` object (or a legacy `session_closed` payload without
 * one) into a typed {@link SessionUsage}. Returns `null` when no usage info
 * is present.
 */
export function parseSessionUsage(
  data: Record<string, unknown>,
): SessionUsage | null {
  const raw = data.usage as Record<string, unknown> | undefined;
  const source = raw && typeof raw === 'object' ? raw : data;
  const audioSeconds =
    typeof source.audio_seconds === 'number'
      ? source.audio_seconds
      : typeof data.total_audio_seconds === 'number'
        ? data.total_audio_seconds
        : undefined;
  if (audioSeconds === undefined) return null;
  const costCents =
    typeof source.cost_cents === 'number' ? source.cost_cents : null;
  return {
    audioSeconds,
    costCents,
    currency:
      typeof source.currency === 'string' ? source.currency : undefined,
    characters:
      typeof source.characters === 'number' ? source.characters : undefined,
    modelId: typeof source.model_id === 'string' ? source.model_id : undefined,
    costAvailable: costCents !== null,
  };
}

/**
 * Audio chunk from streaming TTS.
 */
export interface AudioChunk {
  /** Raw PCM16 audio as base64 */
  audio: string;
  /** Encoding format. 'mulaw' / 'alaw' only when output_format requested G.711. */
  encoding: 'pcm_s16le' | 'mulaw' | 'alaw';
  /** Chunk index */
  index: number;
  /** Sample rate */
  sampleRate: number;
  /** Number of samples */
  samples: number;
}

/**
 * Final message from TTS generation.
 */
export interface GenerationStats {
  /** Indicates this is the final message */
  final: true;
  /** Number of chunks generated */
  chunks: number;
  /** Total samples generated */
  totalSamples: number;
  /** Duration of audio in milliseconds */
  durationMs: number;
  /** Generation time in milliseconds */
  generationMs: number;
  /** Real-time factor */
  rtf: number;
  /** Error message if any */
  error?: string;
  /**
   * Per-request usage (audio time + amount charged), for billing your own
   * customers. Undefined when the server reports no usage. See
   * {@link SessionUsage}.
   */
  usage?: SessionUsage;
}

/**
 * Complete audio response from TTS generation.
 */
export interface AudioResponse {
  /** Raw PCM16 audio bytes as ArrayBuffer */
  audio: ArrayBuffer;
  /** Sample rate */
  sampleRate: number;
  /** Number of samples */
  samples: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Generation time in milliseconds */
  generationMs: number;
  /** Real-time factor */
  rtf: number;
  /** Per-word timing boundaries (populated when `wordTimestamps: true`) */
  wordTimestamps: WordTimestamp[];
}

/**
 * Event callbacks for streaming.
 */
export interface StreamCallbacks {
  /** Called when an audio chunk is received */
  onChunk?: (chunk: AudioChunk) => void;
  /** Called when word-level timestamps are received (requires `wordTimestamps: true`) */
  onWordTimestamps?: (timestamps: WordTimestamp[]) => void;
  /** Called when generation is complete */
  onFinal?: (stats: GenerationStats) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called when connection opens */
  onOpen?: () => void;
  /** Called when connection closes */
  onClose?: () => void;
  /**
   * Called when a rolling deploy closed the socket (close code 1012 / 1013)
   * before any audio arrived and the SDK is about to re-issue the request
   * once after `error.retryAfter` seconds. Informational only. A request
   * that already received audio, or was re-issued once before, fails with
   * {@link onError} instead.
   */
  onServerRestart?: (error: ServerRestartingError) => void;
}

/**
 * Deployment region. Set `'eu'` to use the direct EU endpoint:
 * `api.eu.kugelaudio.com`.
 *
 * If omitted, the SDK uses `api.kugelaudio.com`.
 */
export type Region = 'eu' | 'us' | 'global';

/**
 * KugelAudio client options.
 */
export interface KugelAudioOptions {
  /** Your KugelAudio API key or JWT token. Prefix with `eu-` to select the direct EU endpoint (prefix is stripped before auth). */
  apiKey: string;
  /** Whether apiKey is a master key (for internal/server-side use). Master keys bypass billing. */
  isMasterKey?: boolean;
  /** Whether apiKey is a JWT token (for user authentication). Takes precedence over isMasterKey. */
  isToken?: boolean;
  /** Organisation ID to bill usage against (required for token auth to enable usage recording). */
  orgId?: number;
  /** Deployment region. Set `eu` to select the direct EU endpoint. Takes precedence over API-key prefix but not over `apiUrl`. */
  region?: Region;
  /** API base URL (default: https://api.kugelaudio.com) */
  apiUrl?: string;
  /** TTS server URL (default: same as apiUrl) */
  ttsUrl?: string;
  /** HTTP request and WebSocket opening timeout in milliseconds (default: 60000). Does not cap audio duration. */
  timeout?: number;
  /**
   * Interval in milliseconds between WebSocket ping frames sent on the pooled connection
   * to prevent idle timeouts (default: 20000). Set to 0 or null to disable.
   * In browsers, pings are sent via the ws package only (skipped in native WebSocket environments).
   */
  keepalivePingInterval?: number | null;
  /**
   * Send anonymous client-error diagnostics (no text, audio, keys or URLs —
   * see the attribute allowlist in `diagnosticsWire.ts`).
   *
   * Defaults to enabled only for the KugelAudio-hosted API; a custom
   * `apiUrl` (on-premise) defaults to disabled. The `KUGELAUDIO_TELEMETRY`
   * environment variable overrides this option in both directions.
   */
  telemetry?: boolean;
}

/**
 * API error response.
 */
export interface ApiError {
  error: string;
  detail?: string;
  statusCode?: number;
}

/**
 * Multi-context session configuration.
 */
export interface MultiContextConfig {
  /** Default voice ID for new contexts */
  defaultVoiceId?: number;
  /** Output sample rate (default: 24000) */
  sampleRate?: number;
  /** Combined codec+rate token (e.g. 'ulaw_8000'); opt-in, set-once per context. */
  outputFormat?: string;
  /** Classifier-free guidance scale. Clamped to [1.2, 2.5] (default: 2.0). */
  cfgScale?: number;
  /**
   * Sampling variance. Range [0.0, 1.0]. 0 = most stable, 1 = most variance.
   * Default: 0.5.
   */
  temperature?: number;
  /** Maximum tokens to generate (default: 2048) */
  maxNewTokens?: number;
  /** Enable text normalization (default: true) */
  normalize?: boolean;
  /**
   * ISO 639-1 language code for text normalization (e.g., 'de', 'en', 'fr').
   * If not set, the server uses the voice's primary language, falling back
   * to English. The language is not detected from the text.
   */
  language?: string;
  /**
   * Per-request dictionary selection. Omit for the default behavior (all
   * active dictionaries of the project apply, filtered by language). An
   * empty array disables dictionaries for this request. A list of
   * dictionary IDs applies exactly those dictionaries — including
   * inactive ones — bypassing the language filter.
   */
  dictionaryIds?: number[];
  /** Seconds before context auto-closes (default: 20.0) */
  inactivityTimeout?: number;
}

/**
 * Voice settings for a specific context.
 */
export interface ContextVoiceSettings {
  /** Stability (0.0-1.0) */
  stability?: number;
  /** Similarity boost (0.0-1.0) */
  similarityBoost?: number;
  /** Style (0.0-1.0) */
  style?: number;
  /** Use speaker boost */
  useSpeakerBoost?: boolean;
  /** Speed multiplier */
  speed?: number;
}

/**
 * Audio chunk from multi-context streaming.
 */
export interface MultiContextAudioChunk extends AudioChunk {
  /** Context ID this audio belongs to */
  contextId: string;
}

/**
 * Event callbacks for multi-context streaming.
 */
export interface MultiContextCallbacks {
  /** Called when session is started */
  onSessionStarted?: (sessionId: string) => void;
  /** Called when a context is created */
  onContextCreated?: (contextId: string) => void;
  /** Called when an audio chunk is received */
  onChunk?: (chunk: MultiContextAudioChunk) => void;
  /**
   * Called when all audio admitted before a `{flush: true}` has been
   * delivered for a context (`{"final": true, "context_id": ...}`), and
   * once more before {@link onContextClosed} on a graceful close. The
   * ElevenLabs multi-context `is_final` equivalent. Not fired on an
   * immediate (barge-in) close.
   */
  onFinal?: (contextId: string) => void;
  /**
   * Called when a context is closed (terminal). `usage` carries this
   * conversation's audio time + amount charged (undefined if not reported).
   * See {@link SessionUsage}.
   */
  onContextClosed?: (contextId: string, usage?: SessionUsage) => void;
  /** Called when a context times out */
  onContextTimeout?: (contextId: string) => void;
  /** Called when session is closed */
  onSessionClosed?: (stats: Record<string, unknown>) => void;
  /** Called on error */
  onError?: (error: Error, contextId?: string) => void;
  /**
   * Called when a rolling deploy closed the socket (close code 1012 / 1013)
   * and the SDK is about to reconnect after `error.retryAfter` seconds,
   * re-create the open contexts and replay their pending text. Contexts that
   * already received audio for the current turn are not replayed: each of
   * those gets {@link onError} with its `contextId` and is re-created on the
   * next `send()`.
   */
  onServerRestart?: (error: ServerRestartingError) => void;
}
