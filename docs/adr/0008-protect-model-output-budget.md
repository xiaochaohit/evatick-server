# stdout 超过记录预算时显式失败

部分 AKShare 数据集一次返回数千或数万行，直接输出会耗尽模型上下文，而静默截断会让模型误以为数据完整。CLI 将 stdout 的默认输出预算设为 200 行；超限时不输出部分数据，而是以 `RESULT_TOO_LARGE` 失败并提示模型使用 `--limit` 或 `--output`。

## Consequences

所有表格型结果在序列化前必须检查记录数。`--output` 支持 JSON、JSONL、CSV 和 Parquet；文件写入成功后 stdout 只返回文件路径和记录数，因为它们是该操作的直接结果。调用方显式传入 `--limit` 时，返回所请求的前 N 行，不额外添加截断元数据。
