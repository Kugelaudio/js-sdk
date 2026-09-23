/**
 * Utility functions for KugelAudio SDK.
 */

/**
 * Accepted classifier-free guidance band. Values outside [MIN, MAX] are
 * clamped into the band (both client-side and by the server).
 */
export const MIN_CFG_SCALE = 1.2;
export const MAX_CFG_SCALE = 2.5;

/**
 * Clamp `cfgScale` into [1.2, 2.5]. `undefined` passes through unchanged
 * (the server default is applied).
 */
export function clampCfgScale(cfgScale: number | undefined): number | undefined {
  if (cfgScale === undefined) return undefined;
  return Math.min(MAX_CFG_SCALE, Math.max(MIN_CFG_SCALE, cfgScale));
}

/**
 * The SDK's HTTP auth headers for a resolved (region-prefix-stripped) API key.
 *
 * Single source of truth: every authenticated HTTP call the SDK makes —
 * including the diagnostics POST — sends exactly these, so diagnostics never
 * needs a credential or a scheme of its own.
 */
export function authHeaders(apiKey: string): Record<string, string> {
  return {
    'X-API-Key': apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Decode base64 string to ArrayBuffer.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Handle browser and Node.js
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } else {
    // Node.js
    const buffer = Buffer.from(base64, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
}

/**
 * Encode ArrayBuffer to base64 string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } else {
    // Node.js
    return Buffer.from(bytes).toString('base64');
  }
}

/**
 * Decode PCM16 base64 audio to Float32Array.
 */
export function decodePCM16(base64: string): Float32Array {
  const buffer = base64ToArrayBuffer(base64);
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  
  return float32;
}

/**
 * Create a WAV file from PCM16 audio data.
 */
export function createWavFile(audio: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const dataSize = audio.byteLength;
  const fileSize = 44 + dataSize; // WAV header is 44 bytes

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);        // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);         // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true);         // NumChannels (1 for mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true);         // BlockAlign
  view.setUint16(34, 16, true);        // BitsPerSample

  // data subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Copy audio data
  const audioBytes = new Uint8Array(audio);
  const wavBytes = new Uint8Array(buffer);
  wavBytes.set(audioBytes, 44);

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Create a Blob from WAV data for browser use.
 */
export function createWavBlob(audio: ArrayBuffer, sampleRate: number): Blob {
  const wavBuffer = createWavFile(audio, sampleRate);
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

/**
 * Check if running in browser environment.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Check if running in Node.js environment.
 */
export function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
}

