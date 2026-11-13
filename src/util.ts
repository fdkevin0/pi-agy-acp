/**
 * Small async primitives shared by the adapter: deferred values, an
 * unbounded event queue with abortable waits, and a keyed mutex.
 * @module pi-agy-acp/util
 */

import { createHash } from 'node:crypto'

/** A promise with externally exposed settlement. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
  settled: boolean
}

/**
 * Create a deferred value.
 * @returns the deferred handle.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // A rejection nobody awaits is expected when a parked call is abandoned.
  promise.catch(() => undefined)
  const handle: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (!handle.settled) {
        handle.settled = true
        resolve(value)
      }
    },
    reject: (error) => {
      if (!handle.settled) {
        handle.settled = true
        reject(error)
      }
    },
  }
  return handle
}

/** Unbounded FIFO with one consumer that can wait with a deadline or abort signal. */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined

  /**
   * Append one item.
   * @param item - the queued value.
   */
  push(item: T): void {
    this.items.push(item)
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Number of queued items. */
  get size(): number {
    return this.items.length
  }

  /**
   * Inspect the head without removing it.
   * @returns the head item.
   */
  peek(): T | undefined {
    return this.items[0]
  }

  /**
   * Remove the head item.
   * @returns the head item.
   */
  shift(): T | undefined {
    return this.items.shift()
  }

  /**
   * Wait until an item is available.
   * @param signal - aborts the wait.
   * @param timeoutMs - resolve false after this delay.
   * @returns whether an item is available.
   */
  async wait(signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (this.items.length > 0) return true
    if (signal?.aborted === true) return false
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.waiter === wake) this.waiter = undefined
        resolve(value)
      }
      const wake = (): void => finish(true)
      const onAbort = (): void => finish(false)
      this.waiter = wake
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined)
        timer = setTimeout(() => finish(this.items.length > 0), timeoutMs)
    })
  }
}

/** Serializes async sections per key. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Acquire the lock for one key.
   * @param key - lock key.
   * @param signal - cancels waiting without bypassing earlier lock holders.
   * @returns the release function.
   */
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    try {
      await abortable(previous, signal)
      signal?.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    }
  }
}

/**
 * Stable short digest of a JSON-serializable value.
 * @param value - hashed value.
 * @returns hex digest prefix.
 */
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24)
}

/**
 * Sleep for a duration.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Cancel one caller's wait without cancelling work shared with other callers. */
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
