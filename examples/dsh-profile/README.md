# dsh-profile — DSH 完整插件环境示例

本目录是 `~/.dsh/profiles/web/` 的**脱敏副本**，用于复现 DSH 的完整插件环境。

## 包含内容

```
dsh-profile/
├── cordis.patch.yml            # 核心插件配置（搜索提供商、插件启用/禁用、隧道）
├── package.json                # npm 依赖清单（已脱敏：gh-proxy → 直连 github）
├── pnpm-workspace.yaml         # 构建配置（allowBuilds 白名单、peer 策略）
├── .npmrc                      # npm 配置（防双包分裂）
├── plugins/                    # profile 内本地插件源码
│   ├── demo-tool/              # 演示插件
│   ├── dsh-plugin-preflight/   # 安装预检闸 v0.2.0
│   └── dsh-web-search-wigolo/  # Wigolo 搜索适配器
```

## 环境依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 18 | DSH 运行时 |
| pnpm | ≥ 9 | 包管理 |
| `wigolo` (npm 全局) | ≥ 0.2 | 免费无 key 搜索 |
| `cloudflared` | 自动 | 移动端远程控制隧道 |

## 复现步骤

```bash
# 1. 创建 profile
mkdir -p ~/.dsh/profiles/web
cd ~/.dsh/profiles/web

# 2. 复制本目录内容
cp -r <repo>/examples/dsh-profile/* .

# 3. 安装依赖（记住：不会自动下载，需先构建 workspace）
pnpm install
pnpm approve-builds   # 允许 cloudflared、node-pty 等原生包构建

# 4. 启动
npx @deepseek-ai/dsh web
```

## 脱敏说明

- `package.json` 中 `@liustack/modsearch` 的安装源已从个人代理
  `gh-proxy.com` 改为 GitHub 直连（该仓库为公开仓库）
- `dsh-web-search-wigolo` 中的全局二进制路径已改为跨平台展开 `homedir()`
- 不包含任何 API Key、Token 或本地用户路径

## 相关仓库

- 预检闸源码: https://github.com/wang-jie-git/dsh-plugin-preflight
- DSH 官方: https://github.com/deepseek-ai/deepseek-harness