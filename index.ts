import {
  BorderedLoader,
  type ExtensionAPI,
  type ProviderModelConfig,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { AntigravityRuntime, type RuntimeHost } from './src/runtime.ts'
import {
  asQuotaDisplay,
  DEFAULT_QUOTA_DISPLAY,
  defaults,
  readQuotaDisplayPreference,
  writeQuotaDisplayPreference,
  type QuotaDisplay,
} from './src/config.ts'
import { spawnAcp, runCommand } from './src/host.ts'
import { streamPi } from './src/pi-stream.ts'
import {
  displayFraction,
  formatQuota,
  formatStatus,
  formatQuotaStatus,
  quotaForModel,
} from './src/format.ts'
import type { QuotaSnapshot } from './src/quota.ts'

export default function (
  pi: ExtensionAPI,
  host: Partial<Pick<RuntimeHost, 'runCommand'>> = {},
) {
  const envQuotaDisplay = asQuotaDisplay(process.env.PI_AGY_QUOTA_DISPLAY)
  const config = {
    ...defaults,
    command: process.env.PI_AGY_COMMAND || '',
    home: process.env.PI_AGY_HOME || '',
  }
  let refreshDepth = 0
  const createRuntime = () =>
    new AntigravityRuntime({
      config,
      spawnAcp,
      runCommand: host.runCommand ?? runCommand,
      log: { info: () => {}, warn: () => {} },
      onModelsChanged: () => {
        if (refreshDepth === 0) register()
      },
    })
  let runtime = createRuntime()
  const home = runtime.status().home
  let quotaDisplay: QuotaDisplay =
    envQuotaDisplay ??
    readQuotaDisplayPreference(home) ??
    DEFAULT_QUOTA_DISPLAY
  const models = (): ProviderModelConfig[] =>
    runtime.catalog.list().map((m) => {
      const efforts = runtime.catalog.effortsFor(m.id)
      return {
        id: m.id,
        name: m.name,
        input: ['text', 'image'],
        reasoning: efforts.length > 0,
        thinkingLevelMap:
          efforts.length > 0
            ? {
                off: null,
                minimal: null,
                low: efforts.includes('low') ? 'low' : null,
                medium: efforts.includes('medium') ? 'medium' : null,
                high: efforts.includes('high') ? 'high' : null,
                xhigh: null,
                max: null,
              }
            : undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: runtime.contextWindowFor(m.id),
        maxTokens: 65536,
      }
    })
  const register = () =>
    pi.registerProvider(config.provider, {
      name: config.displayName,
      api: 'antigravity-acp',
      baseUrl: 'acp://local',
      apiKey: 'local-agy',
      models: models(),
      streamSimple: (model, context, options) =>
        streamPi(runtime, model, context, options),
      refreshModels: async (context) => {
        refreshDepth++
        try {
          if (context?.allowNetwork !== false && !context?.signal?.aborted) {
            await runtime.warmup({
              force: context?.force,
              signal: context?.signal,
            })
          }
          return models()
        } finally {
          refreshDepth--
        }
      },
    })
  register()
  let uiEpoch = 0
  let shutDown = false
  let activeRuntime: AntigravityRuntime | undefined = runtime
  let resetting: Promise<void> | undefined
  interface PendingSettle {
    runtime: AntigravityRuntime
    epoch: number
    ctx: ExtensionContext
    model: ExtensionContext['model']
  }
  let pendingSettle: PendingSettle | undefined
  const warned = new Set<string>()
  const clearStatus = (ctx?: ExtensionContext) => {
    uiEpoch++
    pendingSettle = undefined
    if (!shutDown && ctx?.hasUI) ctx.ui.setStatus(config.provider, undefined)
  }
  const updateStatus = (
    ctx: ExtensionContext,
    snapshot?: QuotaSnapshot,
    model = ctx.model,
  ) => {
    if (!shutDown && activeRuntime && ctx.hasUI && model?.provider === config.provider)
      ctx.ui.setStatus(
        config.provider,
        snapshot
          ? formatQuotaStatus(snapshot, model, quotaDisplay)
          : undefined,
      )
  }
  const reset = () => {
    uiEpoch++
    warned.clear()
    pendingSettle = undefined
    activeRuntime = undefined
    if (resetting) return resetting
    const previous = runtime
    resetting = (async () => {
      try {
        await previous.dispose()
        if (shutDown) return
        runtime = activeRuntime = createRuntime()
      } finally {
        resetting = undefined
      }
    })()
    return resetting
  }
  pi.on('session_tree', () => activeRuntime?.resetConversations())
  pi.on('session_compact', () => activeRuntime?.resetConversations())
  pi.on('session_start', async (event, ctx) => {
    clearStatus(ctx)
    const epoch = uiEpoch
    if (resetting) await resetting.catch(() => {})
    if (shutDown) return
    if (['new', 'resume', 'fork'].includes(event.reason))
      await activeRuntime?.resetConversations()
    if (!shutDown && epoch === uiEpoch)
      updateStatus(ctx, activeRuntime?.quota.peek())
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    clearStatus(ctx)
    shutDown = true
    activeRuntime = undefined
    pendingSettle = undefined
    if (resetting) await resetting.catch(() => {})
    await runtime.dispose()
  })
  pi.on('cache_warming_decision', (_event, ctx) =>
    ctx.model?.provider === config.provider ? { action: 'stop' } : undefined,
  )
  pi.on('model_select', (event, ctx) => {
    const retarget =
      pendingSettle &&
      pendingSettle.runtime === activeRuntime &&
      pendingSettle.epoch === uiEpoch &&
      event.model?.provider === config.provider
        ? pendingSettle
        : undefined
    clearStatus(ctx)
    if (retarget) {
      retarget.epoch = uiEpoch
      retarget.ctx = ctx
      retarget.model = event.model
      pendingSettle = retarget
    }
    updateStatus(ctx, activeRuntime?.quota.peek(), event.model)
  })
  pi.on('agent_settled', (_event, ctx) => {
    // Pi 1.5.2 AgentSession._emitAgentSettled runs after tools and the run finish.
    runtime.settleSession(ctx.sessionManager.getSessionId())
    const current = activeRuntime
    if (!current || !ctx.hasUI || ctx.model?.provider !== config.provider) return
    if (pendingSettle?.runtime === current) {
      pendingSettle.epoch = uiEpoch
      pendingSettle.ctx = ctx
      pendingSettle.model = ctx.model
      return
    }
    const state: PendingSettle = {
      runtime: current,
      epoch: uiEpoch,
      ctx,
      model: ctx.model,
    }
    pendingSettle = state
    void current.quota
      .read(false)
      .then((snapshot) => {
        if (
          shutDown ||
          pendingSettle !== state ||
          state.runtime !== activeRuntime ||
          state.epoch !== uiEpoch ||
          snapshot.status !== 'ok'
        )
          return
        const targetCtx = state.ctx
        const model = state.model
        if (!targetCtx.hasUI || model?.provider !== config.provider) return
        updateStatus(targetCtx, snapshot, model)
        const quota = quotaForModel(snapshot, model)
        if (!quota || quota.fraction > 0.2) return
        const threshold = quota.fraction <= 0.05 ? 5 : 20
        const groupName = quota.group.name || 'Unnamed model group'
        const windowLabel =
          quota.bucket.window ||
          quota.bucket.name ||
          quota.bucket.id ||
          'quota'
        const key = `${groupName}:${quota.bucket.id}:${windowLabel}:${quota.bucket.resetTime || 'none'}:${threshold}`
        if (warned.has(key)) return
        warned.add(key)
        const percent = Math.round(
          displayFraction(quota.fraction, quotaDisplay) * 100,
        )
        const metric = `${percent}% ${quotaDisplay}`
        targetCtx.ui.notify(
          `Antigravity quota low: ${metric} (${groupName}, ${windowLabel}).`,
          'warning',
        )
      })
      .catch(() => {})
      .finally(() => {
        if (pendingSettle === state) pendingSettle = undefined
      })
  })
  const readQuotaSafe = async (): Promise<QuotaSnapshot> => {
    if (!activeRuntime)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: 'Antigravity ACP runtime is disposed.',
      }
    try {
      return await activeRuntime.readQuota(true)
    } catch (err) {
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  pi.registerCommand('agy-acp', {
    description: 'Antigravity ACP status, quota, or reset',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart()
      const items = [
        'status',
        'quota',
        'quota used',
        'quota remaining',
        'reset',
      ]
        .filter((command) => command.startsWith(normalized))
        .map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      if (shutDown) return
      const tokens = args.trim().split(/\s+/).filter(Boolean)
      const command = tokens[0] ?? ''
      const requestedDisplay =
        command === 'quota' && tokens.length === 2
          ? asQuotaDisplay(tokens[1])
          : undefined
      if (command === 'reset' && tokens.length === 1) {
        clearStatus(ctx)
        await reset()
        if (!shutDown) ctx.ui.notify('Antigravity ACP sessions reset', 'info')
        return
      }
      const isStatus =
        (command === '' || command === 'status') && tokens.length <= 1
      const isQuota =
        command === 'quota' &&
        (tokens.length === 1 || requestedDisplay !== undefined)
      if (!isStatus && !isQuota) {
        ctx.ui.notify(
          'Usage: /agy-acp [status|quota [used|remaining]|reset]',
          'warning',
        )
        return
      }
      if (requestedDisplay !== undefined) {
        quotaDisplay = requestedDisplay
        writeQuotaDisplayPreference(home, quotaDisplay)
      }
      let snapshot: QuotaSnapshot | null = null
      const epoch = uiEpoch
      if (command === 'quota') {
        snapshot =
          ctx.mode === 'tui' && typeof ctx.ui.custom === 'function'
            ? await ctx.ui.custom<QuotaSnapshot | null>(
                (tui, theme, _kb, done) => {
                  const loader = new BorderedLoader(
                    tui,
                    theme,
                    'Fetching Antigravity quota...',
                  )
                  loader.onAbort = () => done(null)
                  // readQuotaSafe converts runtime errors into snapshots so loaders always close cleanly.
                  void readQuotaSafe().then((result) => {
                    if (!loader.signal.aborted) done(result)
                  })
                  return loader
                },
              )
            : await readQuotaSafe()
        if (shutDown) return
        if (snapshot === null) {
          if (epoch === uiEpoch) updateStatus(ctx, activeRuntime?.quota.peek())
          ctx.ui.notify('Quota check cancelled', 'info')
          return
        }
      }
      const notice = snapshot
        ? formatQuota(snapshot, undefined, quotaDisplay)
        : formatStatus(runtime.status())
      if (epoch === uiEpoch)
        updateStatus(ctx, snapshot ?? activeRuntime?.quota.peek())
      ctx.ui.notify(notice.text, notice.level)
    },
  })
}
