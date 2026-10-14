import type { HistoryEntry } from './model'

/**
 * History persistence. The console records decrypted copies client-side (ADR-0010:
 * the relay deletes the payload on ack, so if the console doesn't keep it, it's
 * gone). The store is keyed by message id, which doubles as the seen/idempotency
 * set — `has(id)` short-circuits re-recording a copy a re-poll hands us again.
 *
 * Behind an interface so the projection/consumption logic is testable with an
 * in-memory fake and the browser gets durable IndexedDB.
 */
export interface HistoryStore {
  list(): Promise<HistoryEntry[]>
  has(id: string): Promise<boolean>
  put(entry: HistoryEntry): Promise<void>
  delete(id: string): Promise<void>
  clear(): Promise<void>
}

/** In-memory store for tests (and a graceful fallback if IndexedDB is unavailable). */
export class InMemoryHistoryStore implements HistoryStore {
  private readonly map = new Map<string, HistoryEntry>()

  async list(): Promise<HistoryEntry[]> {
    return [...this.map.values()]
  }
  async has(id: string): Promise<boolean> {
    return this.map.has(id)
  }
  async put(entry: HistoryEntry): Promise<void> {
    this.map.set(entry.id, entry)
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id)
  }
  async clear(): Promise<void> {
    this.map.clear()
  }
}

const DB_NAME = 'tabsend-console'
const DB_VERSION = 1
const STORE = 'history'

/** Durable IndexedDB store, one object store keyed by `id`. */
export class IndexedDbHistoryStore implements HistoryStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    })
    return this.dbPromise
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = fn(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
    })
  }

  async list(): Promise<HistoryEntry[]> {
    return this.tx<HistoryEntry[]>('readonly', (store) => store.getAll())
  }
  async has(id: string): Promise<boolean> {
    const key = await this.tx<IDBValidKey | undefined>('readonly', (store) => store.getKey(id))
    return key !== undefined
  }
  async put(entry: HistoryEntry): Promise<void> {
    await this.tx('readwrite', (store) => store.put(entry))
  }
  async delete(id: string): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(id))
  }
  async clear(): Promise<void> {
    await this.tx('readwrite', (store) => store.clear())
  }
}

/** Pick the durable store in a browser, the in-memory one otherwise (SSR/tests). */
export function defaultHistoryStore(): HistoryStore {
  if (typeof indexedDB !== 'undefined') return new IndexedDbHistoryStore()
  return new InMemoryHistoryStore()
}
