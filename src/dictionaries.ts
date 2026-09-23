/**
 * Resources for managing per-project custom word dictionaries.
 *
 * @example
 * ```typescript
 * const dict = await client.dictionaries.create({ name: 'Brand names' });
 * await client.dictionaries.entries.add(dict.id, {
 *   word: 'Postgres',
 *   replacement: 'post-gres',
 * });
 *
 * // Sync from an external source — atomic, idempotent
 * await client.dictionaries.entries.replaceAll(dict.id, [
 *   { word: 'Postgres', replacement: 'post-gres' },
 *   { word: 'Kubernetes', replacement: 'koo-ber-net-eez' },
 * ]);
 * ```
 */

import type { KugelAudio } from './client';
import type {
  BulkReplaceResult,
  CreateDictionaryOptions,
  Dictionary,
  DictionaryEntry,
  DictionaryEntryInput,
  DictionaryEntryListResponse,
  UpdateDictionaryOptions,
  UpdateDictionaryEntryOptions,
} from './types';

function mapDictionary(raw: Record<string, unknown>): Dictionary {
  return {
    id: raw.id as number,
    projectId: raw.project_id as number,
    name: raw.name as string,
    description: (raw.description as string | null) ?? undefined,
    language: (raw.language as string | null) ?? undefined,
    isActive: (raw.is_active as boolean) ?? true,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  };
}

function mapEntry(raw: Record<string, unknown>): DictionaryEntry {
  return {
    id: raw.id as number,
    dictionaryId: raw.dictionary_id as number,
    word: raw.word as string,
    replacement: raw.replacement as string,
    ipa: (raw.ipa as string | null) ?? undefined,
    caseSensitive: (raw.case_sensitive as boolean) ?? false,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  };
}

function entryPayload(input: DictionaryEntryInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    word: input.word,
    replacement: input.replacement,
  };
  if (input.ipa !== undefined) payload.ipa = input.ipa;
  if (input.caseSensitive !== undefined) {
    payload.case_sensitive = input.caseSensitive;
  }
  return payload;
}

function buildPath(base: string, params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;
    search.set(key, String(val));
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Resource for entries within a single dictionary.
 * Access via ``client.dictionaries.entries`` and pass ``dictionaryId``
 * to each call.
 */
export class DictionaryEntriesResource {
  constructor(private client: KugelAudio) {}

  /** List entries with optional search + pagination. */
  async list(
    dictionaryId: number,
    options?: {
      search?: string;
      limit?: number;
      offset?: number;
      projectId?: number;
    },
  ): Promise<DictionaryEntryListResponse> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}/entries`, {
      search: options?.search,
      limit: options?.limit,
      offset: options?.offset,
      project_id: options?.projectId,
    });
    const raw = await this.client.request<{
      entries: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
    }>('GET', path);
    return {
      entries: raw.entries.map(mapEntry),
      total: raw.total,
      limit: raw.limit,
      offset: raw.offset,
    };
  }

  /** Add a single entry to a dictionary. */
  async add(
    dictionaryId: number,
    entry: DictionaryEntryInput,
    options?: { projectId?: number },
  ): Promise<DictionaryEntry> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}/entries`, {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<Record<string, unknown>>(
      'POST',
      path,
      entryPayload(entry),
    );
    return mapEntry(raw);
  }

  /** Update an existing entry. */
  async update(
    dictionaryId: number,
    entryId: number,
    updates: UpdateDictionaryEntryOptions,
    options?: { projectId?: number },
  ): Promise<DictionaryEntry> {
    const payload: Record<string, unknown> = {};
    if (updates.word !== undefined) payload.word = updates.word;
    if (updates.replacement !== undefined) payload.replacement = updates.replacement;
    if (updates.ipa !== undefined) payload.ipa = updates.ipa;
    if (updates.caseSensitive !== undefined) {
      payload.case_sensitive = updates.caseSensitive;
    }
    const path = buildPath(`/v1/dictionaries/${dictionaryId}/entries/${entryId}`, {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<Record<string, unknown>>(
      'PATCH',
      path,
      payload,
    );
    return mapEntry(raw);
  }

  /** Delete a single entry. */
  async delete(
    dictionaryId: number,
    entryId: number,
    options?: { projectId?: number },
  ): Promise<void> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}/entries/${entryId}`, {
      project_id: options?.projectId,
    });
    await this.client.request<{ deleted: boolean }>('DELETE', path);
  }

  /**
   * Replace every entry in the dictionary atomically.
   *
   * Each item must have ``word`` and ``replacement``; existing entries
   * whose ``word`` is not in the supplied list are deleted. Idempotent.
   */
  async replaceAll(
    dictionaryId: number,
    entries: DictionaryEntryInput[],
    options?: { projectId?: number },
  ): Promise<BulkReplaceResult> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}/entries`, {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<BulkReplaceResult>('PUT', path, {
      entries: entries.map(entryPayload),
    });
    return raw;
  }
}

/**
 * Resource for managing per-project custom dictionaries.
 */
export class DictionariesResource {
  /** Per-entry operations within a dictionary. */
  public readonly entries: DictionaryEntriesResource;

  constructor(private client: KugelAudio) {
    this.entries = new DictionaryEntriesResource(client);
  }

  /** List every dictionary in the caller's project. */
  async list(options?: { projectId?: number }): Promise<Dictionary[]> {
    const path = buildPath('/v1/dictionaries', {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<{
      dictionaries: Record<string, unknown>[];
    }>('GET', path);
    return raw.dictionaries.map(mapDictionary);
  }

  /** Create a new dictionary scoped to the caller's project. */
  async create(
    body: CreateDictionaryOptions,
    options?: { projectId?: number },
  ): Promise<Dictionary> {
    const path = buildPath('/v1/dictionaries', {
      project_id: options?.projectId,
    });
    const payload: Record<string, unknown> = { name: body.name };
    if (body.description !== undefined) payload.description = body.description;
    if (body.language !== undefined) payload.language = body.language;
    const raw = await this.client.request<Record<string, unknown>>(
      'POST',
      path,
      payload,
    );
    return mapDictionary(raw);
  }

  /** Fetch a single dictionary. */
  async get(
    dictionaryId: number,
    options?: { projectId?: number },
  ): Promise<Dictionary> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}`, {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<Record<string, unknown>>('GET', path);
    return mapDictionary(raw);
  }

  /** Update name / description / language / isActive. */
  async update(
    dictionaryId: number,
    updates: UpdateDictionaryOptions,
    options?: { projectId?: number },
  ): Promise<Dictionary> {
    const payload: Record<string, unknown> = {};
    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.description !== undefined) payload.description = updates.description;
    if (updates.language !== undefined) payload.language = updates.language;
    if (updates.isActive !== undefined) payload.is_active = updates.isActive;
    const path = buildPath(`/v1/dictionaries/${dictionaryId}`, {
      project_id: options?.projectId,
    });
    const raw = await this.client.request<Record<string, unknown>>(
      'PATCH',
      path,
      payload,
    );
    return mapDictionary(raw);
  }

  /** Delete a dictionary (cascades to its entries). */
  async delete(
    dictionaryId: number,
    options?: { projectId?: number },
  ): Promise<void> {
    const path = buildPath(`/v1/dictionaries/${dictionaryId}`, {
      project_id: options?.projectId,
    });
    await this.client.request<{ deleted: boolean }>('DELETE', path);
  }
}
