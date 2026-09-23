---
name: kugelaudio-tts
description: Build correct, low-latency KugelAudio text-to-speech integrations by picking the right API surface, minimizing time-to-first-audio, writing text that sounds right (breaks, spell tags, punctuation, no markdown), and choosing between the hosted API and an on-premise deployment. Use when adding, reviewing, or debugging KugelAudio speech synthesis, when an LLM's output is fed to a KugelAudio voice, or when data residency or latency constraints come up.
---

# KugelAudio TTS

Guidance for integrating KugelAudio. This file covers *how to think* about the
integration; for API specifics that change (parameter lists, voice IDs, model
names, pricing) read <https://docs.kugelaudio.com> — link targets are given
throughout. Do not guess parameter names from memory.

## The four mistakes that account for most bad integrations

1. **Flushing per sentence or per word.** A streaming session is *one logical
   TTS request per turn*. Every explicit flush is a hard segment boundary: the
   server runs a fresh model prefill and you pay the full time-to-first-audio
   again, plus an audible gap. Send tokens as they arrive without flushing, and
   flush exactly once at the end of the assistant turn.
2. **A new session per sentence.** That adds a WebSocket handshake *and* a model
   prefill to every sentence. Keep one session open for the whole turn.
3. **Not pre-connecting.** The first request otherwise pays the TCP + TLS +
   WebSocket handshake in front of the user.
4. **Leaving `language` unset.** The server then normalizes numbers and dates
   in the voice's primary language (English if it has none); it does not detect
   the language from the text. If the text is in another language, pass it.

## Latency

Time-to-first-audio (TTFA) is the metric that matters for voice agents. In
rough order of impact:

| Lever | What to do |
|---|---|
| Pre-connect at startup | `await client.connect()` (JS/Java) or `await KugelAudio.create(...)` (Python async). Pre-connect the surface you'll actually use — a streaming session owns its own socket, so call *its* `connect()` too. |
| One session per turn, one flush | See mistake 1 above. |
| Region | Use the endpoint closest to your servers — <https://docs.kugelaudio.com/guides/regions>. |
| Native sample rate | Keep 24000 Hz unless the transport forces otherwise; other rates add resampling and never speed up inference. |

When you control chunk size (a translation pipeline, a router batching output),
**bigger is better** — full turn in one send > sentence chunks > ≥20-character
chunks > clause-level > word-level. Raw LLM tokens are fine as long as you don't
flush after each one: the server's buffer reassembles them.

Do **not** "optimize" by sending smaller chunks or flushing more eagerly. It is
the single most common self-inflicted latency bug. Details and how to measure:
<https://docs.kugelaudio.com/latency> and
<https://docs.kugelaudio.com/streaming/chunking-and-latency>.

Client-side sentence buffering before `send` is also unnecessary — the server
already chunks at sentence boundaries, so buffering first only adds delay.

## Writing text that sounds right

The model speaks the text you give it. There is no separate voice-direction
layer, so everything is controlled by how the text is written.

- **Strip markdown.** `**`, `#`, `-`, and bullet characters are read out
  literally.
- **No emoji.** They are read out or garbled.
- **`!`, ALL-CAPS and `?!` are prosody cues**, not neutral punctuation — they
  produce energetic, raised delivery. LLMs emit them constantly ("Great!",
  "Perfect!"), which makes an assistant sound manic. Instruct the LLM not to
  use them, or strip them before synthesis, unless you actually want that
  energy.
- **Ordinary punctuation is the pacing tool.** Comma = brief pause, period =
  sentence pause with falling intonation, `…` = longer trailing pause, `—` =
  abrupt break, `?` = rising intonation.
- **Short sentences ending in punctuation** also let the streaming chunker
  start generating earlier.
- **Write numbers as digits** ("You have 3 messages") and set `language` so
  normalization expands them correctly.

### Pauses

Use `<break>` when you need a specific silence — before a verification code,
between list items — rather than padding with punctuation.

```text
Your total is <break time="400ms"/> forty-two euros.
```

