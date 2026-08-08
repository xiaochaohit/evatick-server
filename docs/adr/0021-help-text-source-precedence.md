# 帮助文本优先使用绑定版本的近源说明

同一 AKShare 接口的 docstring 与官方 Markdown 可能不一致，而自动生成帮助不能凭函数名猜测业务含义。用途和参数说明按 `registry_overrides.yaml` 人工修正、绑定版本 docstring、官方 Markdown 的顺序取值；来源冲突时生成警告，完全缺失时使用仅陈述所调用函数的中性机械文本并报告覆盖缺口，但说明缺失或冲突不阻断构建。
