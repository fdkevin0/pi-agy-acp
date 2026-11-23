/**
 * Model catalog derived from the agent's session configuration options. The
 * ACP server advertises model families (`gemini-4-argon`, `claude-opus-5-5`)
 * and a separate `thought_level` option; Pi lists each family once with the
 * efforts that family actually offers. Fixed-effort families such as
 * `gpt-oss-120b-medium` carry their effort in the id and expose no selector.
 * @module pi-agy-acp/catalog
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpTierInfo,
} from './acp-process.ts'
import { EFFORTS, type Effort } from './config.ts'

/** One advertised model family. */
export interface CatalogModel {
  id: string
  name: string
}

/** One entry of the ACP `models.availableModels` list. */
export interface AvailableModel {
  modelId: string
  name?: string
}

/** Flatten flat or grouped ACP select option entries. */
export function flattenConfigOptions(
  options: AcpConfigOption['options'],
): AcpConfigOptionValue[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    return 'group' in entry
      ? Array.isArray(entry.options)
        ? entry.options
        : []
      : [entry]
  })
}

/** Effort suffixes ordered longest-first so `-<effort>-effort` beats `-<effort>`. */
const EFFORT_SUFFIXES: readonly { suffix: string; effort: Effort }[] =
  EFFORTS.flatMap((effort) => [
    { suffix: `-${effort}-effort`, effort },
    { suffix: `-${effort}`, effort },
  ]).sort((a, b) => b.suffix.length - a.suffix.length)

function splitEffortSuffix(
  id: string,
): { base: string; effort: Effort } | undefined {
  for (const { suffix, effort } of EFFORT_SUFFIXES) {
    if (id.length > suffix.length && id.endsWith(suffix)) {
      return { base: id.slice(0, -suffix.length), effort }
    }
  }
  return undefined
}

function normalizeTier(
  tier: AcpTierInfo | undefined,
): { id?: string; name: string } | undefined {
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  if (!name) return undefined
  const id = typeof tier?.id === 'string' ? tier.id.trim() : ''
  return { name, ...(id ? { id } : {}) }
}

/**
 * Pick the offered effort closest to the requested one.
 * @param wanted - requested effort.
 * @param offered - efforts the model exposes.
 * @returns one of `offered`, or `wanted` when nothing is offered.
 */
export function nearestEffort(
  wanted: Effort,
  offered: readonly Effort[],
): Effort {
  if (offered.includes(wanted)) return wanted
  const distance = (effort: Effort): number =>
    Math.abs(EFFORTS.indexOf(effort) - EFFORTS.indexOf(wanted))
  let best: Effort | undefined
  for (const effort of offered) {
    if (best === undefined || distance(effort) < distance(best)) best = effort
  }
  return best ?? wanted
}

function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Observed catalog with a disk cache. Starts empty until loaded or observed from ACP. */
export class ModelCatalog {
  private models: CatalogModel[]
  private tierInfo: { id?: string; name: string } | undefined
  private efforts: Effort[] = []
  /** Efforts per model family; an empty array marks a fixed-effort or non-selectable model. */
  private byModel = new Map<string, Effort[]>()
  /** Server-reported `max_context_tokens` keyed by model id. */
  private readonly contextWindows = new Map<string, number>()
  /** Server-reported `agentCapabilities.promptCapabilities.image` from `initialize`. */
  private supportsImageInput: boolean | undefined
  /** Latest `availableModels` snapshot, kept for later option updates. */
  private available: readonly AvailableModel[] | undefined
  /** Current on-disk `agy` binary fingerprint, if resolved. */
  private currentFingerprint: string | undefined
  /** Fingerprint of the `agy` binary that produced the cached catalog. */
  private observedFingerprint: string | undefined
  /** Whether a live ACP session has reported the catalog in this process. */
  observed = false
  private readonly cachePath: string

  /**
   * @param cachePath - JSON cache file.
   * @param binaryFingerprint - current `agy` binary fingerprint, if resolved.
   */
  constructor(cachePath: string, binaryFingerprint?: string) {
    this.cachePath = cachePath
    this.currentFingerprint = binaryFingerprint
    this.models = this.load(binaryFingerprint) ?? []
  }

  /** Whether disk-cached models match the current `agy` binary fingerprint. */
  hasFreshCache(): boolean {
    return (
      this.models.length > 0 &&
      (this.currentFingerprint === undefined ||
        this.observedFingerprint === this.currentFingerprint)
    )
  }

  /** Whether the catalog is current without probing ACP. */
  isCurrent(): boolean {
    return this.observed || this.hasFreshCache()
  }

  /** Input modalities advertised to Pi, derived from `initialize` `promptCapabilities.image`. */
  inputModalities(): ('text' | 'image')[] {
    return this.supportsImageInput === false ? ['text'] : ['text', 'image']
  }

  /**
   * Record `agentCapabilities.promptCapabilities.image` from ACP `initialize`.
   * @returns whether the advertised input modalities changed.
   */
  observeImageSupport(supported: boolean | undefined): boolean {
    if (typeof supported !== 'boolean') return false
    const before = this.supportsImageInput !== false
    const changed = this.supportsImageInput !== supported
    if (!changed) return false
    this.supportsImageInput = supported
    this.save()
    return before !== supported
  }

