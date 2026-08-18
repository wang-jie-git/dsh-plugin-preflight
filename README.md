# dsh-plugin-preflight

> DSH 插件安装预检闸 — 装前检测，装后验证，失败自动回滚

## 背景

2026-08-17 双包危害事故后设计的防复发机制。

DSH 官方（`apps/cli/src/plugin.ts`）安装是全 pnpm 转发 + 装后 reconcile，**零预检**；市场插件（`dsh-plugin-marketplace`）只有安全护栏（防外部攻击），**无插件间冲突检测**。

本插件补上「安装前预检」这道闸。

## 功能

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | **服务名冲突** | 待装插件声明的 `cordis.patch.yml` id 是否与已启用插件的服务名冲突 → 避免 `service has been registered` |
| 2 | **peerDependencies 红线** | 目标插件是否 `peerDependencies` 指向 `@deepseek-ai/*` 核心包 → pnpm 默认 auto-install-peers 会装多份副本，触发双包危害 |
| 3 | **双包危害检测** | 核心包(`@deepseek-ai/dsh-tools` 等)在 profile 中是否为物理副本而非 symlink → 导致 `Symbol` 分裂，报 `reading 'prepare'` |
| 4 | **配置语法** | 全局 + profile 两级 `cordis.patch.yml` 完整 YAML 解析（顶级必须是数组，空文件单独报错） |
| 5 | **插件依赖完整性** | 扫描 patch.yml 所有 `name:` 条目：相对路径查文件，npm 包名查 node_modules → 防"配置引用了未安装插件" |
| 6 | **干运行启动测试**（可选） | spawn `dsh --port 0` 子进程，15s 超时后 kill，扫描 stderr 错误 → 覆盖全部运行时错误 |

> v0.2.0 新增检查 4/5/6。检查 6 通过 `{ "dryRun": true }` 显式请求。

## 自动拦截

劫持 `/api/marketplace/install` 路由，安装完成后自动运行预检：

- 通过 → 放行
- 失败 → 自动回滚（删除插件目录 + 从 `cordis.patch.yml` 移除条目）

## 手动检查

```bash
# 基础检查（检查 1-5）
curl -X POST /api/preflight/check \
  -H 'Content-Type: application/json' \
  -d '{"packageDir": "/path/to/plugin"}'

# 完整检查（含干运行启动测试，检查 6）
curl -X POST /api/preflight/check \
  -H 'Content-Type: application/json' \
  -d '{"packageDir": "/path/to/plugin", "dryRun": true}'
```

## 安装

```bash
dsh plugin install wang-jie-git/dsh-plugin-preflight
```

## 更新

已部署的插件目录是 symlink 到本地 git clone：

```
~/.dsh/profiles/web/plugins/dsh-plugin-preflight
  → /Users/mac/dsh-dev/plugins/dsh-plugin-preflight  (git repo)
```

更新只需一条命令：

```bash
cd /Users/mac/dsh-dev/plugins/dsh-plugin-preflight && git pull origin main
```

DSH HMR 自动热加载，**无需重启进程**。

可选：写入 shell 别名

```bash
# ~/.zshrc
alias update-preflight='cd /Users/mac/dsh-dev/plugins/dsh-plugin-preflight && git pull origin main'
```

## 检查项详解

### 双包危害（Dual Package Hazard）

当同个包在 profile 中存在物理副本（非 symlink）时，Node.js 的 `require` 会加载两个不同的实例，导致 `Symbol.for()` 创建的全局 Symbol 不相等。典型症状：

```
TypeError: reading 'prepare'
```

检查逻辑：
1. 扫描 `@deepseek-ai/*` 和顶层库（react, zod, schemastery, cosmokit）是否有物理副本
2. 实测 `TOOL_RUNTIME_SCHEDULER` Symbol 是否在宿主和 profile 间一致

### peerDependencies 红线

核心包列表：`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-commands`

### 服务名冲突

扫描三类来源：
1. profile 级别的 `cordis.patch.yml`
2. `plugins/` 目录下的每个已启用插件
3. 已安装的 profilePatchId

## 协议

MIT