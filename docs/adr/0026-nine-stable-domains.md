# 首版固定九个提供方无关的稳定领域

EVA CLI 首版将 `stock`、`index`、`fund`、`futures`、`option`、`bond`、`fx`、`macro` 和 `calendar` 固定为稳定领域，国家、交易所和数据提供方差异通过选项或适配器表达，不能形成提供方顶层命名空间。`alternative` 暂时只是异构上游能力的分类容器，不承诺统一稳定契约；无法映射到稳定领域的提供方特有能力继续作为 `upstream` 命令存在。
