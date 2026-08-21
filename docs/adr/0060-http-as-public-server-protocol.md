---
status: accepted
---

# 首版服务端只公开版本化 HTTP API

EVA CLI 与 EVA 服务 在首版只通过版本化 HTTP API 通信。普通查询使用 JSON 响应信封；标的目录和指数成分等集合使用游标分页；较大结果后续通过 HTTP 压缩、NDJSON 流或异步 Parquet 导出扩展。CLI 默认只向调用者输出响应信封中的 `data`，保留现有成功结果直接输出数据本体的契约。

WebSocket 不作为普通查询或批量下载协议，只在未来需要持续实时行情订阅时增加。gRPC 不进入首版公共契约；如果未来把数据提供方拆成独立服务，可以在服务端内部通过适配器使用 gRPC，而不改变 CLI 的 HTTP 接口。

HTTP 错误采用 RFC 9457 `application/problem+json`，并保留稳定 `code` 与 `retryable` 扩展供 CLI 映射现有错误格式。公开契约使用 OpenAPI 3.1 描述，URL 主版本与响应 `schema` 共同标识响应结构。
