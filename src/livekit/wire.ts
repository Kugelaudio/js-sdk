/**
 * Pure wire-protocol helpers for the KugelAudio `/ws/tts/multi` endpoint used
 * by the LiveKit plugin.
 *
 * Kept free of any `@livekit/agents` import so the message-shaping logic can be
 * unit-tested without the LiveKit runtime. Mirrors the send loop of
 * `kugelaudio.livekit.tts._Connection` in the Python SDK.
 */

import packageJson from '../../package.json';

const SDK_NAME = 'js';
const SDK_VERSION = packageJson.version;

/** Generation parameters carried on the first message of each context. */
export interface WireOptions {
  model: string;
  voiceId: number | null;
  sampleRate: number;
  cfgScale: number;
  maxNewTokens: number;
  wordTimestamps: boolean;
  normalize: boolean;
  language?: string;
  /**
   * Playback speed multiplier in [0.8, 1.2]; `undefined` leaves the server
   * default (1.0). Emitted as a TOP-LEVEL key of the config frame — see
   * {@link buildTextPayload}.
   */
  speed?: number;
  /**
   * Sampling variance in [0.0, 1.0]; `undefined` leaves the engine default.
   * Top-level like `speed`: nested in `voice_settings` it is dropped.
   */
  temperature?: number;
  /**
   * Pronunciation dictionaries to apply, by id.
   *
   * The server treats `dictionary_ids: []` as an explicit opt-out rather than
   * "unset", so an empty array must never be sent in place of nothing — the
   * two mean different things and the empty form silently disables a project's
   * default dictionaries.
   */
  dictionaryIds?: number[];
  /**
   * Project the dictionaries belong to. The server rejects a dictionary
   * selection that arrives without it, so the two travel together.
   */
  projectId?: number;
}

/** Append the `sdk` / `sdk_version` query params used for server-side telemetry. */
export function appendSdkQuery(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return (
    `${url}${separator}sdk=${encodeURIComponent(SDK_NAME)}` +
    `&sdk_version=${encodeURIComponent(SDK_VERSION)}`
  );
}

/**
 * Build the `wss://.../ws/tts/multi` URL from an `https://`/`http://` base URL.
 * The API key is passed as a query parameter, matching the Python plugin.
 */
export function buildMultiWsUrl(baseUrl: string, apiKey: string): string {
  const wsBase = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  return appendSdkQuery(`${wsBase}/ws/tts/multi?api_key=${apiKey}`);
}

/**
 * Build the JSON payload for a text message to a context.
 *
 * When `includeConfig` is true (the first message sent for a context), the
 * session + voice configuration is attached, exactly as the Python plugin does
 * on the first frame of a new `context_id`.
 *
 * `speed` is deliberately a TOP-LEVEL key, not a `voice_settings` entry:
 * `/ws/tts/multi` parses it off the frame root via `StreamUpdate`, and a
 * `speed` nested inside `voice_settings` is discarded with only a server-side
 * log warning — i.e. it would silently return audio at the unmodified rate.
 */
export function buildTextPayload(
  contextId: string,
  text: string,
  opts: WireOptions,
  { flush = false, includeConfig = false }: { flush?: boolean; includeConfig?: boolean } = {},
): Record<string, unknown> {
  const msg: Record<string, unknown> = { text, context_id: contextId };
  if (flush) msg.flush = true;

  if (includeConfig) {
    msg.model_id = opts.model;
    msg.sample_rate = opts.sampleRate;
    msg.word_timestamps = opts.wordTimestamps;
    msg.normalize = opts.normalize;
    if (opts.language !== undefined) msg.language = opts.language;
    // Top level, never voice_settings — see the doc comment above.
    if (opts.speed !== undefined) msg.speed = opts.speed;
    if (opts.temperature !== undefined) msg.temperature = opts.temperature;
    if (opts.projectId !== undefined) msg.project_id = opts.projectId;
    // Length-checked, not just presence-checked: see WireOptions.dictionaryIds.
    if (opts.dictionaryIds && opts.dictionaryIds.length > 0) {
      msg.dictionary_ids = opts.dictionaryIds;
    }

    const voiceSettings: Record<string, unknown> = {};
    if (opts.voiceId !== null && opts.voiceId !== undefined) {
      voiceSettings.voice_id = opts.voiceId;
    }
    // Only send non-default generation params, mirroring the Python plugin.
    if (opts.cfgScale !== 2.0) voiceSettings.cfg_scale = opts.cfgScale;
    if (opts.maxNewTokens !== 2048) voiceSettings.max_new_tokens = opts.maxNewTokens;
    if (Object.keys(voiceSettings).length > 0) msg.voice_settings = voiceSettings;
  }

  return msg;
}

/**
 * Build the JSON payload that closes a context.
 *
 * `immediate` cancels in-flight generation (barge-in); omitting it drains any
 * queued audio first.
 */
export function buildClosePayload(
  contextId: string,
  immediate = false,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    close_context: true,
    context_id: contextId,
  };
  if (immediate) msg.immediate = true;
  return msg;
}

/** A single word-timing entry as delivered by the server (`start_ms`/`end_ms`). */
export interface RawWordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

/** A framework-agnostic word timing in seconds. */
export interface TimedWord {
  text: string;
  startTime: number;
  endTime: number;
}

/**
 * Convert the server's `word_timestamps` payload (integer milliseconds) into
 * seconds-based {@link TimedWord}s, matching the Python plugin's
 * `_word_timestamps_to_timed`.
 */
export function wordTimestampsToTimed(
  timestamps: RawWordTimestamp[],
): TimedWord[] {
  return timestamps.map((ts) => ({
    text: ts.word,
    startTime: ts.start_ms / 1000,
    endTime: ts.end_ms / 1000,
  }));
}
