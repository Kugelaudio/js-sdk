# KugelAudio TypeScript/JavaScript SDK

Official TypeScript/JavaScript SDK for the [KugelAudio](https://kugelaudio.com)
Text-to-Speech API — one-shot generation, WebSocket streaming, LLM sessions,
voice cloning, dictionaries, and word timestamps.

📖 **[Full documentation →](https://docs.kugelaudio.com/sdks/javascript/quickstart)**

## Installation

```bash
npm install kugelaudio    # or: yarn add kugelaudio / pnpm add kugelaudio
```

Types ship inside the package; ESM and CommonJS builds are both included.

## Quick start

```typescript
import { KugelAudio } from 'kugelaudio';

const client = new KugelAudio({ apiKey: 'your_api_key' });

const audio = await client.tts.generate({
  text: 'Hello, world!',
  modelId: 'kugel-3',
  voiceId: 1071,
  language: 'en',   // skip auto-detection (~150ms) when you know the language
});

// audio.audio is an ArrayBuffer of PCM16 (or the requested outputFormat)
console.log(`${audio.durationMs}ms in ${audio.generationMs}ms (RTF ${audio.rtf})`);
```

[`kugel-3`](https://docs.kugelaudio.com/models) is the current model; legacy IDs
(`kugel-1-turbo`, `kugel-2.5`, …) are still accepted.

## Streaming

```typescript
await client.tts.stream(
  { text: 'Hello, this is streaming audio.', voiceId: 1071 },
  {
    onChunk: (chunk) => playAudio(chunk.audio),   // base64 PCM16
    onFinal: (stats) => console.log(`RTF ${stats.rtf}`),
  },
);
```

For text arriving from an LLM, use a streaming session: forward raw tokens and
the server chunks them at sentence boundaries.

```typescript
const session = client.tts.streamingSession(
  { voiceId: 1071, language: 'en' },
  { onChunk: (chunk) => playAudio(chunk.audio) },
);
await session.connect();

for await (const token of llmTokenStream) {
  session.send(token);        // no flush per token
}
await session.close();        // final flush + close
```

> ⚠️ Do **not** call `session.send(text, true)` between sentences. Every explicit
> flush is a separate request that pays time-to-first-audio again and leaves an
> audible gap — see
> [Chunking & latency](https://docs.kugelaudio.com/streaming/chunking-and-latency).

More: [barge-in](https://docs.kugelaudio.com/streaming/barge-in) ·
[multi-context](https://docs.kugelaudio.com/streaming/multi-context) ·
[word timestamps](https://docs.kugelaudio.com/streaming/word-timestamps)

## LiveKit Agents

```bash
npm install kugelaudio @livekit/agents @livekit/rtc-node
```

```typescript
import { TTS as KugelAudioTTS } from 'kugelaudio/livekit';

const tts = new KugelAudioTTS({ model: 'kugel-3', voiceId: 1071, language: 'en' });
tts.on('error', ({ error }) => console.error('Synthesis failed:', error));
tts.prewarm();   // open the WebSocket ahead of the first response
```

`@livekit/agents` and `@livekit/rtc-node` are optional peer dependencies. See the
[LiveKit guide](https://docs.kugelaudio.com/integrations/livekit) and
`examples/livekit_agent.ts`.

The plugin reports synthesis failures through its `error` event, retaining the
server's status code and error body. A session-wide WebSocket error fails every
pending context and retires the connection; the next synthesis opens a fresh one.

Once a streaming context starts reading input, a failure ends that turn without
automatic replay. Start a new stream and resend the text you still want spoken.
One-shot `synthesize()` calls retain their configured retry budget, and exhausted
retries report one terminal error without an unhandled promise rejection.

> **Pipecat** is Python-only — use the Python SDK's `kugelaudio.pipecat`, or
> LiveKit above for a server-side JS/TS agent.

## Regions

`api.kugelaudio.com` is geo-routed by default. To pin traffic to the EU, prefix
the key (`eu-ka_…`) or pass `region: 'eu'` —
[details](https://docs.kugelaudio.com/guides/regions).

## Agent skill

If you build with a coding agent, install the bundled skill so it gets the TTFA
rules, streaming semantics, and text-formatting constraints without you
re-explaining them:

```bash
npx kugelaudio-skills install     # → ./.claude/skills/kugelaudio-tts/
```

`--global` installs to `~/.claude/skills/`, `--dest <dir>` picks another target.

## Audio helpers

`base64ToArrayBuffer(chunk.audio)` decodes a streamed chunk,
`decodePCM16(chunk.audio)` gives a `Float32Array` for the Web Audio API, and
`createWavFile(pcm, 24000)` / `createWavBlob(pcm, 24000)` wrap PCM16 in a WAV
header for playback or download. All are named exports of `kugelaudio`.

## Errors

All errors extend `KugelAudioError`: `AuthenticationError`, `RateLimitError`,
`InsufficientCreditsError`, `ValidationError`, `NotFoundError`, `ConnectionError`.
`ServerRestartingError` (a `ConnectionError` with `retryAfter = 1`) covers a
rolling deploy closing the WebSocket with code 1012 or refusing it with 1013.
The SDK handles that case for you: if no audio for the turn has gone out yet it
reconnects after `retryAfter` and replays the turn transparently, firing the
optional `onServerRestart` callback. It is only raised when audio had already
started, or when the turn was replayed once already.

```typescript
import { AuthenticationError, RateLimitError } from 'kugelaudio';
```

See the [error reference](https://docs.kugelaudio.com/api-reference/errors).

## Documentation

| Topic | Link |
|---|---|
| Client options, auth, regions | [Configuration](https://docs.kugelaudio.com/sdks/javascript/configuration) |
| Generation parameters | [Generate](https://docs.kugelaudio.com/sdks/javascript/generate) |
| Streaming & LLM sessions | [Streaming](https://docs.kugelaudio.com/sdks/javascript/streaming) |
| Normalization & languages | [Text normalization](https://docs.kugelaudio.com/sdks/javascript/normalization) |
| List, create, clone voices | [Voices](https://docs.kugelaudio.com/sdks/javascript/voices) |
| Pronunciation dictionaries | [Dictionaries](https://docs.kugelaudio.com/sdks/javascript/dictionaries) |
| Types & audio utilities | [Types](https://docs.kugelaudio.com/sdks/javascript/types) |

## License

MIT
