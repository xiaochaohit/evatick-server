# EVA 服务端

`evatickd` 是 EVA 的市场数据服务进程。它负责维护规范金融标的目录、统一不同数据提供方、执行查询路由与失败回退，并通过版本化 HTTP API 向 `eva` CLI 和其他客户端提供数据。

当前版本支持中国内地 A 股，以及上交所、深交所和中证指数。

## 核心能力

- 规范金融标的目录、搜索与解析
- 股票和指数的行情快照、日线与分钟行情柱
- 指数成分查询
- 多数据提供方注册、健康检查、超时、重试与回退
- SQLite 标的目录与 DuckDB 历史行情仓库
- API 密钥认证
- EVA 管理中心：数据浏览、数据同步、数据源状态和密钥管理

## 架构

```text
eva CLI / HTTP 客户端
          │
      HTTP API
          │
目录 · 解析 · 路由 · 规范化
          │
  可插拔数据提供方
          │
      外部市场数据
```

CLI 和服务端只通过 HTTP API 通信。OpenAPI 契约是客户端集成的唯一协议源，客户端不依赖服务端实现代码。

## 环境要求

- Node.js 22.19 或更高版本
- pnpm 11
- CPython 3.11 或更高版本

## 安装

```shell
pnpm install --frozen-lockfile

python3 -m venv providers/akshare-python/.venv
providers/akshare-python/.venv/bin/python \
  -m pip install ./providers/akshare-python
```

## 配置

复制示例配置，并将占位密码替换为私密值：

```shell
cp deploy/evatickd.config.example.json /path/to/evatickd.json
chmod 600 /path/to/evatickd.json
```

配置文件包含四部分：

| 配置段 | 用途 |
| --- | --- |
| `server` | 监听地址、端口、请求超时、重试和健康检查周期 |
| `storage` | 标的目录和历史行情仓库路径 |
| `admin` | 管理员账号、初始密码、凭据和 API 密钥存储路径 |
| `providers` | 数据提供方进程配置 |

当配置包含 `admin.initialPassword` 时，Unix 系统要求文件权限为 `0600`。首次启动并生成管理员凭据后，应从配置文件中删除初始密码。

## 启动

直接启动守护进程：

```shell
bin/evatickd --config /path/to/evatickd.json
```

也可以通过 pnpm：

```shell
pnpm evatickd -- --config /path/to/evatickd.json
```

启动成功后会输出一行 JSON，其中包含服务地址：

```json
{"schema":"eva.daemon-started.v1","url":"http://127.0.0.1:8765"}
```

## EVA 管理中心

启动后访问：

```text
http://127.0.0.1:8765/admin
```

管理中心提供：

- 本地数据浏览与覆盖范围检查
- 历史数据手动同步和每日计划
- 数据提供方健康状态
- API 密钥创建、显示、复制与撤销
- 管理员密码修改

如果服务监听在公网地址，应通过可信反向代理提供 TLS，并配合防火墙或安全组限制访问。

## HTTP API

协议源文件：[contracts/openapi/evatick-api-v1.yaml](contracts/openapi/evatick-api-v1.yaml)

主要接口：

```text
GET  /v1/health
GET  /v1/instruments
GET  /v1/instruments/{instrument_id}
GET  /v1/instrument-search
POST /v1/instrument-resolve
GET  /v1/instruments/{instrument_id}/quote
GET  /v1/instruments/{instrument_id}/bars
GET  /v1/indices/{instrument_id}/constituents
```

查询成功时返回带版本号的 `schema`、规范化 `data` 和来源元数据；错误使用 `application/problem+json`。

## 验证

```shell
pnpm typecheck
pnpm test

providers/akshare-python/.venv/bin/python \
  -m pip install -e './providers/akshare-python[test]'
providers/akshare-python/.venv/bin/python \
  -m pytest providers/akshare-python/tests
```

## systemd 部署

参考 [deploy/evatickd.service](deploy/evatickd.service)。示例约定：

- 程序目录：`/opt/evatick-server`
- 配置文件：`/etc/evatickd/config.json`
- 数据目录：`/var/lib/evatickd`
- 系统用户：`evatickd`

市场数据仅供研究与参考，不构成投资建议。
