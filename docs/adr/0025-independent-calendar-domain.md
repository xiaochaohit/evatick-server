# 稳定交易日历使用独立领域

交易日历适用于股票、期货、期权及不同交易所，将稳定接口放在 `stock` 下会把跨资产能力错误地绑定到单一资产类别。Market CLI 因此以 `market-cli calendar trading-days` 作为提供方无关的稳定命令，并通过市场和交易所选项确定日历；AKShare 自动生成的交易日历命令仍按源函数分类留在 `stock`，明确标记为 `upstream`。
