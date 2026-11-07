import {
  BorderedLoader,
  type ExtensionAPI,
  type ProviderModelConfig,
} from '@earendil-works/pi-coding-agent'
import { AntigravityRuntime } from './src/runtime.ts'
import { defaults } from './src/config.ts'
import { spawnAcp, runCommand } from './src/host.ts'
import { streamPi } from './src/pi-stream.ts'
import { formatQuota, formatStatus } from './src/format.ts'
import type { QuotaSnapshot } from './src/quota.ts'

export default function (pi: ExtensionAPI) {
  const config = {
    ...defaults,
    command: process.env.PI_AGY_COMMAND || '',
    home: process.env.PI_AGY_HOME || '',
  }
  const createRuntime = () =>
    new AntigravityRuntime({
      config,
      spawnAcp,
      runCommand,
      log: { info: () => {}, warn: (message) => console.error(message) },
      onModelsChanged: () => register(),
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
        if (context?.allowNetwork !== false && !context?.signal?.aborted) {
          await runtime.warmup()
        }
        return models()
      },
    })
  register()
  const reset = async () => {
    await runtime.dispose()
    runtime = createRuntime()
  }
  pi.on('session_tree', reset)
  pi.on('session_compact', reset)
  pi.on('session_shutdown', async () => {
    await runtime.dispose()
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
        await reset()
        ctx.ui.notify('Antigravity ACP sessions reset', 'info')
        return
      }
      if (command !== '' && command !== 'status' && command !== 'quota') {
        ctx.ui.notify('Usage: /agy-acp [status|quota|reset]', 'warning')
        return
      }
      let snapshot: QuotaSnapshot | null = null
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
      ctx.ui.notify(notice.text, notice.level)
    },
  })
}