  /**
   * Reconcile cached state against the current `agy` binary fingerprint.
   * Invalidates cached `contextWindows` and `observed` when the binary changed
   * so the next warmup or session re-probes fresh models and context limits.
   * @returns whether cached context windows were invalidated.
   */
  syncBinaryFingerprint(fingerprint: string | undefined): boolean {
    if (!fingerprint || this.currentFingerprint === fingerprint) return false
    this.currentFingerprint = fingerprint
    if (this.observedFingerprint === fingerprint) return false
    const hadContextWindows = this.contextWindows.size > 0
    this.contextWindows.clear()
    this.observed = false
    // Persist cleared contextWindows while keeping observedFingerprint intact until live ACP re-observes.
    if (hadContextWindows) this.save()
    return hadContextWindows
  }

  /**
   * Cached server-issued context window (`max_context_tokens`) for one model.
   * @param modelId - family id.
   * @returns positive token limit, or `undefined` when never observed.
   */
  contextWindowFor(modelId: string): number | undefined {
    return this.contextWindows.get(modelId)
  }

  /**
   * Persist one observed context window if it is valid and changed.
   * @param modelId - family id.
   * @param contextWindow - observed `max_context_tokens`.
   * @returns whether the stored window changed.
   */
  observeContextWindow(
    modelId: string,
    contextWindow: number | undefined,
  ): boolean {
    if (
      typeof modelId !== 'string' ||
      modelId.length === 0 ||
      !isValidContextWindow(contextWindow)
    ) {
      return false
    }
    if (this.contextWindows.get(modelId) === contextWindow) return false
    this.contextWindows.set(modelId, contextWindow)
    this.save()
    return true
  }

  /** Current families. */
  list(): readonly CatalogModel[] {
    return this.models
  }

  /** Last subscription plan reported by ACP, including the disk cache. */
  tier(): Readonly<{ id?: string; name: string }> | undefined {
    return this.tierInfo
  }

  /** Efforts the account offers globally, in escalation order. */
  effortList(): readonly Effort[] {
    return this.efforts
  }

  /**
   * Efforts one family actually offers. Empty means the family is a single
   * fixed variant (for example `gpt-oss-120b-medium`) or offers no selector.
   * @param id - family id.
   * @returns offered efforts.
   */
  effortsFor(id: string): readonly Effort[] {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed
    return this.fixedEffort(id) === undefined ? this.efforts : []
  }

  /**
   * Whether a model accepts `thought_level` writes on a live ACP session.
   * Fixed-effort models and models observed with zero effort variants return false.
   */
  supportsEffortSelection(id: string): boolean {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed.length > 0
    return this.fixedEffort(id) === undefined
  }

  /**
   * Effort baked into a fixed-variant id.
   * @param id - family id.
   * @returns the effort, or undefined for a selectable family.
   */
  fixedEffort(id: string): Effort | undefined {
    return splitEffortSuffix(id)?.effort
  }

  /**
   * Fold session configuration options and the session's model inventory into
   * the catalog.
   * @param options - options from `session/new` or `config_option_update`.
   * @param available - `models.availableModels` from `session/new`.
   * @param tier - subscription metadata from `session/new`.
   * @returns whether the family list changed.
   */
  observe(
    options: readonly AcpConfigOption[] | undefined,
    available?: readonly AvailableModel[] | undefined,
    tier?: AcpTierInfo,
  ): boolean {
    const nextTier = normalizeTier(tier)
    const tierChanged =
      nextTier !== undefined &&
      JSON.stringify(nextTier) !== JSON.stringify(this.tierInfo)
    if (tierChanged) this.tierInfo = nextTier
    if (available !== undefined && available.length > 0)
      this.available = available
    if (options === undefined) {
      if (tierChanged) this.save()
      return false
    }
    const modelOption = options.find(
      (o) => o.id === 'model' || o.category === 'model',
    )
    const levelOption = options.find(
      (o) => o.id === 'thought_level' || o.category === 'thought_level',
    )
    const beforeEfforts = JSON.stringify(this.efforts)
    const levelEfforts =
      levelOption?.options !== undefined
        ? flattenConfigOptions(levelOption.options)
            .map((o) => o.value)
            .filter((v): v is Effort =>
              (EFFORTS as readonly string[]).includes(v),
            )
        : []
    const modelEntries = flattenConfigOptions(modelOption?.options)
    const next =
      modelEntries.length > 0
        ? modelEntries.map((o) => ({
            id: o.value,
            name: o.name ?? o.value,
          }))
        : this.models
    this.observed = true
    const changed = JSON.stringify(next) !== JSON.stringify(this.models)
    if (changed) this.models = next
    const fingerprintChanged =
      modelEntries.length > 0 &&
      this.currentFingerprint !== undefined &&
      this.observedFingerprint !== this.currentFingerprint
    if (fingerprintChanged) this.observedFingerprint = this.currentFingerprint
    let prunedChanged = false
    if (modelEntries.length > 0) {
      const activeIds = new Set(this.models.map((m) => m.id))
      for (const id of [...this.byModel.keys()]) {
        if (!activeIds.has(id)) {
          this.byModel.delete(id)
          prunedChanged = true
        }
      }
    }
    const derivedChanged = this.deriveEfforts()
    const union = new Set<Effort>(levelEfforts)
    for (const model of this.models) {
      const values = this.byModel.get(model.id)
      if (values !== undefined) {
        for (const effort of values) union.add(effort)
      }
    }
    if (union.size > 0) {
      this.efforts = EFFORTS.filter((e) => union.has(e))
    }
    const effortsChanged =
      prunedChanged ||
      derivedChanged ||
      beforeEfforts !== JSON.stringify(this.efforts)
    if (changed || effortsChanged || tierChanged || fingerprintChanged)
      this.save()
    return changed || effortsChanged
  }

