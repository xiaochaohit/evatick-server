# DataFrame 的业务索引必须保留为字段

默认连续 RangeIndex 不输出；有名称的非默认索引转为同名字段，无名称单层索引用 `_index`，无名称多层索引依次使用 `_index_0`、`_index_1`。索引字段与数据列冲突时返回 `SERIALIZATION_ERROR` 并要求注册表覆盖明确命名，不能覆盖或自动加后缀；JSON、JSONL、CSV 和 Parquet 使用同一规则，记录预算只计算数据行。
