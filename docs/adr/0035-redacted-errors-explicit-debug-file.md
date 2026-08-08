# stderr 保持单个脱敏 JSON，详细诊断写入显式文件

正常失败时 stderr 只能输出包含 `code`、`message` 和 `retryable` 的单个 JSON 对象，不暴露异常类型、堆栈、请求头、Cookie、响应正文或带查询参数的 URL；未知异常统一报告 `INTERNAL_ERROR`。只有调用方显式传入 `--debug-output PATH` 时，才将经过脱敏的堆栈和诊断写入仅当前用户可读写、默认拒绝覆盖的文件，stderr 即使在诊断模式下仍保持可直接解析。
