# 只使用标准纯文本 `--help`

尽管 CLI 只面向大模型，帮助仍采用每一级命令原生的 `--help` 纯文本，而不提供独立的 `eva help` 或 JSON 帮助。固定章节的简洁文本比 JSON 更节省上下文，也更容易让模型理解和复制命令；结构化数据输出与命令说明是不同契约，不要求使用相同格式。

## Consequences

所有命令的 `--help` 必须无颜色、无分页器、不随终端宽度改变结构，并按固定顺序包含 `NAME`、`PURPOSE`、`STABILITY`、`UPSTREAM`、`USAGE`、`ARGUMENTS`、`OPTIONS`、`RETURNS`、`EXAMPLES`、`ERRORS` 和 `RELATED COMMANDS` 中适用的章节。领域帮助只摘要展示能力，长列表通过目录搜索发现。