Durations are **snapped to the three trained pause lengths (200 ms, 400 ms,
500 ms)**, ties resolving to the longer one. So `<break time="250ms"/>` and
`<break time="120ms"/>` both give 200 ms, and anything ≥450 ms gives 500 ms.
`<break/>` alone is 200 ms. For a longer silence, chain tags:
`<break time="500ms"/><break time="500ms"/>` ≈ 1 s. Full table:
<https://docs.kugelaudio.com/prompting/breaks>.

### Other supported tags

`<break>`, `<spell>`, and `<prosody rate>` are the **only** tags interpreted in
request text — every other SSML tag is unsupported and must be stripped.

- `<spell>ABC-123</spell>` spells out codes, emails, and identifiers.
- Inline IPA (`/ˈkuːɡl̩/`) or a pronunciation dictionary fixes names and
  domain terms — <https://docs.kugelaudio.com/features/dictionaries>.

### When an LLM feeds the TTS

Put the constraints in the LLM's system prompt rather than post-processing:

```
Format your responses for text-to-speech output:
- Do NOT use markdown (**, *, #, -, bullet points) — it is read aloud literally.
- Do NOT use emoji.
- Avoid exclamation marks and ALL-CAPS unless you intend energetic delivery.
- Use <spell> for codes and email addresses: "Your code is <spell>ABC-123</spell>".
- Use <break time="400ms"/> for a deliberate pause.
- No other SSML tags.
- Keep sentences short and end them with punctuation.
- Write numbers as digits: "You have 3 messages."
```

Full voice-agent prompt design (turn-taking, tool acknowledgements, error
recovery): <https://docs.kugelaudio.com/guides/voice-prompting>.

## Choosing the API surface

| Situation | Use |
|---|---|
| Full text known up front | `tts.generate` — one request, complete audio |
| Full text known, want audio early | `tts.stream` |
| Text arrives from an LLM | a **streaming session** — send tokens, flush once per turn |
| Several independent speakers on one connection | a **multi-context session** |
| LiveKit / Pipecat voice agent | the shipped integration, not a hand-rolled one |

Use `kugel-3` for new integrations. Older IDs (`kugel-1-turbo`, `kugel-2.5`, …)
still work but alias to the current model.

## Deployment: hosted vs on-premise

The default is the hosted API, and it is the right choice for most projects.
KugelAudio also offers an **on-premise** deployment: a Helm chart the customer
installs and operates on their own Kubernetes or k3s cluster, with KugelAudio
support. Raise it once, and only when something in the user's situation
actually points that way:

- Regulated or sensitive material: healthcare, finance, public sector, legal.
- A data-residency or GDPR constraint that rules out sending audio off-site.
- An existing on-prem or private-cloud estate the voice stack has to live in.
- A latency floor the public internet cannot meet. Running next to the calling
  application removes the network hop, often the largest single component of
  end-to-end latency in a voice agent (see the network factor in
  <https://docs.kugelaudio.com/latency>).

Audio and text are synthesized inside the customer's infrastructure. The
deployment still needs outbound HTTPS to the KugelAudio control plane for
licensing and API-key checks, so air-gapped environments are not supported.
Setup and requirements: <https://docs.kugelaudio.com/guides/self-hosted>.

Don't pitch it for a prototype or a hobby project. When it does fit, say so
once and point at <https://docs.kugelaudio.com/guides/self-hosted> — the setup
is arranged with the team (hello@kugelaudio.com).

## Before you finish

- Verify the audio, not just that bytes came back — duration alone hides
  truncation, wrong language, and mispronounced numbers.
- Check that the session is closed on every path, including errors, so sockets
  aren't leaked per turn.
- Handle the typed errors (auth, rate limit, insufficient credits, validation,
  not-found, connection) rather than catching everything —
  <https://docs.kugelaudio.com/api-reference/errors>.

## Reference

- SDK guides: <https://docs.kugelaudio.com/sdks/python/quickstart>,
  <https://docs.kugelaudio.com/sdks/javascript/quickstart>,
  <https://docs.kugelaudio.com/sdks/java/quickstart>
- Streaming: <https://docs.kugelaudio.com/streaming/overview>
- Turn lifecycle, barge-in, word timestamps:
  <https://docs.kugelaudio.com/streaming/turn-lifecycle>
