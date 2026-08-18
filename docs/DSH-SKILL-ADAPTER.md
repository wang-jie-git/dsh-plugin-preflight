---
name: dsh-skill-adapter
description: 将第三方 agent skill / CLI / MCP 工具适配为 DSH 插件的完整方法论。基于真实实战（diagram-design 提示词驱动适配 → dsh-diagram-design；wigolo CLI 适配 → dsh-web-search-wigolo）提炼的可复用工作流。涵盖：目标项目形态分析、三种适配模式选型（提示词驱动/CLI 包装/MCP 桥接）、vendored 资产策略、defineTool 契约坑、验证流程（node --check / 模拟 ctx / --dump-config / 重启查日志）、脱敏与发布。用于把 Claude Code skill、Codex 插件、GitHub 上的 AI 技能仓库接入 DSH。
when-to-use: 用户说"把 X 装进 DSH"、"写个适配插件接 Y"、"X 能用吗（外部 AI skill 工具）"、或遇到 github 上高星但只支持 Claude Code/Codex 的 skill 仓库想接入 DSH 时触发。
---

# DSH 第三方 Skill 适配方法论

把 GitHub 上高星但**只支持 Claude Code / Codex / Cursor** 的 AI skill、CLI、MCP 工具接入 DSH 的可复用工作流。

> 背景事实：多数知名 agent skill（diagram-design 21k★、其他 editor 类工具）只发布为 Claude Code 插件 / Codex skill / 通用 npx skill，官方 DSH 市场往往没有对应包。适配器是我们的 `dsh-plugin-preflight` / `dsh-web-search-wigolo` / `dsh-diagram-design` 之后验证过的标准做法。

---

## 0. 适配前的形态分析（30 秒决策）

拿到目标项目，先判断它是**哪种形态**，这直接决定适配模式：

| 形态 | 特征 | 适配模式 | 例子 |
|---|---|---|---|
| **提示词驱动 skill** | `SKILL.md` + `references/*.md` + 示例 HTML，无 CLI、无构建步骤，本质是"AI 读规范自己写输出" | **load + save 工具链** | diagram-design 28 种 HTML+SVG 图表 |
| **CLI 工具** | 有可执行二进制 / npm CLI，stdin/stdout 交互 | **CLI 包装工具**（execFile 调用 + JSON 适配） | wigolo（search/fetch CLI） |
| **MCP 服务器** | 配置为 MCP server，走工具协议 | **MCP 桥接**（dsh-mcp-client 已有能力，可能只需配置） | 任意 mcp 服务器 |
| **纯配置插件** | 官方就有 DSH 包 | 直接 `dsh plugin add`，不写适配器 | dsh-web-ui-all |

**判断口诀**：`ls` 仓库结构——没有 `bin`/`scripts` 可执行入口、只有 `skills/` 目录和 markdown → 提示词驱动。有 `package.json` 的 `bin` 字段或 `.mjs`/`.py` 脚本 → CLI 驱动。README 写 "Add MCP server" → MCP 桥接。

---

## 1. 三种适配模式

### 1.1 提示词驱动 skill → load + save 工具链（推荐给 editor 类项目）

适用：产物是"AI 按规范生成的文本/HTML/文件"，项目本身只用提示词约束模型。

**两个工具**：

```js
// 工具 1：load — 把 skill 规范 + type 参考 + 示例注入模型上下文
diagram_design_load({ type, semantic_pattern?, variant?, include_example? })
  → { context: string }   // SKILL.md 摘录 + type-*.md + 示例 HTML 片段

// 工具 2：save — 把模型产物落盘
diagram_design_save({ filename, html, subdir? })
  → { path, bytes }
```

**关键设计点**：
- 资产（SKILL.md + references + 示例）**vendored 进插件目录** `assets/<project>/`，用 `readFile(join(ASSETS_ROOT, rel))` 读取，不依赖网络。
- SKILL.md 不要全量塞上下文：截取**哲学 + 选择指南 + 反模式**（前 60 行左右），type 细节单独从 `type-*.md` 加载对应文件。
- 示例 HTML 只传片段（如 4000 字符），防止上下文爆炸，注明"完整参考在插件资产目录"。
- save 必须**防路径逃逸**：`target.startsWith(resolve(outputDir) + '/')` 校验。
- outputDir 用 `config?.outputDir ?? process.cwd()` 可配置。

### 1.2 CLI 工具 → execFile 包装工具

适用：wigolo 这类有 npm CLI 的工具。核心是二进制定位 + JSON 输出适配。

```js
// 二进制定位：profile node_modules → 全局 → PATH 三级 fallback
const profileBin = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'wigolo')
const globalBin = join(homedir(), '.npm-global', 'bin', 'wigolo')  // 跨平台，绝不硬编码 /Users/xxx
_bin = existsSync(profileBin) ? profileBin : existsSync(globalBin) ? globalBin : 'wigolo'

// 调用：promisify(execFile) + --json 输出
const { stdout } = await execFileAsync(bin, [tool, ...args, '--json'], { timeout: 30000 })
return JSON.parse(stdout)
```

