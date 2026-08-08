# 首版支持 CPython 3.11–3.14 和主流 64 位桌面平台

首版支持 CPython 3.11、3.12、3.13、3.14，以及 Linux x86_64、macOS x86_64/Apple Silicon 和 Windows x86_64，不承诺 32 位、PyPy、移动平台或 Alpine/musl。Ubuntu 测试全部 Python 版本，macOS 与 Windows 测试最低和最高版本，并验证进程、超时、中断、原子替换及权限；发布纯 Python `py3-none-any` wheel，PyArrow 缺失只禁用 Parquet。依赖不支持的组合必须从矩阵移除并公开说明，不能跳过测试后宣称支持。
