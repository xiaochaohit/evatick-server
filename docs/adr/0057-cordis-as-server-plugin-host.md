---
status: accepted
---

# 服务端使用 Cordis 作为插件宿主

市场数据服务端使用 Cordis 组装可替换的数据源、路由策略、缓存、存储、传输和 Harness 集成，以便与同样基于 Cordis 的 DeepSeek Harness 对接；市场数据领域契约保持独立于 Cordis，CLI 和 Harness 通过稳定服务契约访问能力。Cordis 与 DeepSeek Harness 仍处于快速演进期，因此集成代码集中在适配层并固定兼容版本，避免领域模型依赖不稳定的框架 API。

首个兼容基线固定为 DeepSeek Harness 官方仓库提交 `47f943859bef60e4160492346772ded9b24f765a`。该提交将 Cordis 作为 `vendor/cordis` 随仓库分发，包名为 `@deepseek-ai/cordis`、版本为 `4.0.1`，而不是直接使用独立 `cordis` 包的浮动最新版本。服务端初始运行时矩阵与该基线保持一致：TypeScript、pnpm `11.7.0`，Node.js `^22.19.0 || >=24.0.0`。

升级 DeepSeek Harness 或 Cordis 时，先建立新的候选基线并运行领域契约与插件生命周期兼容测试；通过人工确认后再更新本决策记录及锁文件。领域核心不得导入 `@deepseek-ai/cordis`，只有组合根和 Cordis 适配层可以依赖它。
