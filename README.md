<div align="center">

# EVA Tick Server

**为大模型、AI Agent 与自动化客户端提供更规范、更可读的金融数据。**

[![CI](https://github.com/xiaochaohit/evatick-server/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaochaohit/evatick-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](package.json)

[English](README.en.md) · 简体中文

</div>

EVA Tick Server（`evatickd`）将分散、异构的市场数据转换为适合大模型理解和调用的规范化、可读、版本化 JSON。它维护规范金融标的目录，完成搜索与解析、查询路由、超时重试、数据源回退和结果规范化，并通过 HTTP API 服务 EVA CLI、AI Agent 与其他自动化客户端。

当前版本覆盖中国内地 A 股、上交所/深交所/中证指数、六家中国期货交易所，以及按交易所隔离的 Binance 和 Coinbase 加密货币。同花顺扶摇提供官方 A 股与指数目录、快照和日线，AKShare 补充分钟线、复权因子与期货能力；任何单一数据提供方都不是服务的产品边界。

<!-- 媒体位：将快速演示 GIF/WebP 放在 docs/assets/evatick-demo.webp，然后取消下一行注释。 -->
<!-- ![EVA Tick Server 快速演示](docs/assets/evatick-demo.webp) -->

## 为大模型与 AI Agent 而设计

传统金融数据接口往往直接暴露数据源特有的函数、代码和字段，增加了模型理解、工具调用和跨数据源组合的难度。EVA Tick Server 在模型与数据提供方之间建立稳定的语义层：

- **可理解的领域语义**：使用金融标的、行情快照、行情柱和指数成分等统一概念，减少模型对上游术语的猜测。
- **可预测的结构**：用带版本号的 JSON Schema、规范字段和稳定标的 ID 提高工具调用与结果解析的可靠性。
- **可追溯的结果**：返回数据来源、抓取时间、部分结果、陈旧状态和警告，让模型能够表达不确定性。
- **可组合的发现流程**：通过目录、搜索和解析接口，将自然语言或交易代码安全地映射到规范金融标的。

## 为什么选择 EVA Tick Server

- **提供方无关的契约**：客户端面向稳定的金融标的与市场数据模型，而不是上游库的函数或字段。
- **规范标的身份**：用类似 `cn:equity:XSHE:000001` 的稳定 ID 关联交易代码、别名与提供方标识。
- **可靠的查询路径**：内置健康检查、超时、重试、数据源回退，以及显式的部分结果和陈旧数据标记。
- **本地优先的数据管理**：使用 SQLite 保存标的目录、DuckDB 保存历史行情，并通过管理中心执行浏览和同步。
- **面向自动化**：OpenAPI 是客户端集成的协议源；响应包含版本化 `schema`、来源元数据与结构化错误。

## 功能与覆盖范围

| 金融标的 | 市场范围 | 行情快照 | 行情柱 | 指数成分 |
| --- | --- | :---: | :---: | :---: |
| 股票 | 中国内地 A 股 | ✓ | 分钟、日线 | — |
| 指数 | 上交所、深交所、中证指数 | ✓ | 分钟、日线 | ✓ |
| 期货 | CFFEX、SHFE、INE、CZCE、DCE、GFEX | ✓ | 合约日线；未复权主力连续 | — |
| 加密货币 | Binance、Coinbase Exchange | ✓ | 分钟至月线（依交易所能力） | — |

加密货币按交易所建立独立规范标的，例如 `global:crypto:BINANCE:BTC-USDT`
和 `global:crypto:COINBASE:BTC-USDT`。服务端不会在两个交易所之间自动回退或混合价格。

服务端还提供：

- 标的目录、详情、搜索与带上下文的解析
- 多数据源健康检查、请求超时、重试和失败回退
- 历史日线与 1 分钟行情柱后台同步、断点恢复和每日计划
- 使用新浪财经免费日线按期货品种同步未复权主力连续序列；月份合约同样直接读取新浪日线，东方财富仅用于发现当前合约目录
- API 密钥认证及符合 RFC 9457 风格的 `application/problem+json` 错误
- 管理员登录、密钥管理、数据浏览、同步控制，以及可调整回退顺序的数据源管理页面

> [!NOTE]
> 行情可用性受上游数据源、交易时段和网络状况影响。当前覆盖范围不代表全球全部金融标的或全部市场数据能力。

## 快速开始

### 1. 环境要求

- Node.js 22.19 或更高版本
- pnpm 11（仓库锁定版本为 11.7.0）
- 64 位 CPython 3.11 或更高版本
- Linux 或 macOS；生产部署示例使用 systemd

### 2. 安装依赖

```shell
git clone https://github.com/xiaochaohit/evatick-server.git
cd evatick-server

pnpm install --frozen-lockfile

python3 -m venv providers/akshare-python/.venv
providers/akshare-python/.venv/bin/python \
  -m pip install ./providers/akshare-python
```

### 3. 创建配置

```shell
cp deploy/evatickd.config.example.json ./evatickd.config.json
chmod 600 ./evatickd.config.json
```

编辑 `evatickd.config.json`：

1. 将 `admin.initialPassword` 替换为至少 8 个字符的私密初始密码。
2. 将 `providers.akshare.pythonExecutable` 改为刚创建的虚拟环境 Python 的绝对路径。
3. 按下方说明申请并配置同花顺扶摇 API Key。不使用同花顺时可删除 `providers.hithink` 配置段。
4. 本地开发时，将 `storage` 和 `admin` 下的 `/var/lib/evatickd/...` 路径改为当前用户可写的路径，例如 `./data/...`。

配置文件中的相对路径以配置文件所在目录为基准。当文件包含 `admin.initialPassword` 时，Unix 系统要求其权限为 `0600`。

#### 配置同花顺扶摇 Provider

1. 访问[同花顺金融数据服务 API Key 管理页面](https://fuyao.aicubes.cn/admin/)，注册或登录后创建统一 API Key。产品说明与接口文档分别见[同花顺金融数据服务官网](https://fuyao.aicubes.cn/)和[在线文档](https://fuyao.aicubes.cn/docs/)。
2. 在配置文件的 `providers` 中启用 `hithink`。`apiKeyEnvironment` 是保存 Key 的环境变量名，不是 Key 本身：

   ```json
   {
     "providers": {
       "hithink": {
         "baseUrl": "https://fuyao.aicubes.cn",
         "apiKeyEnvironment": "HITHINK_FINANCE_API_KEY"
       },
       "akshare": {
         "pythonExecutable": "/absolute/path/to/providers/akshare-python/.venv/bin/python"
       }
     }
   }
   ```

3. 将申请到的 Key 注入 `HITHINK_FINANCE_API_KEY`。不要把真实 Key 写入 JSON、源码、README、日志或 Git 仓库。

macOS 可先把 Key 保存在钥匙串，再仅向启动进程注入：

```shell
export HITHINK_FINANCE_API_KEY="$(security find-generic-password \
  -a "$USER" -s cn.evatick.provider.hithink -w)"
```

也可以在当前终端中隐藏输入，避免将 Key 直接写进 shell 历史：

```shell
read -rsp 'HiThink API Key: ' HITHINK_FINANCE_API_KEY && echo
export HITHINK_FINANCE_API_KEY
```

systemd 部署时，创建仅 root 可读的环境文件：

```shell
sudo install -o root -g root -m 0600 /dev/null /etc/evatickd/provider.env
sudoedit /etc/evatickd/provider.env
```

在编辑器中写入下面一行并将占位符替换为真实 Key：

```dotenv
HITHINK_FINANCE_API_KEY=<your-api-key>
```

仓库提供的 [`deploy/evatickd.service`](deploy/evatickd.service) 已通过
`EnvironmentFile=-/etc/evatickd/provider.env` 读取该文件。修改后执行：

```shell
sudo systemctl daemon-reload
sudo systemctl restart evatickd
sudo systemctl is-active evatickd
curl --fail --silent --show-error http://127.0.0.1:8765/v1/health
```

服务正常启动后，可登录管理中心的“数据源管理”页面，确认“同花顺扶摇”已出现并执行健康检查。若启动时报
`configured HiThink API key environment variable is missing`，说明配置中的环境变量名与进程实际收到的变量不一致。

> [!IMPORTANT]
> `HITHINK_FINANCE_API_KEY` 用于 EVA Tick Server 访问同花顺上游；后文通过管理中心创建的 `EVA_API_KEY` 用于客户端访问 EVA Tick Server。两者用途不同，不应混用。

### 4. 启动服务

```shell
bin/evatickd --config ./evatickd.config.json
```

也可以通过 pnpm 启动：

```shell
pnpm evatickd -- --config ./evatickd.config.json
```

服务就绪后会输出：

```json
{"schema":"eva.daemon-started.v1","url":"http://127.0.0.1:8765"}
```

### 5. 创建 API 密钥并验证

访问 [http://127.0.0.1:8765/admin](http://127.0.0.1:8765/admin)，使用配置中的管理员账号和初始密码登录，然后在“API 密钥”页面创建密钥。

```shell
export EVA_API_KEY='<your-api-key>'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  http://127.0.0.1:8765/v1/health
```

管理员凭据首次生成后，应从配置文件中删除 `initialPassword`，保留由 `credentialsPath` 指向的凭据文件。

## 使用示例

所有公开市场数据接口都使用 Bearer API 密钥。下面的示例搜索“平安银行”，再使用返回的规范标的 ID 查询行情；URL 中的中文由 `curl` 自动编码并不总是可靠，因而示例使用 `--get --data-urlencode`。

```shell
curl --get --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  --data-urlencode 'q=平安银行' \
  --data-urlencode 'instrument_type=equity' \
  http://127.0.0.1:8765/v1/instrument-search

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  'http://127.0.0.1:8765/v1/instruments/cn%3Aequity%3AXSHE%3A000001/quote'

curl --get --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  --data-urlencode 'interval=1d' \
  --data-urlencode 'start=2026-01-01' \
  --data-urlencode 'end=2026-01-31' \
  'http://127.0.0.1:8765/v1/instruments/cn%3Aequity%3AXSHE%3A000001/bars'
```

## HTTP API

[OpenAPI 3.1 契约](contracts/openapi/evatick-api-v1.yaml)是客户端集成的协议源。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/health` | 服务与数据提供方状态 |
| `GET` | `/v1/instruments` | 分页列出规范金融标的 |
| `GET` | `/v1/instruments/{instrument_id}` | 获取标的详情与提供方标识 |
| `GET` | `/v1/instrument-search` | 按名称、代码或别名搜索标的 |
| `POST` | `/v1/instrument-resolve` | 结合上下文解析唯一标的 |
| `GET` | `/v1/instruments/{instrument_id}/quote` | 获取最新行情快照 |
| `GET` | `/v1/instruments/{instrument_id}/bars` | 获取规范化 OHLCV 行情柱 |
| `GET` | `/v1/indices/{instrument_id}/constituents` | 获取指数成分 |

成功响应包含版本化 `schema`、规范化 `data` 和来源元数据；失败响应使用 `application/problem+json`。管理中心专用的同步、数据源和密钥管理接口也记录在 OpenAPI 契约中。

## 架构

```text
eva CLI / HTTP 客户端
          │
          │ Bearer API 密钥
          ▼
   版本化 HTTP API ───────── EVA 管理中心
          │
          ▼
目录 · 解析 · 路由 · 规范化 · 同步
     │                    │
     ▼                    ▼
SQLite 标的目录       DuckDB 历史仓库
     │
     ▼
Cordis 数据提供方插件
     │
     ▼
同花顺扶摇 REST API · AKShare Python 桥接进程 · 公共加密货币 REST API
     │
     ▼
同花顺扶摇 · 新浪 · 东方财富 · 腾讯财经 · BaoStock · Binance · Coinbase
```

CLI 与服务端只通过 HTTP API 通信，不依赖服务端实现代码。数据提供方插件由 Cordis 管理生命周期；Python 数据桥接运行在独立进程中。

### 仓库结构

| 路径 | 职责 |
| --- | --- |
| `apps/evatick-server` | `evatickd` 进程入口与配置加载 |
| `packages/core` | 领域模型、目录与路由契约 |
| `packages/transport-http` | HTTP API、认证、管理中心与历史仓库 |
| `packages/catalog-sqlite` | SQLite 标的目录实现 |
| `packages/cordis-runtime` | Cordis 插件运行时集成 |
| `packages/provider-akshare` | AKShare 数据提供方插件 |
| `packages/provider-hithink` | 同花顺扶摇 REST API 数据提供方插件 |
| `packages/provider-crypto` | Binance 与 Coinbase 公共行情数据提供方插件 |
| `providers/akshare-python` | 进程隔离的 Python 数据桥接 |
| `contracts/openapi` | 公开 HTTP API 契约 |
| `deploy` | 配置与 systemd 部署示例 |

## 配置参考

| 配置段 | 用途 |
| --- | --- |
| `server` | 监听地址、端口、请求超时、重试和健康检查周期 |
| `storage` | SQLite 标的目录、DuckDB 历史仓库与数据源顺序配置路径 |
| `admin` | 管理员账号、初始密码、凭据和 API 密钥存储路径 |
| `providers` | 数据提供方进程及其运行时配置 |

完整示例见 [`deploy/evatickd.config.example.json`](deploy/evatickd.config.example.json)。服务启动时会严格校验未知字段、数值范围、文件权限与 Python 可执行文件。

## 管理中心

管理中心默认位于 [http://127.0.0.1:8765/admin](http://127.0.0.1:8765/admin)，提供：

- 本地数据浏览与覆盖范围检查
- 历史数据手动同步、取消、恢复和每日计划；期货按品种同步未复权主力连续序列
- 期货同步列表只展示新浪当前实际提供主连日线的品种；上游不披露逐日主力月份，因此该来源不提供换月成员明细
- 按股票、指数等数据类型独立调整上游数据源优先级，并手动或定时检测健康度
- API 密钥创建、显示、复制与撤销
- 管理员密码修改与会话管理

<!-- 截图位：将管理中心截图放在 docs/assets/admin-console.png，然后取消下一行注释。 -->
<!-- ![EVA 管理中心](docs/assets/admin-console.png) -->

如果服务监听在公网地址，应通过可信反向代理提供 TLS，并使用防火墙或安全组限制访问。不要将配置、凭据、API 密钥或数据目录提交到版本控制。

## 开发与验证

```shell
pnpm typecheck
pnpm test

providers/akshare-python/.venv/bin/python \
  -m pip install -e './providers/akshare-python[test]'
providers/akshare-python/.venv/bin/python \
  -m pytest -q providers/akshare-python/tests
```

CI 会在每次 push 和 pull request 时运行 TypeScript 类型检查、Node.js 测试与 Python 测试。提交修改前请保持 OpenAPI 契约、实现和测试同步。

## 部署

仓库提供 [`deploy/evatickd.service`](deploy/evatickd.service) 作为 systemd 起点。示例约定：

- 程序目录：`/opt/evatick-server`
- 配置文件：`/etc/evatickd/config.json`
- 数据目录：`/var/lib/evatickd`
- 系统用户：`evatickd`

生产环境还应自行配置 TLS 终止、访问控制、日志收集、监控、备份与进程资源限制。

## 贡献

欢迎提交 issue 和 pull request。开始前请阅读 [`CONTEXT.md`](CONTEXT.md) 中的领域语言、开发流程与安全规则；架构决策记录位于 [`docs/adr`](docs/adr)。请为行为变更补充测试，并确保上面的全部验证命令通过。

## 许可证与免责声明

本项目基于 [MIT License](LICENSE) 发布。第三方组件与上游数据源说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

市场数据仅供研究与参考，不保证完整性、准确性或及时性，不构成投资建议。
