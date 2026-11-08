import {
  BorderedLoader,
  type ExtensionAPI,
  type ProviderModelConfig,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { AntigravityRuntime } from './src/runtime.ts'
import { defaults } from './src/config.ts'
import { spawnAcp, runCommand } from './src/host.ts'
import { streamPi } from './src/pi-stream.ts'
import {
  formatQuota,
  formatStatus,
  formatQuotaStatus,
  quotaForModel,
} from './src/format.ts'
import type { QuotaSnapshot } from './src/quota.ts'

export default function (pi: ExtensionAPI) {
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
      runCommand,
      log: { info: () => {}, warn: () => {} },
      onModelsChanged: () => {
        if (refreshDepth === 0) register()
      },
    })
  let runtime = createRuntime()
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
  let checkingQuota = false
  const warned = new Set<string>()
  const clearStatus = (ctx?: ExtensionContext) => {
    uiEpoch++
    if (ctx?.hasUI) ctx.ui.setStatus(config.provider, undefined)
  }
  const updateStatus = (
    ctx: ExtensionContext,
    snapshot?: QuotaSnapshot,
    explicit = false,
    model = ctx.model,
  ) => {
    if (ctx.hasUI && (explicit || model?.provider === config.provider))
      ctx.ui.setStatus(
        config.provider,
        snapshot ? formatQuotaStatus(snapshot, model?.id) : undefined,
      )
  }
  const reset = async () => {
    uiEpoch++
    warned.clear()
    await runtime.dispose()
    runtime = createRuntime()
  }
  pi.on('session_tree', () => runtime.resetConversations())
  pi.on('session_compact', () => runtime.resetConversations())
  pi.on('session_start', async (event, ctx) => {
    clearStatus(ctx)
    if (['new', 'resume', 'fork'].includes(event.reason))
      await runtime.resetConversations()
    updateStatus(ctx, runtime.quota.peek())
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    clearStatus(ctx)
    await runtime.dispose()
  })
  pi.on('cache_warming_decision', () => ({ action: 'stop' }))
  pi.on('model_select', (event, ctx) => {
    clearStatus(ctx)
    updateStatus(ctx, runtime.quota.peek(), false, event.model)
  })
  pi.on('agent_settled', (_event, ctx) => {
    if (
      ctx.model?.provider !== config.provider ||
      checkingQuota ||
      runtime.quota.pending
    )
      return
    const current = runtime
    const epoch = uiEpoch
    checkingQuota = true
    void current.quota
      .read(false)
      .then((snapshot) => {
        if (
          current !== runtime ||
          epoch !== uiEpoch ||
          snapshot.status !== 'ok'
        )
          return
        updateStatus(ctx, snapshot)
        if (!ctx.hasUI || ctx.model?.provider !== config.provider) return
        const quota = quotaForModel(snapshot, ctx.model.id)
        if (!quota || quota.fraction > 0.2) return
        const threshold = quota.fraction <= 0.05 ? 5 : 20
        const key = `${quota.group.name}:${quota.bucket.id}:${quota.bucket.window}:${quota.bucket.resetTime || 'none'}:${threshold}`
        if (warned.has(key)) return
        warned.add(key)
        ctx.ui.notify(
          `Antigravity quota low: ${Math.round(quota.fraction * 100)}% remaining (${quota.group.name}, ${quota.bucket.window}).`,
          'warning',
        )
      })
      .catch(() => {})
      .finally(() => {
        checkingQuota = false
      })
  })
  pi.registerCommand('agy-acp', {
    description: 'Antigravity ACP status, quota, or reset',
    getArgumentCompletions: (prefix) => {
      const items = ['status', 'quota', 'reset']
        .filter((command) => command.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      const command = args.trim()
      if (command === 'reset') {
        clearStatus(ctx)
        await reset()
        ctx.ui.notify('Antigravity ACP sessions reset', 'info')
        return
      }
      if (command !== '' && command !== 'status' && command !== 'quota') {
        ctx.ui.notify('Usage: /agy-acp [status|quota|reset]', 'warning')
        return
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
                  // QuotaReader returns error snapshots, so failures also close the loader.
                  void runtime.readQuota(true).then((result) => {
                    if (!loader.signal.aborted) done(result)
                  })
                  return loader
                },
              )
            : await runtime.readQuota(true)
        if (snapshot === null) {
          ctx.ui.notify('Quota check cancelled', 'info')
          return
        }
      }
      const notice = snapshot
        ? formatQuota(snapshot)
        : formatStatus(runtime.status())
      if (epoch === uiEpoch)
        updateStatus(ctx, snapshot ?? runtime.quota.peek(), true)
      ctx.ui.notify(notice.text, notice.level)
    },
  })
}
