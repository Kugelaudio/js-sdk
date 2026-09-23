/**
 * KugelAudio API Client.
 */

import { Diagnostics, operationForPath } from './diagnostics';
import type { Operation } from './diagnostics';
import { DictionariesResource } from './dictionaries';
import {
    ConnectionError,
    KugelAudioError,
    ServerRestartingError,
    ValidationError,
    classifyHttpError,
    classifyWsClose,
    classifyWsFrame,
    classifyWsHandshakeError,
    isWsErrorCloseCode,
} from './errors';
import type {
    AudioChunk,
    AudioResponse,
    CreateVoiceOptions,
    EffectiveSettings,
    GenerateOptions,
    GenerationStats,
    KugelAudioOptions,
    Model,
    SettingsUpdate,
    StreamCallbacks,
    StreamConfig,
    TranscribeOptions,
    TranscriptionResponse,
    StreamingSessionCallbacks,
    UpdateVoiceOptions,
    VoiceDetail,
    VoiceListResponse,
    VoiceReference,
    WordTimestamp
} from './types';
import { parseSessionUsage } from './types';
import { authHeaders, base64ToArrayBuffer, clampCfgScale } from './utils';
import { nodeReadable } from './node-runtime';
import { getWebSocket, loadWebSocket } from './websocket';
import {
    captureHandshakeRejection,
    handshakeDeadline,
    handshakeRejectionOf,
} from './handshake';

import type { Region } from './types';
import packageJson from '../package.json';

const DEFAULT_API_URL = 'https://api.kugelaudio.com';
const EU_API_URL = 'https://api.eu.kugelaudio.com';
const SUPPORTED_REGIONS = ['eu', 'us', 'global'] as const;
const SDK_NAME = 'js';
const SDK_VERSION = packageJson.version;

const REGION_PREFIXES = ['eu-', 'us-', 'global-'] as const;

function parseApiKey(apiKey: string): { cleanKey: string; detectedRegion?: Region } {
  for (const prefix of REGION_PREFIXES) {
    if (apiKey.startsWith(prefix)) {
      return { cleanKey: apiKey.slice(prefix.length), detectedRegion: prefix.slice(0, -1) as Region };
    }
  }
  return { cleanKey: apiKey };
}

/**
 * Parse a successful response body. A 204 or an empty body (e.g. DELETE on a
 * voice or reference) resolves to `undefined` instead of a JSON parse error.
 */
async function parseJsonBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Sample rate encoded in an output_format token such as 'pcm_16000' or 'ulaw_8000'. */
function sampleRateFromOutputFormat(outputFormat: string | undefined): number | undefined {
  const match = outputFormat ? /_(\d+)$/.exec(outputFormat) : null;
  return match ? Number(match[1]) : undefined;
}

function sdkHeaders(): Record<string, string> {
  return {
    'X-KugelAudio-SDK': SDK_NAME,
    'X-KugelAudio-SDK-Version': SDK_VERSION,
  };
}