**绝密教训**：全局路径必须 `join(homedir(), ...)` 跨平台展开，不要硬编码 `/Users/mac/...` —— 否则仓库脱敏和他人复现都会踩坑（我们在 `dsh-web-search-wigolo` 上踩过并修复）。

### 1.3 MCP 桥接

目标真的是 MCP server 时，先检查 `dsh-mcp-client`（官方）能否直接配置接入；能则只写 `cordis.patch.yml` 配置，不写代码。`wigolo` 早期踩坑就是"想当 MCP 用但注册的是 WebSearchProvider"，混了两个系统。

---

## 2. defineTool 契约（必踩的坑）

`ctx.tools.register` 接受 **defineTool 产出的对象**，不是裸对象。少了 `output` 会直接启动失败：

```
TypeError: tool "xxx" must declare output { schema, render, presentationMeta? }
```

**最小可用形状**（从 `@deepseek-ai/dsh-tool-fs` 验证）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '...',
  parameters: {
    input: { type: 'string', required: true, description: '...' },
  },
  output: {
    schema: {                              // 必须有
      type: 'object',
      additionalProperties: false,
      properties: { result: { type: 'string', required: true } },
    },
    render: (args, value) => [{ type: 'text', text: value.result }],  // 必须有
  },
  async execute(args) {
    return { result: `done: ${args.input}` }
  },
}))
```

**规则速记**：
- 没有 `output.schema` + `output.render` → Cordis 拒绝加载，插件树整体失败（不止单个工具）。
- `render` 返回 `[{ type: 'text', text }]` 数组（官方格式）。
- `parameters` 的根节点默认 open，显式对象建议 `additionalProperties: false`（与 dsh-tool-fs 一致）。
- JS 插件（非 TS）直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`，profile 的 node_modules 可解析（宿主 `~/.npm/_npx/<hash>/node_modules/@deepseek-ai/` 提供）。

**插件骨架**（函数形式）：

```js
export const inject = ['tools']   // 工具插件必需
export const name = 'dsh-my-adapter'
export const version = '0.1.0'

export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({ ... }))
  ctx.logger?.info?.(`${name}: 已注册 ...`)
}
```

---

## 3. 资产 vendored 策略

| 问题 | 答案 |
|---|---|
| 资产放哪 | `plugins/<name>/assets/<upstream-project>/`（插件自包含） |
| 怎么获取 | `git clone --depth 1 <url> /tmp/xxx && cp -R /tmp/xxx/skills/<proj> <plugin>/assets/` |
| 多大合适 | 2-3MB 可接受；不要提交无关文件（上游 `.git`、node_modules 必须删） |
| 同步到仓库 | `examples/dsh-profile/plugins/<name>/`（脱敏副本，供复现） |
| 切换分支 | asset 版本固定，README 记录上游 commit/版本 |

---

## 4. 验证流程（写完后必跑，顺序执行）

```
1. node --check src/index.js                    # 语法
2. node -e "import(...).then(m => { 模拟 ctx 注册 })"   # 模拟 ctx：两个工具应注册成功
3. 主 profile cordis.patch.yml 加 insert 条目
4. pkill -f "dsh.*web"; 重启 npx dsh web          # 重启加载
5. grep -iE "failed to load|TypeError" log；grep "diagram" log   # 无失败
6. curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/  # 200
7. npx dsh web --dump-config | grep <plugin-id>    # 配置树确认
```

**模拟 ctx 验证片段**：

```js
node -e "
import('./src/index.js').then(mod => {
  const registered = []
  const ctx = { tools: { register: t => registered.push(t.name) }, logger: { info: () => {} } }
  mod.apply(ctx, {})
  console.log('注册:', registered.join(', '))
})"
```

**失败快速定位**：`failed to apply loader entry <id>` → 插件树整体失败，先看 `node --check` 和 defineTool 契约（缺 output 最常见），再看 inject 服务名（`tools` 而不是 `tool`）。

---

## 5. 脱敏与发布

- 全局路径：`join(homedir(), ...)`，禁用 `/Users/<user>`（`dsh-web-search-wigolo` 教训）。
- 私有代理：`gh-proxy.com` 等个人 URL 换成 GitHub 直连或从配置移除。
- 敏感扫描：`grep -rnE "(Users/mac|/Applications/One|gh-proxy|sk-[a-zA-Z0-9]{20,}|AKIA)" examples/` 应 0 命中。
- 恢复到别人机器：`examples/dsh-profile/` 按 README 复现（pnpm install + approve-builds）。

---

## 6. 现状引用（2026-08-18 验证）

- ✅ `dsh-diagram-design` v0.1.0 — diagram-design 提示词驱动适配，负载/保存工具已注册，DSH 正常。
- ✅ `dsh-web-search-wigolo` v0.1.0 — wigolo CLI 包装，搜索提供商已注册。
- ✅ `dsh-plugin-preflight` v0.2.0 — DSH 插件预检闸（安装后 dry-run、配置语法、依赖完整性、双包危害）。

新适配开工前，对照 §0 形态表 30 秒选型；写工具前过一遍 §2 契约；完成后按 §4 验证流程走完再交付。