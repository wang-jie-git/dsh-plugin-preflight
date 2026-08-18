/**
 * dsh-diagram-design — Diagram Design skill adapter for DSH
 *
 * Wraps cathrynlavery/diagram-design (28 editorial diagram types, self-contained
 * HTML+SVG, no Mermaid-slop) as DSH tools.
 *
 * The original project is a prompt-driven agent skill (SKILL.md + references +
 * example HTML assets). DSH has no Claude Code marketplace, so this plugin
 * adapts it into two tools:
 *
 *   1. diagram_design_load  — read skill, type reference, and (optionally) an
 *      example HTML into the model context. The model then authors the diagram
 *      HTML using those editorial rules.
 *   2. diagram_design_save  — persist the model-authored HTML into the working
 *      directory (default cwd, configurable via `outputDir`).
 *
 * Assets live under `assets/diagram-design/` inside this plugin (vendored from
 * the upstream skill).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']
export const name = 'dsh-diagram-design'
export const version = '0.1.0'

/** 上游 skill 资产根目录（本插件 vendored 副本） */
const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_ROOT = join(__dirname, '..', 'assets', 'diagram-design')

/** 可识别的 28 种图类型 → type-*.md 参考文件 */
const VISUAL_TYPES = {
  architecture: 'type-architecture.md',
  'it-state': 'type-it-state.md',
  'it-current-state': 'type-it-state.md',
  flowchart: 'type-flowchart.md',
  sequence: 'type-sequence.md',
  'state-machine': 'type-state.md',
  er: 'type-er.md',
  'data-model': 'type-er.md',
  timeline: 'type-timeline.md',
  swimlane: 'type-swimlane.md',
  quadrant: 'type-quadrant.md',
  radar: 'type-radar.md',
  spider: 'type-radar.md',
  loop: 'type-loop.md',
  flywheel: 'type-loop.md',
  nested: 'type-nested.md',
  tree: 'type-tree.md',
  'org-chart': 'type-org-chart.md',
  'layer-stack': 'type-layers.md',
  layers: 'type-layers.md',
  venn: 'type-venn.md',
  pyramid: 'type-pyramid.md',
  funnel: 'type-pyramid.md',
  bar: 'type-bar.md',
  treemap: 'type-treemap.md',
  line: 'type-line.md',
  gantt: 'type-gantt.md',
  scatter: 'type-scatter.md',
  'high-level': 'type-high-level.md',
  process: 'type-process.md',
  medallion: 'type-medallion.md',
  'data-flow': 'type-data-flow.md',
  'dp-integration': 'type-dp-integration.md',
  'dp-security-matrix': 'type-dp-security-matrix.md',
}

/** 常用语义模式 → 最近视觉类型（用于路由） */
const SEMANTIC_PATTERNS = {
  'fan-in-bottleneck': 'data-flow',
  'stage-framework': 'process',
  'unstructured-input': 'data-flow',
  'paired-policy-traces': 'flowchart',
  'secure-paved-road': 'architecture',
  'governance-catalog': 'layer-stack',
  'compensating-security-layers': 'layer-stack',
}

function slugify(v) {
  return String(v).trim().toLowerCase()
}

function resolveTypeRef(type) {
  return VISUAL_TYPES[slugify(type)] ?? null
}

function readAsset(relPath) {
  return readFile(join(ASSETS_ROOT, relPath), 'utf8')
}

/**
 * 组装加载 payload：skill 骨架 + type 参考 + 可选示例 HTML
 */
