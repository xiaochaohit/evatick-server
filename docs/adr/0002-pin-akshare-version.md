# 每个 CLI 版本绑定一个确定的 AKShare 版本

AKShare 更新频繁，公共函数、签名和返回结构可能随发布变化，而大模型依赖帮助和 Schema 与运行时严格一致。每个 CLI 发布版本因此绑定并测试一个确定的 AKShare 版本；升级 AKShare 时重新生成注册表、帮助和 Schema，验证全量覆盖后发布新的 CLI 版本，而不是在运行时静默适配任意已安装版本。

## Consequences

CLI 安装依赖必须精确约束 AKShare 版本并在 `version` 输出中同时报告两者；上游新增能力需要通过一次 CLI 发布才能进入受支持范围。AKShare 保持外部依赖，不复制或修改其源码。