function appendSdkQuery(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}sdk=${encodeURIComponent(SDK_NAME)}&sdk_version=${encodeURIComponent(SDK_VERSION)}`;
}

/**
 * Create a new WebSocket instance from the constructor `websocket.ts`
 * resolved: `getWebSocket() ?? await loadWebSocket()` at each connect path,
 * lazily, to avoid top-level side-effects that break server-side bundlers
 * (Turbopack/Webpack).
 */
function createWs(WS: typeof WebSocket, url: string): WebSocket {
  const ws = new WS(url);
  // Keeps a refused upgrade's `x-request-id` (contract "Request-ID correlation").
  captureHandshakeRejection(ws);
  return ws;
}

/**
 * A session's `openSocket` when `getWebSocket()` has no synchronous answer
 * (the ESM build on Node without `process.getBuiltinModule`): `open` runs
 * once `ws` is imported, unless the session was closed meanwhile.
 */
function openAfterLoad(
  open: () => Promise<void>,
  closed: () => boolean,
  connectOp: Operation | null,
): Promise<void> {
  return loadWebSocket().then(
    () => {
      if (!closed()) return open();
      connectOp?.cancel();
      throw new ConnectionError('Connection closed before ready');
    },
    (error: unknown) => {
      connectOp?.fail(error);
      throw error;
    },
  );
}

/**
 * What an `onerror` before OPEN actually carries: the kept rejection response
 * when the upgrade was refused, else the transport error.
 */
function handshakeFailureOf(ws: WebSocket, event: unknown): unknown {
  return handshakeRejectionOf(ws) ?? (event as { error?: unknown } | null)?.error ?? event;
}

/** WebSocket OPEN readyState constant. */
const WS_OPEN = 1;

/** RFC 6455 clean-close codes; anything else ended the stream early. */
function isNormalWsCloseCode(code: number | undefined): boolean {
  return code === undefined || code === 1000 || code === 1001;
}

/**
 * Error for a socket that closed before the stream produced its `final`
 * frame.
 *
 * A server-defined close code keeps its specific classification (auth,
 * credits, rate limit, rolling deploy); every other code (1006 abnormal,
 * 1011 internal error, or even a bare 1000 arriving early) becomes a
 * `ConnectionError` naming the code. Without this the caller's promise had
 * nothing to settle it and hung forever.
 */
function incompleteStreamError(
  code: number | undefined,
  reason?: string,
): KugelAudioError {
  if (isWsErrorCloseCode(code)) return classifyWsClose(code, reason);
  const detail = (reason ?? '').trim();
  return new ConnectionError(
    `KugelAudio WebSocket closed before the stream completed (code ` +
      `${code ?? 'unknown'})${detail ? `: ${detail}` : ''}. No final frame ` +
      'was received, so the audio delivered is incomplete.',
  );
}

/**
 * Decoded byte length of a base64 payload, without decoding it.
 * Used only for the `kugel.audio_bytes` diagnostics counter — the audio
 * itself is never read by the reporter.
 */
function base64ByteLength(b64: unknown): number {
  if (typeof b64 !== 'string' || b64.length === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Delay before reconnecting after a rolling-deploy close. */
function retryDelayMs(err: ServerRestartingError): number {
  return Math.max(0, err.retryAfter ?? 1) * 1000;
}

/**
 * camelCase SDK field → snake_case wire field for the generation parameters
 * changeable mid-connection via `update_settings` (KUG-1166). The key set is
 * authoritative: anything not here is fixed for the connection's lifetime.
 */
const UPDATABLE_SETTINGS: Record<keyof SettingsUpdate, string> = {
  cfgScale: 'cfg_scale',
  temperature: 'temperature',
  speed: 'speed',
  maxNewTokens: 'max_new_tokens',
  language: 'language',
  normalize: 'normalize',
};

/** Build the snake_case `update_settings` body; throws when empty (KUG-1166). */
function buildSettingsUpdateBody(settings: SettingsUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const camel of Object.keys(UPDATABLE_SETTINGS) as (keyof SettingsUpdate)[]) {
    const value = settings[camel];
    if (value !== undefined) body[UPDATABLE_SETTINGS[camel]] = value;
  }
  if (Object.keys(body).length === 0) {
    throw new KugelAudioError(
      'updateSettings requires at least one parameter to change ' +
        `(one of ${Object.keys(UPDATABLE_SETTINGS).join(', ')})`,
    );
  }
  return body;
}

/** Map the server's snake_case `settings` echo back to camelCase. */
function parseEffectiveSettings(raw: unknown): EffectiveSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    cfgScale: s.cfg_scale as number | undefined,
    temperature: s.temperature as number | null | undefined,
    speed: s.speed as number | undefined,
    maxNewTokens: s.max_new_tokens as number | undefined,
    language: s.language as string | null | undefined,
    normalize: s.normalize as boolean | undefined,
  };
}

/** Mirror an accepted settings update onto an SDK config object. */
function applyAcceptedSettingsUpdate(
  config: Record<string, unknown>,
  settings: SettingsUpdate,
): void {
  for (const camel of Object.keys(UPDATABLE_SETTINGS) as (keyof SettingsUpdate)[]) {
    if (settings[camel] !== undefined) {
      config[camel] = settings[camel];
    }
  }
}

/**
 * Send an `update_settings` message on an open socket and resolve with the
 * server's `settings_updated` echo (KUG-1166). Audio frames that arrive while
 * waiting are passed through to the session's normal handler (not dropped); an
 * `error` frame rejects, as does a quiet timeout or a socket close.
 */
function sendUpdateSettings(
  ws: WebSocket,
  body: Record<string, unknown>,
): Promise<EffectiveSettings> {
  const QUIET_TIMEOUT_MS = 15_000;
  return new Promise<EffectiveSettings>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const prevMessage = ws.onmessage;
    const prevClose = ws.onclose;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onmessage = prevMessage;
      ws.onclose = prevClose;
      action();
    };

    const armQuietTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new KugelAudioError(
                'Timed out waiting for settings_updated acknowledgement',
              ),
            ),
          ),
        QUIET_TIMEOUT_MS,
      );
    };

    armQuietTimer();

    ws.onmessage = (event: MessageEvent) => {
      armQuietTimer();
      let data: Record<string, unknown> | null = null;
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : event.data instanceof Buffer
            ? event.data.toString()
            : String(event.data);
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* ignore parse errors */
      }
      if (data?.settings_updated) {
        finish(() => resolve(parseEffectiveSettings(data!.settings)));
        return;
      }
      if (data?.error) {
        finish(() => reject(new KugelAudioError(String(data!.error))));
        return;
      }
      // Unrelated frame (e.g. stray audio from a draining turn): deliver it
      // through the session's normal handler rather than dropping it.
      if (prevMessage) prevMessage.call(ws, event);
    };

    ws.onclose = (event: CloseEvent) => {
      if (prevClose) prevClose.call(ws, event);
      finish(() =>
        reject(
          new ConnectionError(
            'WebSocket closed before settings_updated acknowledgement',
          ),
        ),
      );
    };

    ws.send(JSON.stringify({ update_settings: body }));
  });
}

let _languageWarningLogged = false;

function warnIfNoLanguage(
  language: string | undefined,
  normalize: boolean | undefined
): void {
  const normEnabled = normalize === undefined || normalize;
  if (!language && normEnabled && !_languageWarningLogged) {
    _languageWarningLogged = true;
    console.warn(
      "[KugelAudio] No 'language' set with normalization enabled: the server " +
        "normalizes in the voice's primary language (English if it has none). " +
        "Set language (e.g., language: 'de') when the text is in another language."
    );
  }
}

/**
 * Models resource for listing TTS models.
 */
class ModelsResource {
  constructor(private client: KugelAudio) {}

  /**
   * List available TTS models.
   */
  async list(): Promise<Model[]> {
    const response = await this.client.request<{ models: any[] }>('GET', '/v1/models');
    return response.models.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description || '',
      parameters: m.parameters || '',
      maxInputLength: m.max_input_length || 5000,
      sampleRate: m.sample_rate || 24000,
    }));
  }
}

/** Speech-to-text uploads through public KugelAudio ingress. */
class ASRResource {
  constructor(private client: KugelAudio) {}

  async transcribe(options: TranscribeOptions): Promise<TranscriptionResponse> {
    const model = options.model ?? 'luchs-1';
    const form = new FormData();
    form.append('file', options.audio, options.filename ?? 'audio.wav');
    form.append('model', model);
    if (options.language) form.append('language', options.language);
    return this.client.requestMultipart<TranscriptionResponse>(
      'POST',
      '/v1/audio/transcriptions',
      form,
    );
  }
}

/**
 * Voices resource for managing voices.
 */
class VoicesResource {
  constructor(private client: KugelAudio) {}

  /**
   * List available voices.
   */
  async list(options?: {
    language?: string;
    includePublic?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<VoiceListResponse> {
    const params = new URLSearchParams();
    if (options?.language) params.set('language', options.language);
    if (options?.includePublic !== undefined) {
      params.set('include_public', String(options.includePublic));
    }
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const query = params.toString();
    const path = query ? `/v1/voices?${query}` : '/v1/voices';
    const response = await this.client.request<{ voices: any[]; total: number; limit: number; offset: number }>('GET', path);

    return {
      voices: response.voices.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        category: v.category,
        sex: v.sex,
        age: v.age,
        quality: v.quality,
        supportedLanguages: v.supported_languages || [],
        sampleText: v.sample_text,
        avatarUrl: v.avatar_url,
        sampleUrl: v.sample_url,
        isPublic: v.is_public || false,
        verified: v.verified || false,
      })),
      total: response.total,
      limit: response.limit,
      offset: response.offset,
    };
  }

  /**
   * Get a specific voice by ID.
   */
  async get(voiceId: number): Promise<VoiceDetail> {
    const v = await this.client.request<any>('GET', `/v1/voices/${voiceId}`);
    return this.mapVoiceDetail(v);
  }

  /**
   * Create a new voice.
   */
  async create(options: CreateVoiceOptions): Promise<VoiceDetail> {
    const metadata = {
      name: options.name,
      sex: options.sex,
      description: options.description ?? '',
      category: options.category ?? 'conversational',
      age: options.age ?? 'middle_age',
      quality: options.quality ?? 'mid',
      supported_languages: options.supportedLanguages ?? ['en'],
      is_public: options.isPublic ?? false,
      sample_text: options.sampleText ?? '',
    };

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    );

    if (options.referenceFiles) {
      for (const file of options.referenceFiles) {
        formData.append('files', file);
      }
    }

    const v = await this.client.requestMultipart<any>('POST', '/v1/voices', formData);
    return this.mapVoiceDetail(v);
  }

  /**
   * Update an existing voice. Only provided fields are updated.
   */
  async update(voiceId: number, options: UpdateVoiceOptions): Promise<VoiceDetail> {
    const payload: Record<string, unknown> = {};
    if (options.name !== undefined) payload.name = options.name;
    if (options.description !== undefined) payload.description = options.description;
    if (options.category !== undefined) payload.category = options.category;
    if (options.age !== undefined) payload.age = options.age;
    if (options.sex !== undefined) payload.sex = options.sex;
    if (options.quality !== undefined) payload.quality = options.quality;
    if (options.supportedLanguages !== undefined) payload.supported_languages = options.supportedLanguages;
    if (options.isPublic !== undefined) payload.is_public = options.isPublic;
    if (options.sampleText !== undefined) payload.sample_text = options.sampleText;

    const v = await this.client.request<any>('PATCH', `/v1/voices/${voiceId}`, payload);
    return this.mapVoiceDetail(v);
  }

  /**
   * Delete a voice.
   */
  async delete(voiceId: number): Promise<void> {
    await this.client.request<any>('DELETE', `/v1/voices/${voiceId}`);
  }

  // -- Reference management --

  /**
   * List reference audio files for a voice.
   */
  async listReferences(voiceId: number): Promise<VoiceReference[]> {
    const references = await this.client.request<any[]>(
      'GET',
      `/v1/voices/${voiceId}/references`,
    );
    return references.map((r) => this.mapVoiceReference(r));
  }

  /**
   * Upload a reference audio file to a voice.
   *
   * @param voiceId - Voice ID
   * @param file - Audio file (File in browser, Blob in Node.js)
   * @param referenceText - Optional transcript of the reference audio
   */
  async addReference(
    voiceId: number,
    file: File | Blob,
    referenceText?: string,
  ): Promise<VoiceReference> {
    const formData = new FormData();
    formData.append('file', file);
    if (referenceText) {
      formData.append('reference_text', referenceText);
    }

    const r = await this.client.requestMultipart<any>(
      'POST',
      `/v1/voices/${voiceId}/references`,
      formData,
    );
    return this.mapVoiceReference(r);
  }

  /**
   * Delete a reference audio file from a voice.
   */
  async deleteReference(voiceId: number, referenceId: number): Promise<void> {
    await this.client.request<any>(
      'DELETE',
      `/v1/voices/${voiceId}/references/${referenceId}`,
    );
  }

  // -- Publishing --

  /**
   * Request publication of a voice. Sets it as public and marks it
   * as pending verification by an admin.
   */
  async publish(voiceId: number): Promise<VoiceDetail> {
    const v = await this.client.request<any>('POST', `/v1/voices/${voiceId}/publish`);
    return this.mapVoiceDetail(v);
  }

  // -- Sample generation --

  /**
   * Trigger sample audio generation for a voice.
   */
  async generateSample(voiceId: number): Promise<VoiceDetail> {
    const v = await this.client.request<any>(
      'POST',
      `/v1/voices/${voiceId}/generate-sample`,
    );
    return this.mapVoiceDetail(v);
  }

  // -- Helpers --

  private mapVoiceDetail(v: any): VoiceDetail {
    return {
      id: v.id,
      name: v.name,
      description: v.description ?? '',
      generativeVoiceDescription: v.generative_voice_description ?? '',
      supportedLanguages: v.supported_languages ?? [],
      category: v.category ?? 'cloned',
      age: v.age,
      sex: v.sex,
      quality: v.quality ?? 'mid',
      isPublic: v.is_public ?? false,
      verified: v.verified ?? false,
      pendingVerification: v.pending_verification ?? false,
      sampleUrl: v.sample_url,
      avatarUrl: v.avatar_url,
      sampleText: v.sample_text ?? '',
    };
  }

  private mapVoiceReference(r: any): VoiceReference {
    return {
      id: r.id,
      voiceId: r.voice_id,
      name: r.name ?? '',
      referenceText: r.reference_text ?? '',
      s3Path: r.s3_path ?? '',
      audioUrl: r.audio_url,
      isGenerated: r.is_generated ?? false,
    };
  }
}

/**
 * TTS resource for text-to-speech generation.
 */
class TTSResource {
  // Using any for WebSocket to support both browser WebSocket and ws package
  private wsConnection: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private wsUrl: string | null = null;
  private pendingRequests: Map<number, {
    options: GenerateOptions;
    callbacks: StreamCallbacks;
    resolve: () => void;
    reject: (error: Error) => void;
    /** Any audio chunk delivered: a replay would repeat it. */
    audioSeen: boolean;
    /** Already re-issued once after a rolling-deploy close. */
    retried: boolean;
    /** Diagnostics handle for the caller-visible operation, when telemetry runs. */
    op?: Operation;
  }> = new Map();
  private requestCounter = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private client: KugelAudio) {}

  /**
   * Pre-establish WebSocket connection for faster first request.
   * 
   * Call this at application startup to eliminate cold start latency
   * (~300-500ms) from your first TTS request.
   * 
   * @example
   * ```typescript
   * const client = new KugelAudio({ apiKey: 'your_api_key' });
   * 
   * // Pre-connect at startup
   * await client.tts.connect();
   * 
   * // First request is now fast (~100ms instead of ~500ms)
   * await client.tts.stream({ text: 'Hello' }, { onChunk: ... });
   * ```
   */
  async connect(): Promise<void> {
    await this.getConnection();
  }

  /**
   * Check if WebSocket connection is established and open.
   */
  isConnected(): boolean {
    return this.wsConnection !== null && this.wsConnection.readyState === WS_OPEN;
  }

  /**
   * Generate audio from text with streaming via WebSocket.
   * Returns complete audio after all chunks are received.
   */
  async generate(options: GenerateOptions): Promise<AudioResponse> {
    // `generate` owns the diagnostics operation and drives the pooled stream
    // directly, so a failure reports one event, not one per nested entry point.
    return this.client.diagnostics.run('generate', 'websocket', (op) =>
      this.generateImpl(options, op),
    );
  }

  private async generateImpl(
    options: GenerateOptions,
    op: Operation,
  ): Promise<AudioResponse> {
    const chunks: ArrayBuffer[] = [];
    let chunkSampleRate: number | undefined;
    let finalStats: GenerationStats | undefined;
    const allTimestamps: WordTimestamp[] = [];

    await this.streamWithPooling(options, {
      onChunk: (chunk) => {
        chunkSampleRate ??= chunk.sampleRate;
        chunks.push(base64ToArrayBuffer(chunk.audio));
      },
      onWordTimestamps: (timestamps) => {
        allTimestamps.push(...timestamps);
      },
      onFinal: (stats) => {
        finalStats = stats;
      },
    }, false, op);

    // Combine all chunks
    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    return {
      audio: combined.buffer,
      sampleRate:
        chunkSampleRate ||
        sampleRateFromOutputFormat(options.outputFormat) ||
        options.sampleRate ||
        24000,
      samples: finalStats ? finalStats.totalSamples : totalLength / 2,
      durationMs: finalStats ? finalStats.durationMs : 0,
      generationMs: finalStats ? finalStats.generationMs : 0,
      rtf: finalStats ? finalStats.rtf : 0,
      wordTimestamps: allTimestamps,
    };
  }

  /**
   * Stream audio and return a Node.js Readable stream of raw PCM16 binary data.
   *
   * **Node.js only** — this method requires the `stream` built-in module and is
   * intended for server-side integrations such as Vapi custom TTS endpoints,
   * Express/Fastify handlers, or any pipeline that expects a Node.js `Readable`.
   *
   * Compared to manually wiring `onChunk` to a `Readable`, this method avoids
   * a common race-condition: the stream object is created and returned **before**
   * any chunks arrive, so the caller can safely pipe or attach listeners before
   * the first audio byte is pushed.
   *
   * @example Vapi custom TTS endpoint
   * ```typescript
   * app.post('/synthesize', (req, res) => {
   *   res.setHeader('Content-Type', 'audio/pcm');
   *   res.setHeader('Transfer-Encoding', 'chunked');
   *
   *   const readable = client.tts.toReadable({
   *     text: req.body.message.text,
   *     modelId: 'kugel-3',
   *     sampleRate: req.body.message.sampleRate,
   *     language: 'en',
   *   });
   *
   *   readable.pipe(res);
   * });
   * ```
   *
   * @param options - TTS generation options (same as `stream()`)
   * @param reuseConnection - Reuse the pooled WebSocket connection (default: true)
   * @returns Node.js Readable stream emitting raw PCM16 binary Buffer chunks
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toReadable(options: GenerateOptions, reuseConnection = true): any {
    // Resolved at call time: browser bundles stay free of Node.js built-ins.
    const Readable = nodeReadable();
    const readable = new Readable({ read() {} });

    this.stream(
      options,
      {
        onChunk: (chunk: AudioChunk) => {
          readable.push(Buffer.from(chunk.audio, 'base64'));
        },
        onFinal: () => {
          readable.push(null);
        },
        onError: (error: Error) => {
          readable.destroy(error);
        },
      },
      reuseConnection
    ).catch((error: Error) => {
      readable.destroy(error);
    });

    return readable;
  }

  /**
   * Build the WebSocket URL with appropriate auth param.
   */
  private buildWsUrl(): string {
    const wsUrl = this.client.ttsUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');
    // Use token param for JWT tokens, master_key for master keys (bypasses billing), api_key for regular keys
    let authParam: string;
    if (this.client.isToken) {
      authParam = 'token';
    } else if (this.client.isMasterKey) {
      authParam = 'master_key';
    } else {
      authParam = 'api_key';
    }
    let url = `${wsUrl}/ws/tts?${authParam}=${this.client.apiKey}`;
    // Append org_id for token auth so usage is recorded against the org
    if (this.client.orgId !== undefined) {
      url += `&org_id=${this.client.orgId}`;
    }
    return appendSdkQuery(url);
  }

  /**
   * Get or create a WebSocket connection for connection pooling.
   * This avoids the ~220ms connect overhead on each request.
   */
  private async getConnection(op?: Operation): Promise<WebSocket> {
    // First, so everything below stays synchronous up to `this.connecting`.
    const WS = getWebSocket() ?? (await loadWebSocket());
    const url = this.buildWsUrl();

    // Return existing connection if valid
    if (
      this.wsConnection &&
      this.wsUrl === url &&
      this.wsConnection.readyState === WS_OPEN
    ) {
      return this.wsConnection;
    }

    if (this.connecting) return this.connecting;

    // Close old connection if URL changed
    if (this.wsConnection) {
      try {
        this.wsConnection.close();
      } catch {
        // Ignore close errors
      }
      this.wsConnection = null;
    }

    const ws = createWs(WS, url);
    this.wsConnection = ws;
    this.wsUrl = url;
    let opened = false;
    const pending = new Promise<WebSocket>((resolve, reject) => {
      const deadline = handshakeDeadline(ws, this.client.timeout, reject);
      ws.onopen = () => {
        if (!deadline.opened()) return;
        if (this.wsConnection !== ws) {
          ws.close();
          reject(new ConnectionError('Connection closed before ready'));
          return;
        }
        opened = true;
        // Installs its own onclose, which owns the socket from here.
        this.setupMessageHandler(ws);
        this.startKeepalive(ws);
        resolve(ws);
      };

      ws.onclose = (event) => {
        deadline.failed();
        // A server that accepts the upgrade and then closes without an error
        // event (any code outside the recognised set included) would
        // otherwise leave this handshake promise pending.
        if (opened) return;
        op?.markWsCloseCode(event.code);
        const typed = isWsErrorCloseCode(event.code)
          ? classifyWsClose(event.code, event.reason)
          : null;
        reject(
          typed ??
            new ConnectionError(
              `KugelAudio WebSocket closed before ready (code ${event.code}).`,
            ),
        );
      };

      ws.onerror = (event: unknown) => {
        deadline.failed();
        const typed = classifyWsHandshakeError(handshakeFailureOf(ws, event));
        op?.markStage(typed ? 'handshake' : 'connecting');
        reject(
          typed ??
            new ConnectionError(
              `Could not establish KugelAudio WebSocket connection to ${url}. ` +
                'Check network connectivity.',
            ),
        );
        // Master: drop the rejected upgrade's transport rather than leaking it.
        ws.close();
      };
    });
    this.connecting = pending;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) this.connecting = null;
    }
  }

  /**
   * Setup message handler for pooled connection.
   */
  private setupMessageHandler(ws: WebSocket): void {
    ws.onmessage = (event: { data: unknown }) => {
      try {
        // Handle both browser (string) and Node.js (Buffer) message formats
        const messageData = typeof event.data === 'string' 
          ? event.data 
          : event.data instanceof Buffer 
            ? event.data.toString() 
            : String(event.data);
        const data = JSON.parse(messageData);

        // Get the current pending request (we process one at a time)
        const [requestId, pending] = [...this.pendingRequests.entries()][0] || [];
        if (!pending) return;

        if (data.error) {
          const error = this.parseError(data);
          pending.op?.markServerError(error);
          pending.callbacks.onError?.(error);
          this.pendingRequests.delete(requestId);
          pending.reject(error);
          return;
        }

        if (data.final) {
          const stats: GenerationStats = {
            final: true,
            chunks: data.chunks,
            totalSamples: data.total_samples,
            durationMs: data.dur_ms,
            generationMs: data.gen_ms,
            rtf: data.rtf,
            error: data.error,
            usage: parseSessionUsage(data) ?? undefined,
          };
          pending.op?.markStage('finalizing');
          pending.callbacks.onFinal?.(stats);
          this.pendingRequests.delete(requestId);
          pending.resolve();
          return;
        }

        if (data.audio) {
          pending.audioSeen = true;
          pending.op?.recordChunk(base64ByteLength(data.audio));
          const chunk: AudioChunk = {
            audio: data.audio,
            encoding: data.enc || 'pcm_s16le',
            index: data.idx,
            sampleRate: data.sr,
            samples: data.samples,
          };
          pending.callbacks.onChunk?.(chunk);
        }

        if (data.word_timestamps) {
          const timestamps: WordTimestamp[] = data.word_timestamps.map(
            (w: Record<string, unknown>) => ({
              word: w.word as string,
              startMs: w.start_ms as number,
              endMs: w.end_ms as number,
              charStart: w.char_start as number,
              charEnd: w.char_end as number,
              score: (w.score as number) ?? 1.0,
            })
          );
          pending.callbacks.onWordTimestamps?.(timestamps);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = (event) => {
      // Clear connection pool and keepalive
      this.stopKeepalive();
      this.wsConnection = null;
      this.wsUrl = null;

      // Reject all pending requests with appropriate error types
      for (const [id, pending] of [...this.pendingRequests]) {
        this.pendingRequests.delete(id);
        pending.op?.markWsCloseCode(event.code);
        // A server-initiated error close code keeps its specific error; any
        // other code is classified below as an incomplete stream.
        const error = isWsErrorCloseCode(event.code)
          ? classifyWsClose(event.code, event.reason)
          : null;
        if (error instanceof ServerRestartingError && !pending.audioSeen && !pending.retried) {
          // Rolling deploy before any audio: re-issue the request once on a
          // fresh socket, chained to the original promise. The caller sees
          // neither the close nor the error of the replaced attempt.
          pending.op?.markRetry();
          pending.callbacks.onServerRestart?.(error);
          setTimeout(() => {
            this.streamWithPooling(pending.options, pending.callbacks, true, pending.op)
              .then(pending.resolve, pending.reject);
          }, retryDelayMs(error));
          continue;
        }
        pending.callbacks.onClose?.();
        // Anything still in `pendingRequests` never saw its `final` frame:
        // the entry is deleted the moment the stream completes. An
        // unrecognised close code (1006, 1011, or a bare 1000 arriving
        // early) therefore still has to reject, or the caller waits forever.
        const closeError = error ?? incompleteStreamError(event.code, event.reason);
        pending.callbacks.onError?.(closeError);
        pending.reject(closeError);
      }
    };

    ws.onerror = () => {
      // Reject all pending requests
      const error = new ConnectionError(
        'KugelAudio WebSocket connection error. Check network connectivity.',
      );
      for (const [id, pending] of this.pendingRequests) {
        pending.callbacks.onError?.(error);
        pending.reject(error);
        this.pendingRequests.delete(id);
      }
    };
  }

  /**
   * Stream audio from text via WebSocket.
   * Uses connection pooling for faster TTFA (~180ms vs ~400ms).
   *
   * @param options - Generation options
   * @param callbacks - Stream callbacks
   * @param reuseConnection - If true (default), reuse WebSocket connection
   */
  stream(
    options: GenerateOptions,
    callbacks: StreamCallbacks,
    reuseConnection = true
  ): Promise<void> {
    return this.client.diagnostics.run('stream', 'websocket', (op) =>
      reuseConnection
        ? this.streamWithPooling(options, callbacks, false, op)
        : this.streamWithoutPooling(options, callbacks, false, op),
    );
  }

  /**
   * Stream with connection pooling (fast path).
   *
   * `op` is threaded through the rolling-deploy replay so one caller-visible
   * failure produces exactly one diagnostics event, with the retry counted.
   */
  private async streamWithPooling(
    options: GenerateOptions,
    callbacks: StreamCallbacks,
    retry = false,
    op?: Operation,
  ): Promise<void> {
    if (!retry) warnIfNoLanguage(options.language, options.normalize);
    const ws = await this.getConnection(op);
    const requestId = ++this.requestCounter;
    op?.markStage('sending_request');

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        options, callbacks, resolve, reject, audioSeen: false, retried: retry, op,
      });

      if (!retry) callbacks.onOpen?.();

      ws.send(JSON.stringify({
        text: options.text,
        model_id: options.modelId || 'kugel-3',
        voice_id: options.voiceId,
        cfg_scale: clampCfgScale(options.cfgScale) ?? 2.0,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        max_new_tokens: options.maxNewTokens ?? 2048,
        sample_rate: options.sampleRate ?? 24000,
        ...(options.outputFormat && { output_format: options.outputFormat }),
        normalize: options.normalize ?? true,
        ...(options.language && { language: options.language }),
        ...(options.wordTimestamps && { word_timestamps: true }),
        ...(options.speed !== undefined && { speed: options.speed }),
        ...(options.projectId !== undefined && { project_id: options.projectId }),
        // [] is meaningful (explicit opt-out) and must be sent; only
        // undefined (use the project default) is omitted.
        ...(options.dictionaryIds !== undefined && { dictionary_ids: options.dictionaryIds }),
      }));
      op?.markStage('awaiting_first_audio');
    });
  }

  /**
   * Stream without connection pooling (original behavior).
   */
  private async streamWithoutPooling(
    options: GenerateOptions,
    callbacks: StreamCallbacks,
    retry = false,
    op?: Operation,
  ): Promise<void> {
    if (!retry) warnIfNoLanguage(options.language, options.normalize);
    const WS = getWebSocket() ?? (await loadWebSocket());
    return new Promise((resolve, reject) => {
      const url = this.buildWsUrl();
      const ws = createWs(WS, url);
      let opened = false;
      const deadline = handshakeDeadline(ws, this.client.timeout, reject);
      let audioSeen = false;
      // Set by every path that already settled the promise, so the close
      // that follows a completed stream stays silent.
      let settled = false;

      ws.onopen = () => {
        if (!deadline.opened()) return;
        opened = true;
        op?.markStage('sending_request');
        if (!retry) callbacks.onOpen?.();
        // Send TTS request
        ws.send(JSON.stringify({
          text: options.text,
          model_id: options.modelId || 'kugel-3',
          voice_id: options.voiceId,
          cfg_scale: clampCfgScale(options.cfgScale) ?? 2.0,
          max_new_tokens: options.maxNewTokens ?? 2048,
          sample_rate: options.sampleRate ?? 24000,
          ...(options.outputFormat && { output_format: options.outputFormat }),
          normalize: options.normalize ?? true,
          ...(options.language && { language: options.language }),
          ...(options.wordTimestamps && { word_timestamps: true }),
          ...(options.speed !== undefined && { speed: options.speed }),
          ...(options.projectId !== undefined && { project_id: options.projectId }),
          // [] is meaningful (explicit opt-out) and must be sent; only
          // undefined (use the project default) is omitted.
          ...(options.dictionaryIds !== undefined && { dictionary_ids: options.dictionaryIds }),
        }));
        op?.markStage('awaiting_first_audio');
      };

      ws.onmessage = (event: { data: unknown }) => {
        try {
          // Handle both browser (string) and Node.js (Buffer) message formats
          const messageData = typeof event.data === 'string' 
            ? event.data 
            : event.data instanceof Buffer 
              ? event.data.toString() 
              : String(event.data);
          const data = JSON.parse(messageData);

          if (data.error) {
            const error = this.parseError(data);
            op?.markServerError(error);
            callbacks.onError?.(error);
            ws.close();
            settled = true;
            reject(error);
            return;
          }

          if (data.final) {
            const stats: GenerationStats = {
              final: true,
              chunks: data.chunks,
              totalSamples: data.total_samples,
              durationMs: data.dur_ms,
              generationMs: data.gen_ms,
              rtf: data.rtf,
              error: data.error,
              usage: parseSessionUsage(data) ?? undefined,
            };
            op?.markStage('finalizing');
            callbacks.onFinal?.(stats);
            ws.close();
            settled = true;
            resolve();
            return;
          }

          if (data.audio) {
            audioSeen = true;
            op?.recordChunk(base64ByteLength(data.audio));
            const chunk: AudioChunk = {
              audio: data.audio,
              encoding: data.enc || 'pcm_s16le',
              index: data.idx,
              sampleRate: data.sr,
              samples: data.samples,
            };
            callbacks.onChunk?.(chunk);
          }

          if (data.word_timestamps) {
            const timestamps: WordTimestamp[] = data.word_timestamps.map(
              (w: Record<string, unknown>) => ({
                word: w.word as string,
                startMs: w.start_ms as number,
                endMs: w.end_ms as number,
                charStart: w.char_start as number,
                charEnd: w.char_end as number,
                score: (w.score as number) ?? 1.0,
              })
            );
            callbacks.onWordTimestamps?.(timestamps);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      ws.onerror = (event: unknown) => {
        deadline.failed();
        const handshake = opened ? null : classifyWsHandshakeError(handshakeFailureOf(ws, event));
        if (!opened) op?.markStage(handshake ? 'handshake' : 'connecting');
        const error =
          handshake ??
          new ConnectionError(
            'KugelAudio WebSocket connection error. Check network connectivity.',
          );
        callbacks.onError?.(error);
        settled = true;
        reject(error);
      };

      ws.onclose = (event) => {
        deadline.failed();
        op?.markWsCloseCode(event.code);
        const error = isWsErrorCloseCode(event.code)
          ? classifyWsClose(event.code, event.reason)
          : null;
        if (error instanceof ServerRestartingError && opened && !audioSeen && !retry) {
          // Rolling deploy before any audio: re-issue the request once on a
          // fresh socket, chained to the original promise. The caller sees
          // neither the close nor the error of the replaced attempt.
          op?.markRetry();
          callbacks.onServerRestart?.(error);
          setTimeout(() => {
            this.streamWithoutPooling(options, callbacks, true, op).then(resolve, reject);
          }, retryDelayMs(error));
          return;
        }
        callbacks.onClose?.();
        if (error) {
          callbacks.onError?.(error);
          reject(error);
          return;
        }
        if (settled) return;
        // The socket ended without a `final` frame and without a recognised
        // error code: the generation is incomplete, so the caller must get a
        // rejection rather than a promise that never settles. `stream()` runs
        // under `diagnostics.run`, which turns this into the one `op.fail`.
        const incomplete = incompleteStreamError(event.code, event.reason);
        callbacks.onError?.(incomplete);
        reject(incomplete);
      };
    });
  }

  /**
   * Start periodic keepalive pings on the pooled connection.
   * Uses the ws package's ping() in Node.js; silently skips in browsers
   * where WebSocket doesn't expose a ping method.
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    const intervalMs = this.client.keepalivePingInterval;
    if (intervalMs == null || intervalMs <= 0) return;

    this.keepaliveTimer = setInterval(() => {
      if (this.wsConnection !== ws || ws.readyState !== WS_OPEN) {
        this.stopKeepalive();
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (ws as any).ping === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ws as any).ping();
      }
    }, intervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Close the pooled WebSocket connection.
   */
  close(): void {
    this.stopKeepalive();
    if (this.wsConnection) {
      try {
        this.wsConnection.close();
      } catch {
        // Ignore close errors
      }
      this.wsConnection = null;
      this.wsUrl = null;
    }
  }

  private parseError(data: { error?: string; error_code?: string; code?: number; retry_after?: number }): Error {
    return classifyWsFrame(data);
  }

  /**
   * Create a streaming session for LLM integration.
   *
   * The session connects to `/ws/tts/stream` and keeps a persistent
   * connection across multiple {@link StreamingSession.send} calls.
   * The server auto-chunks text at sentence boundaries — no client-side
   * flushing required.
   *
   * @param config - Session configuration (voice, model, chunking strategy).
   * @param callbacks - Callbacks for audio chunks and session lifecycle events.
   * @returns A {@link StreamingSession} instance. Call `.connect()` before sending.
   *
   * @example
   * ```typescript
   * const session = client.tts.streamingSession(
   *   { voiceId: 123, autoMode: true, chunkLengthSchedule: [50, 100, 150, 250] },
   *   { onChunk: (chunk) => playAudio(chunk.audio) },
   * );
   *
   * session.connect();
   *
   * for await (const token of llmStream) {
   *   session.send(token);
   * }
   *
   * await session.close();
   * ```
   */
  streamingSession(
    config: StreamConfig,
    callbacks: StreamingSessionCallbacks
  ): StreamingSession {
    return new StreamingSession(this.client, config, callbacks);
  }

  /**
   * Create a multi-context session for concurrent TTS streams.
   *
   * Allows managing up to 20 independent audio generation contexts
   * over a single WebSocket connection. Each context has its own
   * text buffer, voice settings, and generation queue.
   *
   * @example
   * ```typescript
   * const session = client.tts.createMultiContextSession({
   *   defaultVoiceId: 123,
   * });
   *
   * session.connect({
   *   onChunk: (chunk) => {
   *     console.log(`Audio from ${chunk.contextId}`);
   *     playAudio(chunk.audio);
   *   },
   *   onContextClosed: (contextId) => {
   *     console.log(`${contextId} finished`);
   *   },
   * });
   *
   * // Create contexts with different voices
   * session.createContext('narrator', { voiceId: 123 });
   * session.createContext('character', { voiceId: 456 });
   *
   * // Send text to different speakers
   * session.send('narrator', 'The story begins.', true);
   * session.send('character', 'Hello!', true);
   *
   * // Close when done
   * session.close();
   * ```
   */
  createMultiContextSession(
    config?: import('./types').MultiContextConfig
  ): MultiContextSession {
    return new MultiContextSession(this.client, config);
  }
}

interface ContextOptions {
  voiceId?: number;
  voiceSettings?: import('./types').ContextVoiceSettings;
}

/** Frames awaiting one turn's completion acknowledgement. */
interface PendingTurn {
  frames: Record<string, unknown>[];
  audio: boolean;
  replayed: boolean;
  /** Diagnostics operation for this turn, minted when its first text is sent. */
  op?: Operation;
}

/** A flush ends the outgoing turn; later sends await a separate acknowledgement. */
function appendTurnFrame(
  turns: PendingTurn[],
  frame: Record<string, unknown>,
  mintOp?: () => Operation,
): void {
  let turn = turns[turns.length - 1];
  if (!turn || turn.frames[turn.frames.length - 1]?.flush === true) {
    turn = { frames: [], audio: false, replayed: false };
    turns.push(turn);
  }
  turn.frames.push(frame);
  if (!turn.op && mintOp && typeof frame.text === 'string' && frame.text.length > 0) {
    turn.op = mintOp();
  }
}

/** Apply `settle` to the diagnostics operation of every turn in `lists`. */
function settleTurnOps(
  lists: Iterable<PendingTurn[]>,
  settle: (op: Operation) => void,
): void {
  for (const turns of lists) {
    for (const turn of turns) if (turn.op) settle(turn.op);
  }
}

/**
 * Multi-context WebSocket session for concurrent TTS streams.
 */
class MultiContextSession {
  private ws: WebSocket | null = null;
  private config: import('./types').MultiContextConfig;
  private callbacks: import('./types').MultiContextCallbacks = {};
  private contexts: Set<string> = new Set();
  /** Contexts a create message has been sent for (not yet necessarily
   *  confirmed by the server via context_created). */
  private requestedContexts: Set<string> = new Set();
  private _sessionId: string | null = null;
  private _contextUsage: Map<string, import('./types').SessionUsage> = new Map();
  private isStarted = false;
  private closeRequested = false;
  /** createContext() options by context id, in creation order. Used to
   *  re-create contexts after a rolling-deploy reconnect and by send()'s
   *  auto-create. Dropped on context_closed / context_timeout / close(). */
  private contextOptions: Map<string, ContextOptions | undefined> = new Map();
  private contextTurns: Map<string, PendingTurn[]> = new Map();
  /** Contexts to re-create on the fresh socket, in creation order. */
  private pendingRecreate: Set<string> = new Set();
  /** True between a 1012/1013 close and the end of the transparent replay;
   *  createContext/send/flush queue meanwhile instead of throwing. */
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private client: KugelAudio,
    config?: import('./types').MultiContextConfig
  ) {
    this.config = config || {};
  }

  /** One diagnostics operation per context turn (contract "Operation scope"). */
  private readonly mintTurnOp = (): Operation =>
    this.client.diagnostics.startOperation('multi_context', 'websocket', 'awaiting_first_audio');

  /** The turn currently producing audio for `contextId`. */
  private headTurn(contextId: string | undefined): PendingTurn | undefined {
    return contextId ? this.contextTurns.get(contextId)?.[0] : undefined;
  }

  /**
   * Get the current session ID, or null if not connected.
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Per-context usage (audio time + amount charged) for a closed context, or
   * null if that context hasn't closed yet. Each context is its own
   * conversation — use this to bill per conversation. See {@link SessionUsage}.
   */
  usageFor(contextId: string): import('./types').SessionUsage | null {
    return this._contextUsage.get(contextId) ?? null;
  }

  /** Map of context_id → per-context usage for all closed contexts. */
  get contextUsage(): Map<string, import('./types').SessionUsage> {
    return new Map(this._contextUsage);
  }

  /**
   * Connect to the multi-context WebSocket endpoint.
   *
   * The returned promise resolves once the WebSocket is OPEN so callers can
   * ``await session.connect(callbacks)`` before invoking
   * {@link createContext} / {@link send}. Pre-open errors reject with the
   * typed error.
   */
  connect(callbacks: import('./types').MultiContextCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.closeRequested = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    // Establishing the connection is its own operation.
    return this.openSocket(this.client.diagnostics.startOperation('multi_context', 'websocket'));
  }

  private turns(contextId: string): PendingTurn[] {
    let turns = this.contextTurns.get(contextId);
    if (!turns) {
      turns = [];
      this.contextTurns.set(contextId, turns);
    }
    return turns;
  }

  /**
   * `connectOp` is the connection operation a pre-open failure is charged
   * to; `null` for a rolling-deploy replay, which charges the pending turns
   * it was retrying instead.
   */
  private openSocket(connectOp: Operation | null): Promise<void> {
    const WS = getWebSocket();
    if (!WS) {
      return openAfterLoad(() => this.openSocket(connectOp), () => this.closeRequested, connectOp);
    }
    const wsUrl = this.client.ttsUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');

    let authParam: string;
    if (this.client.isToken) {
      authParam = 'token';
    } else if (this.client.isMasterKey) {
      authParam = 'master_key';
    } else {
      authParam = 'api_key';
    }

    const preOpenOps = (): Operation[] => {
      if (connectOp) return [connectOp];
      const ops: Operation[] = [];
      settleTurnOps(this.contextTurns.values(), (op) => ops.push(op));
      return ops;
    };

    const url = appendSdkQuery(`${wsUrl}/ws/tts/multi?${authParam}=${this.client.apiKey}`);
    this.ws = createWs(WS, url);
    const ws = this.ws;

    ws.onmessage = (event: { data: unknown }) => {
      try {
        // Handle both browser (string) and Node.js (Buffer) message formats
        const messageData = typeof event.data === 'string' 
          ? event.data 
          : event.data instanceof Buffer 
            ? event.data.toString() 
            : String(event.data);
        const data = JSON.parse(messageData);

        if (data.error) {
          const frameErr = classifyWsFrame(data);
          // A context's error fails that context's turn; a session error
          // (no context id) fails every turn in flight.
          const failed: Operation[] = [];
          if (data.context_id) {
            const op = this.headTurn(data.context_id)?.op;
            if (op) failed.push(op);
          } else {
            settleTurnOps(this.contextTurns.values(), (op) => failed.push(op));
          }
          for (const op of failed) {
            op.markServerError(frameErr);
            op.fail(frameErr);
          }
          this.callbacks.onError?.(frameErr, data.context_id);
          return;
        }

        if (data.session_started) {
          this._sessionId = data.session_id;
          this.isStarted = true;
          this.callbacks.onSessionStarted?.(data.session_id);
        }

        if (data.context_created) {
          this.contexts.add(data.context_id);
          this.callbacks.onContextCreated?.(data.context_id);
        }

        if (data.audio) {
          const turn = this.headTurn(data.context_id);
          if (turn) turn.audio = true;
          turn?.op?.recordChunk(base64ByteLength(data.audio));
          const chunk: import('./types').MultiContextAudioChunk = {
            audio: data.audio,
            encoding: 'pcm_s16le',
            index: data.idx || 0,
            sampleRate: data.sr || 24000,
            samples: data.samples || 0,
            contextId: data.context_id,
          };
          this.callbacks.onChunk?.(chunk);
        }

        if (data.final && data.context_id) {
          // Per-context end-of-audio marker (KUG-1238): all audio admitted
          // before the client's flush has been delivered; also precedes
          // context_closed on a graceful close. Ends the context's turn.
          this.contextTurns.get(data.context_id)?.shift()?.op?.succeed();
          this.callbacks.onFinal?.(data.context_id);
        }

        if (data.context_closed) {
          // Answers the caller's close_context: an unfinished turn was
          // abandoned by the caller, not failed by the service.
          settleTurnOps([this.contextTurns.get(data.context_id) ?? []], (op) => op.cancel());
          this.contexts.delete(data.context_id);
          this.requestedContexts.delete(data.context_id);
          this.contextOptions.delete(data.context_id);
          this.contextTurns.delete(data.context_id);
          // Per-context (per-conversation) usage rides on context_closed.
          const ctxUsage = parseSessionUsage(data) ?? undefined;
          if (ctxUsage) this._contextUsage.set(data.context_id, ctxUsage);
          this.callbacks.onContextClosed?.(data.context_id, ctxUsage);
        }

        if (data.context_timeout) {
          const timeout = new KugelAudioError('KugelAudio context timed out before its turn completed.');
          settleTurnOps([this.contextTurns.get(data.context_id) ?? []], (op) => {
            op.markServerError(timeout);
            op.fail(timeout);
          });
          this.contexts.delete(data.context_id);
          this.requestedContexts.delete(data.context_id);
          this.contextOptions.delete(data.context_id);
          this.contextTurns.delete(data.context_id);
          this.callbacks.onContextTimeout?.(data.context_id);
        }

        if (data.session_closed) {
          this.callbacks.onSessionClosed?.(data);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const deadline = handshakeDeadline(ws, this.client.timeout, reject);

      ws.onopen = () => {
        if (!deadline.opened()) return;
        opened = true;
        connectOp?.succeed();
        resolve();
      };

      ws.onerror = (event: unknown) => {
        deadline.failed();
        const handshake = opened ? null : classifyWsHandshakeError(handshakeFailureOf(ws, event));
        const err =
          handshake ??
          new ConnectionError(
            'KugelAudio multi-context WebSocket connection error. ' +
              'Check network connectivity.',
          );
        if (!opened) {
          for (const op of preOpenOps()) {
            op.markStage(handshake ? 'handshake' : 'connecting');
            op.fail(err);
          }
          reject(err);
        }
        // After OPEN the close event that follows settles the turns, with
        // the close code attached.
        this.callbacks.onError?.(err);
      };

      ws.onclose = (event) => {
        deadline.failed();
        const typedErr = isWsErrorCloseCode(event.code)
          ? classifyWsClose(event.code, event.reason)
          : null;
        if (!opened) {
          const err =
            typedErr ??
            new ConnectionError(
              `KugelAudio multi-context WebSocket closed before ready ` +
                `(code ${event.code}).`,
            );
          // A failed transparent reconnect has no awaiting caller, so the
          // untyped pre-open close is surfaced through onError as well.
          if (typedErr || this.reconnecting) this.callbacks.onError?.(err);
          for (const op of preOpenOps()) {
            op.markWsCloseCode(event.code);
            op.fail(err);
          }
          reject(err);
          this.disconnect();
          return;
        }
        settleTurnOps(this.contextTurns.values(), (op) => op.markWsCloseCode(event.code));
        if (this.closeRequested) {
          settleTurnOps(this.contextTurns.values(), (op) => op.cancel());
          this.disconnect();
          return;
        }
        if (typedErr instanceof ServerRestartingError && this.prepareReplay(typedErr)) {
          this.disconnect();
          this.scheduleReplay(typedErr);
          return;
        }
        if (typedErr) this.callbacks.onError?.(typedErr);
        // A close the caller did not ask for ends the session: every turn
        // still in flight was interrupted, whatever the close code.
        if (typedErr || !isNormalWsCloseCode(event.code)) {
          const err =
            typedErr ??
            new ConnectionError(
              `KugelAudio multi-context WebSocket closed (code ${event.code}).`,
            );
          // An unrecognised code (1006, 1011) killed the session just as
          // surely as a typed one, so it is reported the same way.
          if (!typedErr) this.callbacks.onError?.(err);
          settleTurnOps(this.contextTurns.values(), (op) => op.fail(err));
        } else {
          const err = incompleteStreamError(event.code, event.reason);
          settleTurnOps(this.contextTurns.values(), (op) => op.fail(err));
        }
        this.disconnect();
      };
    });
  }

  private disconnect(): void {
    this.ws = null;
    this.isStarted = false;
    this.contexts.clear();
    this.requestedContexts.clear();
  }

  /**
   * Rolling-deploy close: a context whose turn already delivered audio, or
   * was replayed once, cannot be replayed without repeating audio. Each such
   * context gets `onError(err, contextId)` and is dropped; the next send()
   * re-creates it with its stored options. Every other open context is
   * queued for re-creation. Returns false when every context errored and
   * nothing is left to replay: then the session errors as a whole.
   */
  private prepareReplay(err: ServerRestartingError): boolean {
    const live = new Set([...this.requestedContexts, ...this.contexts]);
    let errored = 0;
    this.pendingRecreate = new Set();
    for (const id of live) {
      const turns = this.contextTurns.get(id) ?? [];
      const turn = turns[0];
      if (turn && (turn.audio || turn.replayed)) {
        errored += 1;
        settleTurnOps([turns], (op) => op.fail(err));
        this.contextTurns.delete(id);
        this.callbacks.onError?.(err, id);
      } else {
        // The replay is a retry inside each of these turns' operations.
        settleTurnOps([turns], (op) => {
          op.markRetry();
          op.markStage('connecting');
        });
        this.pendingRecreate.add(id);
      }
    }
    // Nothing is replayable: the close handler reports the session-wide
    // error, so it is not delivered a second time from here.
    if (errored > 0 && this.pendingRecreate.size === 0) return false;
    return true;
  }

  private scheduleReplay(err: ServerRestartingError): void {
    this.reconnecting = true;
    this.callbacks.onServerRestart?.(err);
    if (this.closeRequested) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.replaySession();
    }, retryDelayMs(err));
  }

  /**
   * Open a fresh socket, re-create the queued contexts in creation order
   * (the first one carries the session config again) and resend each
   * context's pending frames.
   */
  private async replaySession(): Promise<void> {
    let turnsInFlight = false;
    settleTurnOps(this.contextTurns.values(), () => { turnsInFlight = true; });
    // With no turn to charge, the reconnect is a connection operation of its own.
    const connectOp = turnsInFlight
      ? null
      : this.client.diagnostics.startOperation('multi_context', 'websocket');
    try {
      await this.openSocket(connectOp);
    } catch {
      // The socket handlers already delivered the failure through onError;
      // the session stays disconnected as after any other fatal close.
      this.reconnecting = false;
      return;
    }
    if (this.closeRequested) {
      this.ws?.close();
      this.disconnect();
      return;
    }
    this.reconnecting = false;
    const ids = [...this.pendingRecreate];
    this.pendingRecreate.clear();
    for (const id of ids) this.createContext(id, this.contextOptions.get(id));
    for (const id of ids) {
      for (const turn of this.contextTurns.get(id) ?? []) {
        turn.replayed = true;
        for (const frame of turn.frames) {
          this.ws?.send(JSON.stringify({ ...frame, context_id: id }));
        }
        turn.op?.markStage('awaiting_first_audio');
      }
    }
  }

  /** Queue work for a context while a rolling-deploy reconnect is in flight. */
  private queueDuringReconnect(contextId: string, frame?: Record<string, unknown>): void {
    if (!this.contextOptions.has(contextId)) this.contextOptions.set(contextId, undefined);
    this.pendingRecreate.add(contextId);
    if (frame) appendTurnFrame(this.turns(contextId), frame, this.mintTurnOp);
  }

  /**
   * Create a new context with optional voice settings.
   */
  createContext(
    contextId: string,
    options?: {
      voiceId?: number;
      voiceSettings?: import('./types').ContextVoiceSettings;
    }
  ): void {
    if (this.reconnecting) {
      this.contextOptions.set(contextId, options);
      this.queueDuringReconnect(contextId);
      return;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new KugelAudioError('WebSocket not connected');
    }
    this.contextOptions.set(contextId, options);
    this.requestedContexts.add(contextId);

    const msg: Record<string, unknown> = {
      text: ' ',
      context_id: contextId,
    };

    // Include session config on first context
    if (!this.isStarted) {
      warnIfNoLanguage(this.config.language, this.config.normalize);
      if (this.config.sampleRate) msg.sample_rate = this.config.sampleRate;
      if (this.config.outputFormat) msg.output_format = this.config.outputFormat;
      if (this.config.cfgScale !== undefined) msg.cfg_scale = clampCfgScale(this.config.cfgScale);
      if (this.config.temperature !== undefined) msg.temperature = this.config.temperature;
      if (this.config.maxNewTokens) msg.max_new_tokens = this.config.maxNewTokens;
      if (this.config.normalize !== undefined) msg.normalize = this.config.normalize;
      if (this.config.language) msg.language = this.config.language;
      // [] is meaningful (explicit opt-out) and must be sent; only
      // undefined (use the project default) is omitted.
      if (this.config.dictionaryIds !== undefined) msg.dictionary_ids = this.config.dictionaryIds;
      if (this.config.inactivityTimeout) msg.inactivity_timeout = this.config.inactivityTimeout;
    }

    // Per-context voice. The server binds a context's voice ONLY from
    // voice_settings.voice_id at context creation — a top-level voice_id
    // merely updates the session config and leaves the context voiceless,
    // which the server rejects with MISSING_VOICE_ID on the first text
    // (KUG-1233). This matches the Python SDK's wire format.
    const voiceSettings: Record<string, unknown> = {};
    const voiceId = options?.voiceId || this.config.defaultVoiceId;
    if (voiceId) voiceSettings.voice_id = voiceId;

    if (options?.voiceSettings) {
      voiceSettings.stability = options.voiceSettings.stability;
      voiceSettings.similarity_boost = options.voiceSettings.similarityBoost;
      voiceSettings.style = options.voiceSettings.style;
      voiceSettings.use_speaker_boost = options.voiceSettings.useSpeakerBoost;
      voiceSettings.speed = options.voiceSettings.speed;
    }
    if (Object.keys(voiceSettings).length > 0) {
      msg.voice_settings = voiceSettings;
    }

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send text to a specific context.
   */
  send(contextId: string, text: string, flush = false): void {
    if (this.reconnecting) {
      this.queueDuringReconnect(contextId, { text, flush });
      return;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new KugelAudioError('WebSocket not connected');
    }

    // Auto-create context if needed. Tracked via requestedContexts (sent
    // creates, not yet necessarily confirmed) rather than this.contexts
    // (server-confirmed) — otherwise a send() to a new context after the
    // session started goes out bare, and the server auto-creates the
    // context without voice_settings → MISSING_VOICE_ID (KUG-1233).
    // A context dropped by a rolling-deploy close keeps its stored options.
    if (!this.requestedContexts.has(contextId) && !this.contexts.has(contextId)) {
      this.createContext(contextId, this.contextOptions.get(contextId));
    }

    appendTurnFrame(this.turns(contextId), { text, flush }, this.mintTurnOp);
    this.ws.send(JSON.stringify({
      text,
      context_id: contextId,
      flush,
    }));
  }

  /**
   * Flush a context's buffer.
   */
  flush(contextId: string): void {
    if (this.reconnecting) {
      this.queueDuringReconnect(contextId, { flush: true });
      return;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    appendTurnFrame(this.turns(contextId), { flush: true });
    this.ws.send(JSON.stringify({
      flush: true,
      context_id: contextId,
    }));
  }

  /**
   * Close a specific context.
   *
   * @param contextId - The context to close.
   * @param immediate - When `true`, **barge-in**: the server cancels the
   *   context's in-flight generation immediately and discards any buffered or
   *   queued text instead of draining it. Use this when the end user speaks
   *   over the agent. When `false` (default), queued sentences finish first.
   */
  closeContext(contextId: string, immediate = false): void {
    if (this.reconnecting) {
      // Queued behind the context's pending text so it is closed on the
      // fresh socket as it would have been on the old one.
      if (this.contextOptions.has(contextId)) {
        this.queueDuringReconnect(contextId, { close_context: true, ...(immediate && { immediate }) });
      }
      return;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    const msg: Record<string, unknown> = {
      close_context: true,
      context_id: contextId,
    };
    if (immediate) {
      msg.immediate = true;
      // Barge-in: the caller cancels this context's turns, and only these.
      settleTurnOps([this.contextTurns.get(contextId) ?? []], (op) => op.cancel());
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send keep-alive to reset a context's inactivity timeout.
   */
  keepAlive(contextId: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    this.ws.send(JSON.stringify({
      text: '',
      context_id: contextId,
    }));
  }

  /**
   * Change the session's generation parameters mid-connection (KUG-1166).
   *
   * Session-scoped (there is no `contextId`): the update applies to contexts
   * started **after** it — a context already streaming keeps the settings it
   * began with, since generation parameters are bound when a context's engine
   * session opens. With the common one-context-per-turn pattern that means it
   * takes effect on the next turn. Per-context `cfgScale` / `maxNewTokens`
   * passed to {@link createContext} still win for that context.
   *
   * Resolves with the generation parameters now in effect (the server's echo).
   *
   * @throws {KugelAudioError} if no field is provided, the socket is not open,
   *   or the server rejects the update.
   */
  updateSettings(settings: SettingsUpdate): Promise<EffectiveSettings> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new KugelAudioError(
        'MultiContextSession not connected. Call connect() first.',
      );
    }
    const body = buildSettingsUpdateBody(settings);
    return sendUpdateSettings(this.ws, body).then((effective) => {
      // Mirror onto local config only after the server accepts the update, so
      // rejected values do not leak into future context creation.
      applyAcceptedSettingsUpdate(this.config as Record<string, unknown>, settings);
      return effective;
    });
  }

  /**
   * Close the session and all contexts.
   */
  close(): void {
    this.closeRequested = true;
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({ close_socket: true }));
    }
    this.ws?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.pendingRecreate.clear();
    this.contextOptions.clear();
    settleTurnOps(this.contextTurns.values(), (op) => op.cancel());
    this.contextTurns.clear();
    this.disconnect();
  }

  /**
   * Get active context IDs.
   */
  get activeContexts(): string[] {
    return Array.from(this.contexts);
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }
}

/**
 * Streaming session for LLM integration via `/ws/tts/stream`.
 *
 * The server accumulates text across multiple {@link send} calls and
 * auto-chunks it at sentence boundaries, keeping the KV cache warm between
 * chunks for natural prosody.  You never need to call `flush` explicitly —
 * configure {@link StreamConfig.chunkLengthSchedule} or
 * {@link StreamConfig.autoMode} instead.
 *
 * @example
 * ```typescript
 * const session = client.tts.streamingSession({
 *   voiceId: 123,
 *   autoMode: true,
 *   chunkLengthSchedule: [50, 100, 150, 250],
 * }, {
 *   onChunk: (chunk) => playAudio(chunk.audio),
 *   onSessionClosed: (totalSecs) => console.log(`Done: ${totalSecs}s`),
 * });
 *
 * session.connect();
 *
 * for await (const token of llmStream) {
 *   session.send(token);
 * }
 *
 * await session.close();
 * ```
 */
class StreamingSession {
  private ws: WebSocket | null = null;
  private config: StreamConfig;
  private callbacks: StreamingSessionCallbacks;
  private client: KugelAudio;
  private configSent = false;
  private _lastUsage: import('./types').SessionUsage | null = null;
  /** Outgoing turns in order, retired individually by session_closed. */
  private pendingTurns: PendingTurn[] = [];
  private closeRequested = false;
  /** True between a 1012/1013 close and the end of the transparent replay;
   *  send() queues into pendingTurns meanwhile instead of throwing. */
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves true once the reconnect replayed the turn, false if it failed. */
  private reconnectPromise: Promise<boolean> | null = null;
  /**
   * Diagnostics operation of the turn in flight: minted by the first text
   * sent after the previous turn's `final`, settled by this turn's `final`,
   * an error, or a cancellation (contract "Operation scope").
   */
  private turnOp: Operation | null = null;

  constructor(client: KugelAudio, config: StreamConfig, callbacks: StreamingSessionCallbacks) {
    this.client = client;
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Per-session usage from the most recently closed session, or null before
   * the first session closes. Use this to bill your own customers per
   * conversation. See {@link SessionUsage}.
   */
  get lastUsage(): import('./types').SessionUsage | null {
    return this._lastUsage;
  }

  /**
   * Open the WebSocket connection and authenticate.
   *
   * The returned promise resolves once the WebSocket is OPEN, so callers can
   * ``await session.connect()`` and then ``send()`` without racing the
   * handshake. Pre-open errors (network failure, 4001 unauthorized, …) reject
   * the promise with the typed error.
   */
  connect(): Promise<void> {
    this.closeRequested = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.abandonTurn();
    // Establishing the connection is its own operation.
    return this.openSocket(this.client.diagnostics.startOperation('stream_session', 'websocket'));
  }

  /** Explicit reset/cancellation abandons every pending turn. */
  private resetTurn(): void {
    this.pendingTurns = [];
  }

  /** The caller abandoned the turn in flight: a cancellation, not a failure. */
  private abandonTurn(): void {
    this.resetTurn();
    this.settleTurn((op) => op.cancel());
  }

  private settleTurn(settle: (op: Operation) => void): void {
    const op = this.turnOp;
    this.turnOp = null;
    if (op) settle(op);
  }

  /**
   * `connectOp` is the connection operation a pre-open failure is charged
   * to; `null` for a rolling-deploy replay, which charges the turn it was
   * retrying instead.
   */
  private openSocket(connectOp: Operation | null): Promise<void> {
    const WS = getWebSocket();
    if (!WS) {
      return openAfterLoad(() => this.openSocket(connectOp), () => this.closeRequested, connectOp);
    }
    const wsUrl = this.client.ttsUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');

    let authParam: string;
    if (this.client.isToken) {
      authParam = 'token';
    } else if (this.client.isMasterKey) {
      authParam = 'master_key';
    } else {
      authParam = 'api_key';
    }

    const preOpenOp = (): Operation | null => connectOp ?? this.turnOp;

    const url = appendSdkQuery(`${wsUrl}/ws/tts/stream?${authParam}=${this.client.apiKey}`);
    this.ws = createWs(WS, url);
    const ws = this.ws;

    ws.onmessage = (event: { data: unknown }) => {
      try {
        const messageData = typeof event.data === 'string'
          ? event.data
          : event.data instanceof Buffer
            ? event.data.toString()
            : String(event.data);
        const data = JSON.parse(messageData);

        if (data.error) {
          // classifyWsFrame carries error_code and the server's request_id
          // (Part A of the diagnostics contract) onto the typed error.
          const frameErr = classifyWsFrame(data);
          this.settleTurn((op) => {
            op.markServerError(frameErr);
            op.fail(frameErr);
          });
          this.callbacks.onError?.(frameErr);
          return;
        }

        if (data.audio) {
          const turn = this.pendingTurns[0];
          if (turn) turn.audio = true;
          this.turnOp?.recordChunk(base64ByteLength(data.audio));
          const chunk: AudioChunk = {
            audio: data.audio,
            encoding: data.enc || 'pcm_s16le',
            index: data.idx,
            sampleRate: data.sr,
            samples: data.samples,
          };
          this.callbacks.onChunk?.(chunk);
        }

        if (data.word_timestamps) {
          const timestamps = data.word_timestamps.map((w: Record<string, unknown>) => ({
            word: w.word as string,
            startMs: w.start_ms as number,
            endMs: w.end_ms as number,
            charStart: w.char_start as number,
            charEnd: w.char_end as number,
            score: (w.score as number) ?? 1.0,
          }));
          this.callbacks.onWordTimestamps?.(timestamps);
        }

        if (data.chunk_complete) {
          this.callbacks.onChunkComplete?.(
            data.chunk_id ?? 0,
            data.audio_seconds ?? 0,
            data.gen_ms ?? 0,
          );
        }

        if (data.generation_started) {
          this.callbacks.onGenerationStarted?.(data.chunk_id ?? 0, data.text ?? '');
        }

        if (data.interrupted) {
          this.resetTurn();
          this.callbacks.onInterrupted?.();
        }

        if (data.final) {
          // End-of-audio marker for the turn (KUG-1238) — arrives after
          // the last audio frame and before session_closed.
          this.settleTurn((op) => op.succeed());
          this.callbacks.onFinal?.(
            data.total_audio_seconds ?? 0,
            data.total_text_chunks ?? 0,
            data.total_audio_chunks ?? 0,
          );
        }

        if (data.session_closed) {
          this.pendingTurns.shift();
          this._lastUsage = parseSessionUsage(data);
          this.callbacks.onSessionClosed?.(
            data.total_audio_seconds ?? 0,
            data.total_text_chunks ?? 0,
            data.total_audio_chunks ?? 0,
          );
        }
      } catch (e) {
        console.error('[KugelAudio] Failed to parse streaming session message:', e);
      }
    };

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const deadline = handshakeDeadline(ws, this.client.timeout, reject);

      ws.onopen = () => {
        if (!deadline.opened()) return;
        opened = true;
        connectOp?.succeed();
        resolve();
      };

      ws.onerror = (event: unknown) => {
        deadline.failed();
        const handshake = opened ? null : classifyWsHandshakeError(handshakeFailureOf(ws, event));
        const err =
          handshake ??
          new ConnectionError(
            'KugelAudio streaming WebSocket connection error. ' +
              'Check network connectivity.',
          );
        if (!opened) {
          const op = preOpenOp();
          op?.markStage(handshake ? 'handshake' : 'connecting');
          op?.fail(err);
          reject(err);
        }
        // After OPEN the close event that follows settles the turn, with the
        // close code attached.
        this.callbacks.onError?.(err);
      };

      ws.onclose = (event) => {
        deadline.failed();
        const typedErr = isWsErrorCloseCode(event.code)
          ? classifyWsClose(event.code, event.reason)
          : null;
        if (!opened) {
          const err =
            typedErr ??
            new ConnectionError(
              `KugelAudio streaming WebSocket closed before ready ` +
                `(code ${event.code}).`,
            );
          // A failed transparent reconnect has no awaiting caller, so the
          // untyped pre-open close is surfaced through onError as well.
          if (typedErr || this.reconnecting) this.callbacks.onError?.(err);
          const op = preOpenOp();
          op?.markWsCloseCode(event.code);
          op?.fail(err);
          if (!connectOp) this.turnOp = null;
          reject(err);
          this.ws = null;
          this.configSent = false;
          return;
        }
        this.ws = null;
        this.configSent = false;
        this.turnOp?.markWsCloseCode(event.code);
        if (this.closeRequested && this.pendingTurns.length === 0) {
          this.abandonTurn();
          return;
        }
        if (
          typedErr instanceof ServerRestartingError &&
          !this.pendingTurns[0]?.audio &&
          !this.pendingTurns[0]?.replayed
        ) {
          // Rolling deploy with nothing audible lost: reconnect after
          // retryAfter and replay the turn. The caller never sees the deploy;
          // the replay is a retry inside the turn's operation.
          this.turnOp?.markRetry();
          this.turnOp?.markStage('connecting');
          this.scheduleReplay(typedErr);
          return;
        }
        if (typedErr) this.callbacks.onError?.(typedErr);
        if (this.closeRequested) {
          // Closed at the caller's request with a turn still in flight: that
          // is a cancellation, not a failure.
          this.abandonTurn();
        } else if (typedErr || !isNormalWsCloseCode(event.code)) {
          const err =
            typedErr ??
            new ConnectionError(
              `KugelAudio streaming WebSocket closed (code ${event.code}).`,
            );
          // An unrecognised code (1006, 1011) killed the session just as
          // surely as a typed one, so it is reported the same way.
          if (!typedErr) this.callbacks.onError?.(err);
          this.settleTurn((op) => op.fail(err));
        } else {
          // A clean close before the turn's `final`: the turn is incomplete.
          const err = incompleteStreamError(event.code, event.reason);
          this.settleTurn((op) => op.fail(err));
        }
      };
    });
  }

  private scheduleReplay(err: ServerRestartingError): void {
    this.reconnecting = true;
    this.callbacks.onServerRestart?.(err);
    this.reconnectPromise = new Promise<boolean>((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.replayTurn().then(resolve);
      }, retryDelayMs(err));
    });
  }

  /**
   * Open a fresh socket and re-send the turn's frames in order, config
   * attached to the first one again. Frames queued by send() during the gap
   * are part of pendingTurns and go out at the end.
   */
  private async replayTurn(): Promise<boolean> {
    if (this.closeRequested && this.pendingTurns.length === 0) {
      this.reconnecting = false;
      this.reconnectPromise = null;
      return false;
    }
    // With no turn to charge, the reconnect is a connection operation of its own.
    const connectOp = this.turnOp
      ? null
      : this.client.diagnostics.startOperation('stream_session', 'websocket');
    try {
      await this.openSocket(connectOp);
    } catch {
      // The socket handlers already delivered the failure through onError;
      // the session stays disconnected as after any other fatal close.
      this.reconnecting = false;
      this.reconnectPromise = null;
      return false;
    }
    this.reconnecting = false;
    this.reconnectPromise = null;
    for (const turn of this.pendingTurns) {
      turn.replayed = true;
      for (const frame of turn.frames) this.writeFrame(frame);
    }
    this.turnOp?.markStage('awaiting_first_audio');
    return true;
  }

  /** Write one turn frame, attaching the session config to the first. */
  private writeFrame(frame: Record<string, unknown>): void {
    if (!this.ws) return;
    const msg: Record<string, unknown> = { ...frame };

    if (!this.configSent) {
      if (this.config.voiceId !== undefined) msg.voice_id = this.config.voiceId;
      if (this.config.modelId !== undefined) msg.model_id = this.config.modelId;
      if (this.config.cfgScale !== undefined) msg.cfg_scale = clampCfgScale(this.config.cfgScale);
      if (this.config.temperature !== undefined) msg.temperature = this.config.temperature;
      if (this.config.maxNewTokens !== undefined) msg.max_new_tokens = this.config.maxNewTokens;
      if (this.config.sampleRate !== undefined) msg.sample_rate = this.config.sampleRate;
      if (this.config.outputFormat !== undefined) msg.output_format = this.config.outputFormat;
      if (this.config.flushTimeoutMs !== undefined) msg.flush_timeout_ms = this.config.flushTimeoutMs;
      if (this.config.maxBufferLength !== undefined) msg.max_buffer_length = this.config.maxBufferLength;
      if (this.config.normalize !== undefined) msg.normalize = this.config.normalize;
      if (this.config.language !== undefined) msg.language = this.config.language;
      if (this.config.wordTimestamps) msg.word_timestamps = true;
      if (this.config.autoMode !== undefined) msg.auto_mode = this.config.autoMode;
      if (this.config.chunkLengthSchedule?.length) msg.chunk_length_schedule = this.config.chunkLengthSchedule;
      if (this.config.speed !== undefined) msg.speed = this.config.speed;
      // [] is meaningful (explicit opt-out) and must be sent; only
      // undefined (use the project default) is omitted.
      if (this.config.dictionaryIds !== undefined) msg.dictionary_ids = this.config.dictionaryIds;
      this.configSent = true;
    }

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send a text chunk to the server (e.g. one LLM output token).
   *
   * The server buffers text across multiple calls and starts generating at
   * natural sentence boundaries automatically — no need to call `flush`.
   *
   * @param text - Raw text or LLM token to append to the server buffer.
   * @param flush - Force immediate generation of whatever is buffered.
   *   **Avoid calling this per-sentence from the client.** Doing so bypasses
   *   the server's semantic chunking, incurs a fresh model prefill cost on
   *   every flush, and makes latency *worse*, not better.  Let the server
   *   handle chunking via `chunkLengthSchedule` / `autoMode` instead.
   */
  send(text: string, flush = false): void {
    const frame: Record<string, unknown> = { text, flush };
    if (text.length > 0 && !this.turnOp && (this.reconnecting || this.isConnected)) {
      this.turnOp = this.client.diagnostics.startOperation(
        'stream_session',
        'websocket',
        'awaiting_first_audio',
      );
    }
    if (this.reconnecting) {
      // Rolling-deploy gap: the frame goes out at the end of the replay.
      appendTurnFrame(this.pendingTurns, frame);
      return;
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new KugelAudioError('StreamingSession not connected. Call connect() first.');
    }
    appendTurnFrame(this.pendingTurns, frame);
    this.writeFrame(frame);
  }

  /**
   * Interrupt (barge-in) the current generation without closing the socket.
   *
   * Use this when the end user starts speaking over the agent: it tells the
   * server to **stop generating audio for the current turn immediately** and
   * drop any text that was buffered or queued but not yet spoken. Unlike
   * {@link endSession}, no remaining text is flushed — the turn is abandoned.
   *
   * The WebSocket stays open and a fresh session is ready, so you can call
   * {@link send} for the next user turn right away (config is re-sent
   * automatically on that first `send`).
   *
   * The returned promise resolves once the server acknowledges with an
   * `interrupted` frame (which also fires
   * {@link StreamingSessionCallbacks.onInterrupted}), or after a 5 s **quiet**
   * timeout — i.e. 5 s elapse without any server message arriving. The timer
   * resets on every incoming frame, so a few in-flight audio chunks still
   * draining at the moment of cancellation do not trip it prematurely.
   *
   * @example
   * ```typescript
   * // VAD detected the user speaking over the agent:
   * await session.cancelCurrent();
   * // Socket is still open — start the next turn immediately:
   * session.send(nextLlmToken);
   * ```
   */
  cancelCurrent(): Promise<void> {
    // The turn is abandoned: a rolling-deploy close from here on reconnects
    // silently with nothing to replay.
    this.abandonTurn();
    if (!this.ws || this.ws.readyState !== WS_OPEN) return Promise.resolve();

    const ws = this.ws;
    // Quiet timeout: resets on every incoming server message. Trips only
    // when the server has been silent for this long. A short window is fine
    // here because the server cancels in-flight generation promptly; we only
    // need to outlast a handful of already-emitted audio frames in transit.
    const QUIET_TIMEOUT_MS = 5_000;

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const prevMessage = ws.onmessage;
      const prevClose = ws.onclose;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Restore the original handlers so subsequent calls don't stack
        // wrappers and the typed-error onclose installed by connect() stays
        // in effect for the next turn.
        ws.onmessage = prevMessage;
        ws.onclose = prevClose;
        // The server starts a fresh session after a cancel, so the next
        // send() must re-send config.
        this.configSent = false;
        resolve();
      };

      const armQuietTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(done, QUIET_TIMEOUT_MS);
      };

      armQuietTimer();

      ws.onmessage = (event: MessageEvent) => {
        // Reset the quiet timer on EVERY incoming frame — late audio chunks
        // from the cancelled turn count as liveness, not just the ack.
        armQuietTimer();
        if (prevMessage) prevMessage.call(ws, event);
        try {
          const raw = typeof event.data === 'string'
            ? event.data
            : event.data instanceof Buffer
              ? event.data.toString()
              : String(event.data);
          if (JSON.parse(raw).interrupted) done();
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = (event: CloseEvent) => {
        this.ws = null;
        if (prevClose) prevClose.call(ws, event);
        done();
      };

      ws.send(JSON.stringify({ cancel: true }));
    });
  }

  /**
   * End the current session but keep the WebSocket connection open.
   *
   * This allows starting a new session on the same connection, avoiding
   * the overhead of a new WebSocket handshake (~200-300ms). After calling
   * this, optionally call {@link updateConfig} to change voice/model settings,
   * then call {@link send} to start the next session.
   *
   * The returned promise resolves once the server confirms with a
   * `session_closed` message, or after a 15 s **quiet** timeout — i.e. 15 s
   * elapse without *any* server message arriving. The timer resets on every
   * incoming frame so a long final flush that streams audio for tens of
   * seconds is not truncated; only a genuinely silent server trips the fuse.
   */
  endSession(): Promise<void> {
    if (this.reconnectPromise) {
      // Rolling-deploy gap: end the session on the fresh socket once the
      // queued turn has been replayed there.
      return this.reconnectPromise.then((ok) => (ok ? this.endSession() : undefined));
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) return Promise.resolve();

    const ws = this.ws;
    // Quiet timeout: resets on every incoming server message. Trips only when
    // the server has been silent for this long. The previous wall-clock fuse
    // (10 s total) silently truncated audio when the final flushed chunk
    // took longer to generate than the budget — see fix in this commit.
    const QUIET_TIMEOUT_MS = 15_000;

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let restoreHandlers: () => void = () => {};

      const done = (acknowledged = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Restore the original handlers so subsequent endSession() calls
        // don't stack wrappers and so the typed-error onclose installed
        // by connect() remains in effect for the next session.
        restoreHandlers();
        this.configSent = false;
        // The normal handler already retired the acknowledged turn. Its
        // completion callback may have sent text for the next one.
        if (!acknowledged) this.abandonTurn();
        resolve();
      };

      const armQuietTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(done, QUIET_TIMEOUT_MS);
      };

      // Wrap one socket's handlers and send the close request on it. A
      // rolling-deploy close mid-handshake replays the turn on a fresh socket;
      // the same wrappers are then attached there and the close re-sent.
      const attach = (sock: WebSocket) => {
        const prevMessage = sock.onmessage;
        const prevClose = sock.onclose;
        restoreHandlers = () => {
          sock.onmessage = prevMessage;
          sock.onclose = prevClose;
        };
        armQuietTimer();

        sock.onmessage = (event: MessageEvent) => {
          // Reset the quiet timer on EVERY incoming frame — audio chunks for
          // the final flush count as liveness, not just session_closed.
          armQuietTimer();
          if (prevMessage) prevMessage.call(sock, event);
          try {
            const raw = typeof event.data === 'string'
              ? event.data
              : event.data instanceof Buffer
                ? event.data.toString()
                : String(event.data);
            if (JSON.parse(raw).session_closed) done(true);
          } catch { /* ignore parse errors */ }
        };

        sock.onclose = (event: CloseEvent) => {
          this.ws = null;
          if (prevClose) prevClose.call(sock, event);
          const replay = this.reconnectPromise;
          if (!replay) {
            done();
            return;
          }
          clearTimeout(timer);
          replay.then((ok) => {
            if (ok && this.ws) attach(this.ws);
            else done();
          });
        };

        sock.send(JSON.stringify({ close: true }));
      };

      attach(ws);
    });
  }

  /**
   * Update session configuration for the next session.
   *
   * Call this after {@link endSession} and before the next {@link send}
   * to change voice, model, language, or other settings.
   */
  updateConfig(config: Partial<StreamConfig>): void {
    Object.assign(this.config, config);
    this.configSent = false;
    this.abandonTurn();
  }

  /**
   * Change generation parameters mid-connection without reconnecting (KUG-1166).
   *
   * Sends an `update_settings` message and resolves with the generation
   * parameters now in effect (the server's echo). Only the six fields of
   * {@link SettingsUpdate} are updatable; identity / audio-format fields
   * (`voiceId`, `modelId`, `sampleRate`, `outputFormat`, `dictionaryIds`) are
   * fixed for the connection — change those with {@link updateConfig} after
   * {@link endSession} instead.
   *
   * The change applies to the **next turn**: a turn already streaming keeps the
   * settings it started with, so call this between turns.
   *
   * @example
   * ```typescript
   * const effective = await session.updateSettings({ cfgScale: 1.5, speed: 1.1 });
   * ```
   *
   * @throws {KugelAudioError} if no field is provided, the socket is not open,
   *   or the server rejects the update (e.g. a value out of range).
   */
  updateSettings(settings: SettingsUpdate): Promise<EffectiveSettings> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new KugelAudioError(
        'StreamingSession not connected. Call connect() first.',
      );
    }
    const body = buildSettingsUpdateBody(settings);
    return sendUpdateSettings(this.ws, body).then((effective) => {
      // Keep the local config in sync only after the server accepts the
      // change; rejected updates must not poison later config re-sends.
      applyAcceptedSettingsUpdate(this.config as Record<string, unknown>, settings);
      return effective;
    });
  }

  /**
   * Close the session and the WebSocket connection.
   *
   * For session reuse without closing the connection, use
   * {@link endSession} instead.
   *
   * The returned promise resolves once the server confirms the close with a
   * `session_closed` message, or after a 15 s **quiet** timeout (no traffic
   * from the server in that window). Audio frames from the server-side
   * final-flush of the still-buffered text are delivered to your callbacks
   * before this promise resolves, and each frame resets the quiet timer.
   */
  async close(): Promise<void> {
    this.closeRequested = true;
    await this.endSession();
    this.abandonTurn();

    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  /** Whether the underlying WebSocket is open. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }
}

/**
 * KugelAudio API client.
 *
 * @example
 * ```typescript
 * const client = new KugelAudio({ apiKey: 'your_api_key' });
 *
 * // List models
 * const models = await client.models.list();
 *
 * // List voices
 * const voices = await client.voices.list();
 *
 * // Generate audio
 * const audio = await client.tts.generate({
 *   text: 'Hello, world!',
 *   modelId: 'kugel-3',
 * });
 * ```
 */
export class KugelAudio {
  private _apiKey: string;
  private _isMasterKey: boolean;
  private _isToken: boolean;
  private _orgId: number | undefined;
  private _apiUrl: string;
  private _ttsUrl: string;
  private _timeout: number;
  private _keepalivePingInterval: number | null;
  private _diagnostics: Diagnostics;

  /** Models resource */
  public readonly models: ModelsResource;
  /** Voices resource */
  public readonly voices: VoicesResource;
  /** Custom dictionaries resource */
  public readonly dictionaries: DictionariesResource;
  /** TTS resource */
  public readonly tts: TTSResource;
  /** Speech-to-text resource */
  public readonly asr: ASRResource;

  constructor(options: KugelAudioOptions) {
    if (!options.apiKey) {
      throw new ValidationError(
        'KugelAudio API key is missing. Pass { apiKey: ... } to the client. ' +
          'Get a key at https://app.kugelaudio.com/settings/api-keys.',
      );
    }

    const { cleanKey, detectedRegion } = parseApiKey(options.apiKey);
    this._apiKey = cleanKey;
    this._isMasterKey = options.isMasterKey || false;
    this._isToken = options.isToken || false;
    this._orgId = options.orgId;

    if (options.apiUrl) {
      this._apiUrl = options.apiUrl.replace(/\/$/, '');
    } else {
      const effectiveRegion = options.region || detectedRegion;
      if (!effectiveRegion) {
        this._apiUrl = DEFAULT_API_URL;
      } else if (!SUPPORTED_REGIONS.includes(effectiveRegion as Region)) {
        throw new ValidationError(
          `Invalid region '${effectiveRegion}'. Must be one of: ${SUPPORTED_REGIONS.join(', ')}.`,
        );
      } else {
        this._apiUrl = effectiveRegion === 'eu' ? EU_API_URL : DEFAULT_API_URL;
      }
    }

    // If ttsUrl not specified, use apiUrl (backend proxies to TTS server)
    this._ttsUrl = (options.ttsUrl || this._apiUrl).replace(/\/$/, '');
    this._timeout = options.timeout || 60000;
    this._keepalivePingInterval = options.keepalivePingInterval !== undefined
      ? options.keepalivePingInterval
      : 20000;

    this._diagnostics = new Diagnostics({
      apiUrl: this._apiUrl,
      sdkVersion: SDK_VERSION,
      // Diagnostics ride this same host with these same credentials; the
      // reporter builds no auth of its own.
      authHeaders: authHeaders(this._apiKey),
      telemetry: options.telemetry,
    });

    this.models = new ModelsResource(this);
    this.voices = new VoicesResource(this);
    this.dictionaries = new DictionariesResource(this);
    this.asr = new ASRResource(this);
    this.tts = new TTSResource(this);
  }

  /**
   * Create a pre-connected KugelAudio client.
   * 
   * Use this factory method to get a client that's already connected
   * and ready for fast TTS requests. This eliminates cold start latency
   * (~300-500ms) from your first TTS request.
   * 
   * @example
   * ```typescript
   * // Client is ready immediately - no cold start on first request
   * const client = await KugelAudio.create({ apiKey: 'your_api_key' });
   * 
   * // First request is fast (~100ms instead of ~500ms)
   * await client.tts.stream({ text: 'Hello' }, { onChunk: ... });
   * ```
   */
  static async create(options: KugelAudioOptions): Promise<KugelAudio> {
    const client = new KugelAudio(options);
    await client.connect();
    return client;
  }

  /** HTTP request and WebSocket opening budget, in milliseconds. */
  get timeout(): number { return this._timeout; }

  /** Get API key */
  get apiKey(): string {
    return this._apiKey;
  }

  /** Check if using master key authentication */
  get isMasterKey(): boolean {
    return this._isMasterKey;
  }

  /** Check if using JWT token authentication */
  get isToken(): boolean {
    return this._isToken;
  }

  /** Get organisation ID for billing */
  get orgId(): number | undefined {
    return this._orgId;
  }

  /** Get TTS URL */
  get ttsUrl(): string {
    return this._ttsUrl;
  }

  /** Get keepalive ping interval in milliseconds, or null if disabled. */
  get keepalivePingInterval(): number | null {
    return this._keepalivePingInterval;
  }

  /**
   * Client-error diagnostics reporter.
   *
   * Inert unless telemetry is enabled (see `KugelAudioOptions.telemetry`);
   * reports go to `<apiUrl>/v1/sdk-diagnostics` with this client's own auth.
   * @internal
   */
  get diagnostics(): Diagnostics {
    return this._diagnostics;
  }

  /**
   * Close the client and release resources.
   * This closes any pooled WebSocket connections.
   *
   * Diagnostics are flushed best-effort in the background (<=1 s deadline);
   * the flush is deliberately not awaited so this stays synchronous.
   */
  close(): void {
    this.tts.close();
    void this._diagnostics.close();
  }

  /**
   * Pre-establish WebSocket connection for faster first request.
   * 
   * Call this at application startup to eliminate cold start latency
   * (~300-500ms) from your first TTS request.
   * 
   * @example
   * ```typescript
   * const client = new KugelAudio({ apiKey: 'your_api_key' });
   * 
   * // Pre-connect at startup
   * await client.connect();
   * 
   * // First request is now fast (~100ms instead of ~500ms)
   * await client.tts.stream({ text: 'Hello' }, { onChunk: ... });
   * ```
   */
  async connect(): Promise<void> {
    await this.tts.connect();
  }

  /**
   * Check if WebSocket connection is established and open.
   */
  isConnected(): boolean {
    return this.tts.isConnected();
  }

  /**
   * Make an HTTP request to the API.
   * @internal
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this._diagnostics.run(operationForPath(path), 'http', (op) =>
      this.sendRequest<T>(method, path, body, op),
    );
  }

  private async sendRequest<T>(
    method: string,
    path: string,
    body: unknown,
    op: Operation,
  ): Promise<T> {
    const url = `${this._apiUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders(this._apiKey),
      ...sdkHeaders(),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      op.markStage('sending_request');

      if (!response.ok) {
        const text = await response.text();
        throw classifyHttpError(response.status, text, response.headers);
      }

      op.markStage('finalizing');
      return await parseJsonBody<T>(response);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof KugelAudioError) {
        throw error;
      }
      if ((error as Error).name === 'AbortError') {
        throw new ConnectionError(
          `Request to ${method} ${path} timed out after ${this._timeout}ms.`,
        );
      }
      throw new ConnectionError(
        `Could not reach KugelAudio at ${url}: ${(error as Error).message}. ` +
          'Check network connectivity.',
      );
    }
  }

  /**
   * Make a multipart/form-data request (for file uploads).
   * @internal Used by VoicesResource for reference file uploads.
   */
  async requestMultipart<T>(method: string, path: string, formData: FormData): Promise<T> {
    return this._diagnostics.run(operationForPath(path), 'http', (op) =>
      this.sendMultipart<T>(method, path, formData, op),
    );
  }

  private async sendMultipart<T>(
    method: string,
    path: string,
    formData: FormData,
    op: Operation,
  ): Promise<T> {
    const url = `${this._apiUrl}${path}`;

    const headers: Record<string, string> = {
      ...authHeaders(this._apiKey),
      ...sdkHeaders(),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      op.markStage('sending_request');

      if (!response.ok) {
        const text = await response.text();
        throw classifyHttpError(response.status, text, response.headers);
      }

      op.markStage('finalizing');
      return await parseJsonBody<T>(response);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof KugelAudioError) {
        throw error;
      }
      if ((error as Error).name === 'AbortError') {
        throw new ConnectionError(
          `Request to ${method} ${path} timed out after ${this._timeout}ms.`,
        );
      }
      throw new ConnectionError(
        `Could not reach KugelAudio at ${url}: ${(error as Error).message}. ` +
          'Check network connectivity.',
      );
    }
  }
}
