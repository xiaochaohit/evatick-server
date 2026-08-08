# 分发包和可执行程序统一命名为 `market-cli`

通用的 `market` 名称容易与既有工具和 Python 分发包冲突，且不能清楚表达这是命令行产品。PyPI 分发名、仓库名和可执行程序统一使用 `market-cli`，所有命令路径以 `market-cli` 开头；Python 标识符不能包含连字符，因此导入包使用 `market_cli`。