  /** Recompute per-family efforts from the latest inventory. */
  private deriveEfforts(): boolean {
    if (this.available === undefined) return false
    const byBase = new Map<string, Set<Effort>>()
    for (const entry of this.available) {
      const split = splitEffortSuffix(entry.modelId)
      if (split === undefined) continue
      let set = byBase.get(split.base)
      if (set === undefined) {
        set = new Set<Effort>()
        byBase.set(split.base, set)
      }
      set.add(split.effort)
    }
    let changed = false
    for (const model of this.models) {
      const matched = byBase.get(model.id)
      const offered =
        matched !== undefined
          ? EFFORTS.filter((effort) => matched.has(effort))
          : []
      if (offered.length > 0) {
        if (
          JSON.stringify(this.byModel.get(model.id)) !== JSON.stringify(offered)
        ) {
          this.byModel.set(model.id, offered)
          changed = true
        }
        continue
      }
      const present = this.available.some((entry) => entry.modelId === model.id)
      if (!present) continue
      const prevEfforts = this.effortsFor(model.id)
      if (this.byModel.get(model.id)?.length !== 0) {
        this.byModel.set(model.id, [])
        if (prevEfforts.length !== 0) changed = true
      }
    }
    return changed
  }

  private save(): void {
    const dir = dirname(this.cachePath)
    const tempPath = join(
      dir,
      `.${basename(this.cachePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
    )
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        tempPath,
        `${JSON.stringify(
          {
            models: this.models,
            efforts: this.efforts,
            byModel: Object.fromEntries(this.byModel),
            contextWindows: Object.fromEntries(this.contextWindows),
            tier: this.tierInfo,
            ...(this.supportsImageInput !== undefined
              ? { supportsImage: this.supportsImageInput }
              : {}),
            ...(this.observedFingerprint !== undefined
              ? { binaryFingerprint: this.observedFingerprint }
              : {}),
          },
          null,
          2,
        )}\n`,
      )
      renameSync(tempPath, this.cachePath)
    } catch (_cacheWrite) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup.
      }
      // The cache only speeds up the next cold start.
    }
  }

  private load(expectedFingerprint?: string): CatalogModel[] | undefined {
    if (!existsSync(this.cachePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        models?: CatalogModel[]
        efforts?: string[]
        byModel?: Record<string, string[]>
        contextWindows?: Record<string, unknown>
        tier?: AcpTierInfo
        supportsImage?: unknown
        binaryFingerprint?: unknown
      } | null
      if (parsed === null || typeof parsed !== 'object') return undefined
      const storedFingerprint =
        typeof parsed.binaryFingerprint === 'string' &&
        parsed.binaryFingerprint.length > 0
          ? parsed.binaryFingerprint
          : undefined
      const fingerprintMatches =
        expectedFingerprint === undefined ||
        storedFingerprint === expectedFingerprint
      this.observedFingerprint = storedFingerprint
      this.tierInfo = normalizeTier(parsed.tier)
      if (typeof parsed.supportsImage === 'boolean') {
        this.supportsImageInput = parsed.supportsImage
      }
      if (Array.isArray(parsed.efforts)) {
        const efforts = parsed.efforts.filter((v): v is Effort =>
          (EFFORTS as readonly string[]).includes(v),
        )
        if (efforts.length > 0) this.efforts = efforts
      }
      if (parsed.byModel !== null && typeof parsed.byModel === 'object') {
        for (const [id, values] of Object.entries(parsed.byModel)) {
          if (!Array.isArray(values)) continue
          const efforts = values.filter((v): v is Effort =>
            (EFFORTS as readonly string[]).includes(v),
          )
          this.byModel.set(id, efforts)
        }
      }
      if (
        fingerprintMatches &&
        parsed.contextWindows !== null &&
        typeof parsed.contextWindows === 'object'
      ) {
        for (const [id, value] of Object.entries(parsed.contextWindows)) {
          if (id.length > 0 && isValidContextWindow(value))
            this.contextWindows.set(id, value)
        }
      }
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(
            (m) => typeof m?.id === 'string' && typeof m?.name === 'string',
          )
        : []
      return models.length > 0 ? models : undefined
    } catch (_cacheRead) {
      // A corrupt cache starts empty until live ACP discovery populates it.
      return undefined
    }
  }
}
