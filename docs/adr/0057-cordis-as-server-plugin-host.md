---
status: accepted
---

# 服务端使用 Cordis 作为插件宿主

市场数据服务端使用 Cordis 组装可替换的数据源、路由策略、缓存、存储、传输和 Harness 集成，以便与同样基于 Cordis 的 DeepSeek Harness 对接；市场数据领域契约保持独立于 Cordis，CLI 和 Harness 通过稳定服务契约访问能力。Cordis 与 DeepSeek Harness 仍处于快速演进期，因此集成代码集中在适配层并固定兼容版本，避免领域模型依赖不稳定的框架 API。
