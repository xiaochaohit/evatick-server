# 文件导出支持显式 `--format`

文件导出支持 `--format json|jsonl|csv|parquet`，且该选项必须与 `--output` 一起使用；未指定格式时可从受支持的扩展名推断，无扩展名或自定义扩展名则必须显式指定。已知扩展名与显式格式冲突时返回 `OUTPUT_FORMAT_MISMATCH`；没有 `--output` 时 stdout 始终保持严格 JSON，JSONL、CSV 和 Parquet 只接受结构相容的数据，不进行有损转换或隐式展平。