async function buildLoadPayload({ type, semanticPattern, variant, includeExample }) {
  const typeRef = resolveTypeRef(type)

  const chunks = []
  chunks.push('# Diagram Design — Agent Skill (adapted for DSH)')
  chunks.push('')
  chunks.push('## 0. 定位')
  chunks.push('')
  chunks.push('你将生成**自包含的 HTML+SVG 编辑级示意图**（无外部依赖、无构建步骤、无 Mermaid 式丑图）。')
  chunks.push('先读下面的规范，再严格按规范生成。')
  chunks.push('')

  // SKILL.md 骨架（哲学 + 选择指南 + 反模式）
  const skill = await readAsset('SKILL.md')
  const skillLines = skill.split('\n')
  chunks.push('## 1. 核心规范（SKILL.md 摘录）')
  chunks.push('')
  chunks.push(skillLines.slice(0, 60).join('\n'))
  chunks.push('')

  // semantic pattern → 最近类型参考
  if (semanticPattern) {
    const nearest = SEMANTIC_PATTERNS[slugify(semanticPattern)] ?? null
    const spRef = nearest ? resolveTypeRef(nearest) : null
    if (spRef) {
      try {
        const spDoc = await readAsset(spRef)
        chunks.push('## 2. 语义模式指引')
        chunks.push('')
        chunks.push(spDoc.slice(0, 3000))
        chunks.push('')
      } catch { /* 语义模式文档缺失不影响主流程 */ }
    }
  }

  // type 参考
  const typeDoc = await readAsset(typeRef)
  chunks.push(`## 3. 视觉类型 ${type} 规范`)
  chunks.push('')
  chunks.push(typeDoc)
  chunks.push('')

  // 示例 HTML（可选）
  if (includeExample) {
    const exType = type
    const exFile = variant
      ? `example-${slugify(exType)}-${slugify(variant)}.html`
      : `example-${slugify(exType)}.html`
    try {
      const exHtml = await readAsset(exFile)
      chunks.push('## 4. 示例 HTML（参考输出结构）')
      chunks.push('')
      chunks.push(`文件: ${exFile} (${exHtml.length} 字符)`)
      chunks.push('')
      chunks.push(exHtml.slice(0, 4000))
      chunks.push('')
      chunks.push('（示例已截断；完整参考在插件资产目录）')
    } catch {
      chunks.push(`（无匹配示例 ${exFile}，跳过）`)
    }
  }

  chunks.push(`## 5. 输出要求`)
  chunks.push('')
  chunks.push('- 产出 **单个自包含 HTML 文件**，内联全部 CSS/SVG，无外部 CDN/字体/图片依赖')
  chunks.push('- 遵循上面哲学：节点克制（密度 4/10）、强调色仅 1-2 处、无 3 等宽卡片、无霓虹渐变')
  chunks.push('- 遵循 type 参考指定的布局语法与尺寸预设')
  chunks.push('- 完成后调用 diagram_design_save 保存文件，返回保存路径')
  chunks.push('')
  chunks.push('如果用户指定了品牌色/风格，据此覆盖 style-guide 默认 tokens（纸 #f5f5f5、墨 #2d3142、强调 #eb6c36 atomic-tangerine）。')

  return chunks.join('\n')
}

export function apply(ctx, config = {}) {
  const outputDir = String(config?.outputDir ?? '').trim() || process.cwd()

  ctx.tools.register(defineTool({
    name: 'diagram_design_load',
    description:
      '加载 Diagram Design 图表生成规范到上下文。调用后模型将学习对应的视觉类型语法、编辑设计系统与输出要求，随后应生成自包含 HTML+SVG 图表并调用 diagram_design_save 保存。',
    parameters: {
      type: {
        type: 'string',
        required: true,
        description:
          '图类型，如 architecture / flowchart / sequence / state-machine / er / timeline / swimlane / quadrant / radar / loop / nested / tree / org-chart / layer-stack / venn / pyramid / bar / treemap / line / gantt / scatter / high-level / process / data-flow / it-state / medallion / dp-integration / dp-security-matrix',
      },
      semantic_pattern: {
        type: 'string',
        description:
          '可选语义模式，如 fan-in-bottleneck / stage-framework / secure-paved-road / governance-catalog / compensating-security-layers，路由到最近的视觉类型。',
      },
      variant: {
        type: 'string',
        description: '示例变体：light / dark / full（默认 light）。',
      },
      include_example: {
        type: 'boolean',
        description: '是否附加一个上游示例 HTML 片段（默认 true）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context: {
            type: 'string',
            required: true,
            description: '组装好的图表示范上下文（markdown + 截断示例）。',
          },
          bytes: {
            type: 'integer',
            required: true,
            description: '上下文总字节数。',
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.context,
      }],
    },
    async execute(args) {
      const typeRef = resolveTypeRef(args.type)
      if (!typeRef) {
        throw new Error(`未知图类型 "${args.type}"。支持：${Object.keys(VISUAL_TYPES).join(', ')}`)
      }
      const context = await buildLoadPayload({
        type: args.type,
        semanticPattern: args.semantic_pattern,
        variant: args.variant ?? 'light',
        includeExample: args.include_example !== false,
      })
      return { context, bytes: Buffer.byteLength(context, 'utf8') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diagram_design_save',
    description:
      '保存由 diagram_design_load 规范生成的图表 HTML 到输出目录（默认当前工作目录）。返回最终文件路径。',
    parameters: {
      filename: {
        type: 'string',
        required: true,
        description: '目标文件名（应包含 .html 后缀）。',
      },
      html: {
        type: 'string',
        required: true,
        description: '完整自包含 HTML 内容。',
      },
      subdir: {
        type: 'string',
        description: '可选子目录（相对输出目录）；默认直接放在输出目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `已保存图表到 ${value.path} (${value.bytes} bytes)`,
      }],
    },
    async execute(args) {
      const root = resolve(outputDir)
      const target = join(root, args.subdir ? slugify(args.subdir) : '.', args.filename)
      if (!target.startsWith(root + '/') && target !== join(root, args.filename)) {
        throw new Error('目标路径超出输出目录')
      }
      await writeFile(target, args.html, 'utf8')
      return { path: target, bytes: Buffer.byteLength(args.html, 'utf8') }
    },
  }))

  ctx.logger?.info?.(`dsh-diagram-design: 已注册 diagram_design_load / diagram_design_save（资产 ${ASSETS_ROOT}）`)
}