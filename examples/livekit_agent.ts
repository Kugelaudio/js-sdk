/**
 * Minimal LiveKit Agents (Node.js) worker using KugelAudio TTS.
 *
 * This mirrors `packages/public/python-sdk/examples/livekit_say_german.py`. It wires the
 * KugelAudio TTS plugin (`kugelaudio/livekit`) into a LiveKit `AgentSession`.
 *
 * Prerequisites (from `packages/public/js-sdk`):
 *
 *   npm install @livekit/agents @livekit/rtc-node \
 *     @livekit/agents-plugin-silero @livekit/agents-plugin-deepgram \
 *     @livekit/agents-plugin-openai
 *
 *   export KUGELAUDIO_API_KEY="..."
 *   export KUGELAUDIO_VOICE_ID="1071"
 *   export LIVEKIT_URL="wss://your-livekit-server.com"
 *   export LIVEKIT_API_KEY="..."
 *   export LIVEKIT_API_SECRET="..."
 *
 *   # Run in console mode for local testing:
 *   npx tsx examples/livekit_agent.ts console
 */

import { fileURLToPath } from 'node:url';
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { TTS as KugelAudioTTS } from 'kugelaudio/livekit';

const VOICE_ID = Number(process.env.KUGELAUDIO_VOICE_ID ?? '1071');

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const tts = new KugelAudioTTS({
      model: 'kugel-3',
      voiceId: VOICE_ID,
      language: 'en', // skip server-side language auto-detection for lower latency
      sampleRate: 24000,
    });
    // Establish the WebSocket now so it is off the first-response hot path.
    tts.prewarm();

    const session = new voice.AgentSession({
      stt: new deepgram.STT(),
      llm: new openai.LLM({ model: 'gpt-4o-mini' }),
      tts,
      vad: await silero.VAD.load(),
    });

    await session.start({
      agent: new voice.Agent({
        instructions:
          'You are a helpful voice assistant. Keep responses concise (1-3 sentences).',
      }),
      room: ctx.room,
    });

    await session.say('Hello! How can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
