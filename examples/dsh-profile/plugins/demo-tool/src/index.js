/**
 * dsh-demo-tool — 演示 v2 技能要点的示例插件
 *
 * 覆盖：
 *  - 插件配置（Config + Schemastery）
 *  - defineTool 完整契约（parameters / output / execute / presentCall）
 *  - exec.signal 协作取消
 *  - 环境变量回退（可配置 vs 环境）
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-demo-tool'
export const inject = ['tools']

// JS 插件：不要用 TS 的 interface/泛型；用 JSDoc 提供类型提示
/** @typedef {{ greeting: string, simulateLatency: boolean }} Config */

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
  simulateLatency: Schema.boolean().default(false),
})

export function apply(ctx, /** @type {Config} */ config) {
  ctx.tools.register(defineTool({
    name: 'demo_greet',
    description: '向指定的人问好，并回显当前插件的问候语配置。',
    parameters: {
      name: { type: 'string', required: true, description: '要问候的人名' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall(args) {
      return { card: 'generic', title: 'demo_greet', kind: 'chat', rawInput: args }
    },
    async execute(args, exec) {
      const greeting = config.greeting || process.env.DEMO_GREETING || 'Hello'
      if (config.simulateLatency) {
        // 演示 signal 协作取消：1 秒内可被取消
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000)
          exec.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('cancelled by caller'))
          })
        })
      }
      return `${greeting}, ${args.name}!`
    },
  }))
}