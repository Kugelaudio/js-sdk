/**
 * Unit tests for the voice REST methods against the ingress wire shapes
 * (services/ingress/src/ingress/routes/voices.py).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { KugelAudio } from './client';

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoicesResource deletes (204 No Content)', () => {
  it('delete() resolves on an empty 204', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await expect(client.voices.delete(1071)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.kugelaudio.com/v1/voices/1071');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('deleteReference() resolves on an empty 204', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await expect(client.voices.deleteReference(1071, 456)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.kugelaudio.com/v1/voices/1071/references/456',
    );
  });
});

describe('VoicesResource.listReferences()', () => {
  it('maps the bare JSON array the server returns', async () => {
    stubFetch(
      jsonResponse([
        {
          id: 456,
          voice_id: 1071,
          name: 'ref.wav',
          reference_text: 'Hallo',
          s3_path: 'voices/1071/ref.wav',
          audio_url: 'https://cdn.example/ref.wav',
          is_generated: false,
        },
      ]),
    );
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    const refs = await client.voices.listReferences(1071);

    expect(refs).toEqual([
      {
        id: 456,
        voiceId: 1071,
        name: 'ref.wav',
        referenceText: 'Hallo',
        s3Path: 'voices/1071/ref.wav',
        audioUrl: 'https://cdn.example/ref.wav',
        isGenerated: false,
      },
    ]);
  });
});

describe('VoicesResource.generateSample()', () => {
  it('returns the sample URL; the other VoiceDetail fields are not in the response', async () => {
    stubFetch(
      jsonResponse({
        sample_s3_path: 'voices/1071/sample.wav',
        sample_url: 'https://cdn.example/sample.wav',
      }),
    );
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    const sample = await client.voices.generateSample(1071);

    expect(sample.sampleUrl).toBe('https://cdn.example/sample.wav');
  });
});

describe('speaker consent (voice create and reference upload)', () => {
  const voiceRow = { id: 1071, voice_id: 1071, name: 'Anna' };

  async function metadataOf(fetchMock: ReturnType<typeof stubFetch>): Promise<Record<string, unknown>> {
    const form = fetchMock.mock.calls[0][1].body as FormData;
    return JSON.parse(await (form.get('metadata') as Blob).text());
  }

  it('create() sends speaker_consent in the metadata part', async () => {
    const fetchMock = stubFetch(jsonResponse(voiceRow));
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await client.voices.create({ name: 'Anna', sex: 'female', speakerConsent: true });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.kugelaudio.com/v1/voices');
    expect(await metadataOf(fetchMock)).toMatchObject({ name: 'Anna', speaker_consent: true });
  });

  it('create() sends a false consent as false, for the server to refuse', async () => {
    const fetchMock = stubFetch(jsonResponse(voiceRow));
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await client.voices.create({ name: 'Anna', sex: 'female', speakerConsent: false });

    expect(await metadataOf(fetchMock)).toMatchObject({ speaker_consent: false });
  });

  it('addReference() sends speaker_consent and the transcript as form fields', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ id: 456, voice_id: 1071, name: 'ref.wav', s3_path: 'voices/1071/ref.wav' }),
    );
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await client.voices.addReference(1071, new Blob(['audio']), {
      speakerConsent: true,
      referenceText: 'Hallo',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.kugelaudio.com/v1/voices/1071/references',
    );
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('speaker_consent')).toBe('true');
    expect(form.get('reference_text')).toBe('Hallo');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });
});
