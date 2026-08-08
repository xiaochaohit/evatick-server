# 框架选项保留短名称，冲突的数据参数使用 `--arg-` 前缀

`--limit`、`--output`、`--format`、`--cache-ttl`、`--refresh`、`--retries`、`--timeout`、`--debug-output` 和 `--overwrite` 是放在叶子命令后的保留框架选项。数据提供方函数出现同名参数时，生成器确定性地将其 CLI 名称改为 `--arg-*`，同时在帮助中保留原始 Python 参数名；`--args-json` 继续使用原始参数名，从而无需人工覆盖即可同时访问框架控制和函数参数。
