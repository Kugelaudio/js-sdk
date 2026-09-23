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
