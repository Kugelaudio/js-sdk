/**
 * Models, constants, and language validation for the KugelAudio LiveKit
 * Agents TTS plugin.
 *
 * This module has NO dependency on `@livekit/agents`, so it can be imported
 * and unit-tested without the (heavy, native) LiveKit runtime.
 */

/**
 * Available TTS models. Legacy ids (`kugel-2.5`, `kugel-2-turbo`,
 * `kugel-1-turbo`, `kugel-1`) remain accepted for back-compat — server-side
 * they all alias to `kugel-3` — but new code should use `'kugel-3'`.
 */
export type TTSModels =
  | 'kugel-3'
  | 'kugel-2.5'
  | 'kugel-2-turbo'
  | 'kugel-1-turbo'
  | 'kugel-1';

/** Default model (matches the public API default; server-side `is_default=kugel-3`). */
export const DEFAULT_MODEL: TTSModels = 'kugel-3';

/**
 * Supported output sample rates. The model generates at 24 kHz natively;
 * other rates use server-side resampling.
 */
export const SUPPORTED_SAMPLE_RATES = [24000, 22050, 16000, 8000] as const;

/** Default output sample rate. */
export const DEFAULT_SAMPLE_RATE = 24000;

/** Default voice id (`null` means use the server default voice). */
export const DEFAULT_VOICE_ID: number | null = null;

/** Default classifier-free guidance scale. */
export const DEFAULT_CFG_SCALE = 2.0;

/** Default maximum number of tokens to generate. */
export const DEFAULT_MAX_NEW_TOKENS = 2048;

/**
 * Accepted playback-speed band, matching `SPEED_MIN`/`SPEED_MAX` in
 * `services/ingress/src/ingress/tts/constants.py`. The server *rejects*
 * out-of-band values rather than clamping them, so the client rejects too —
 * clamping here would silently synthesize at a rate the caller never asked for.
 */
export const MIN_SPEED = 0.8;
export const MAX_SPEED = 1.2;

/**
 * Validate a playback-speed multiplier against the accepted band.
 *
 * @param speed - The multiplier, or `undefined`/`null` to leave unset (the
 *   server default of 1.0 then applies).
 * @returns The validated multiplier, or `undefined` when none was supplied.
 * @throws {Error} If `speed` is not a finite number inside [0.8, 1.2].
 */
export function validateSpeed(speed: number | null | undefined): number | undefined {
  if (speed === null || speed === undefined) return undefined;
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new Error(
      `speed must be a number in [${MIN_SPEED}, ${MAX_SPEED}], got ${speed}. ` +
        `The server rejects out-of-range values; use a <prosody rate="..."> ` +
        `span for finer control within a request.`,
    );
  }
  return speed;
}

/**
 * Public sampling-variance scale, matching `TEMPERATURE_MIN`/`TEMPERATURE_MAX`
 * in `services/ingress/src/ingress/routes/models.py`. The server rejects
 * out-of-range values rather than clamping them.
 */
export const MIN_TEMPERATURE = 0.0;
export const MAX_TEMPERATURE = 1.0;

/**
 * Validate a sampling temperature against the accepted range.
 *
 * @param temperature - The value, or `undefined`/`null` to leave unset (the
 *   engine default then applies).
 * @returns The validated value, or `undefined` when none was supplied.
 * @throws {Error} If `temperature` is not a finite number inside [0.0, 1.0].
 */
export function validateTemperature(temperature: number | null | undefined): number | undefined {
  if (temperature === null || temperature === undefined) return undefined;
  if (
    !Number.isFinite(temperature) ||
    temperature < MIN_TEMPERATURE ||
    temperature > MAX_TEMPERATURE
  ) {
    throw new Error(
      `temperature must be a number in [${MIN_TEMPERATURE}, ${MAX_TEMPERATURE}], ` +
        `got ${temperature}. The server rejects out-of-range values rather than clamping them.`,
    );
  }
  return temperature;
}

/**
 * ISO 639-1 language codes accepted by the API for text normalization.
 * Mirrors `kugelaudio.livekit.tts.SUPPORTED_LANGUAGES` in the Python SDK.
 */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  // Germanic
  'de', 'en', 'nl', 'sv', 'da', 'no',
  // Romance
  'fr', 'es', 'it', 'pt', 'ro',
  // Slavic
  'pl', 'cs', 'uk', 'bg', 'sk', 'sl', 'hr', 'sr',
  // Uralic
  'fi', 'hu',
  // Other European
  'el', 'tr', 'ru',
  // CJK + SEA
  'zh', 'ja', 'ko', 'vi', 'yue', 'th', 'id', 'ms',
  // Semitic + Indic + Other
  'ar', 'hi', 'he', 'fa', 'ur', 'bn', 'ta',
]);

/**
 * Validate that `language` is an ISO 639-1 code supported by the API.
 *
 * @param language - The language code, or `undefined`/`null` to leave unset.
 * @returns The validated code, or `undefined` when none was supplied.
 * @throws {Error} If `language` is not a supported ISO 639-1 code. A common
 *   mistake is passing a BCP 47 locale tag such as `'de-DE'` instead of `'de'`.
 */
export function validateLanguage(
  language: string | null | undefined,
): string | undefined {
  if (language === null || language === undefined) return undefined;
  if (!SUPPORTED_LANGUAGES.has(language)) {
    const supported = [...SUPPORTED_LANGUAGES].sort().join(', ');
    throw new Error(
      `language must be a supported ISO 639-1 code (${supported}), got ` +
        `'${language}'. Note: BCP 47 tags like 'de-DE' are not accepted — ` +
        `use 'de' instead.`,
    );
  }
  return language;
}
