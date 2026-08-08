# 使用 Python 3.11 和 Click 8 构建 CLI

CLI 采用 Python 3.11+ 和 Click 8，以 Python 包形式通过 `uv tool install` 或 `pipx install` 安装。Python 可以直接调用绑定版本的 AKShare 并处理其 DataFrame 返回；Click 的惰性 Group 和可控帮助渲染更适合约千个自动生成命令，因此不使用偏向人工静态声明命令的 Typer，也不增加 AKTools HTTP 层。

## Consequences

命令树必须惰性加载，避免启动时构造全部 Click 命令。Parquet 导出通过可选 PyArrow 依赖提供；首版不承担单文件二进制的打包与兼容成本。
