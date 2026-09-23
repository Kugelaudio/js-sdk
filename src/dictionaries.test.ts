/**
 * Tests for the dictionaries resource.
 *
 * Stubs the global `fetch` to verify the SDK sends the right method,
 * URL, params, and JSON body for each CRUD path, and that snake_case
 * server responses get mapped to camelCase SDK types.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KugelAudio } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dictRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    project_id: 42,
    name: 'Brand names',
    description: null,
    language: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    ...overrides,
  };
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    dictionary_id: 1,
    word: 'Kubernetes',
    replacement: 'koo-ber-net-eez',
    ipa: null,
    case_sensitive: false,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient() {
  return new KugelAudio({ apiKey: 'test-key', apiUrl: 'https://api.example.com' });
}

describe('Dictionaries CRUD', () => {
  it('lists dictionaries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ dictionaries: [dictRow(), dictRow({ id: 2, name: 'Other' })] }),
    );
    const client = makeClient();
    const result = await client.dictionaries.list();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 1,
      projectId: 42,
      name: 'Brand names',
      isActive: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/dictionaries');
    expect(init.method).toBe('GET');
  });

  it('creates a dictionary', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(dictRow({ id: 7, name: 'Glossary' })));
    const client = makeClient();
    const d = await client.dictionaries.create({
      name: 'Glossary',
      description: 'hi',
      language: 'en',
    });
    expect(d.id).toBe(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/dictionaries');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Glossary',
      description: 'hi',
      language: 'en',
    });
  });

  it('updates only provided fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(dictRow({ is_active: false })));
    const client = makeClient();
    await client.dictionaries.update(1, { isActive: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/dictionaries/1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ is_active: false });
  });

});

describe('Dictionary entries CRUD', () => {
  it('lists entries with search + pagination', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [entryRow()],
        total: 1,
        limit: 25,
        offset: 0,
      }),
    );
    const client = makeClient();
    const res = await client.dictionaries.entries.list(1, {
      search: 'kub',
      limit: 25,
    });
    expect(res.total).toBe(1);
    expect(res.entries[0]).toMatchObject({
      id: 11,
      dictionaryId: 1,
      word: 'Kubernetes',
      caseSensitive: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/v1/dictionaries/1/entries?search=kub&limit=25',
    );
  });

  it('adds a single entry and maps camelCase fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(entryRow({ word: 'Postgres', replacement: 'post-gres' })),
    );
    const client = makeClient();
    const e = await client.dictionaries.entries.add(1, {
      word: 'Postgres',
      replacement: 'post-gres',
      caseSensitive: true,
    });
    expect(e.word).toBe('Postgres');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      word: 'Postgres',
      replacement: 'post-gres',
      case_sensitive: true,
    });
  });

  it('bulk replaces entries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ upserted: 2, deleted: 3, total: 2 }),
    );
    const client = makeClient();
    const result = await client.dictionaries.entries.replaceAll(1, [
      { word: 'Postgres', replacement: 'post-gres' },
      { word: 'K8s', replacement: 'kubernetes', caseSensitive: true },
    ]);
    expect(result).toEqual({ upserted: 2, deleted: 3, total: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/dictionaries/1/entries');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      entries: [
        { word: 'Postgres', replacement: 'post-gres' },
        { word: 'K8s', replacement: 'kubernetes', case_sensitive: true },
      ],
    });
  });
});
