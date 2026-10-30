# 0.3.6 — Pro 优先与免费回退

修复 Research #1：默认模型策略为 `prefer-pro`，账号有可用 Pro 时优先选中 Pro，没有可用 Pro 才沿用网页当前模型。

- Research、Design 网页通道和 CLI 使用同一策略；Design API 生图模型不变。
- 跳过禁用、锁定和升级/定价入口；可用 Pro 选择失败时停止发送，不静默回退或重复发送。
- 显式 `auto` 保留当前模型；显式 `pro`、`thinking` 等模型继续核验。
- 旧配置与旧主题保留模型。升级后在插件设置将 `model` 设为 `prefer-pro`，并新建主题。
- 包含 0.3.5 的材料、文件、API 与恢复安全加固。修复 Windows 构建写出，常规 build 与 npm prepack 可直接运行。

安装 npm 版本（`<profile>` 换为实际 profile）：

```sh
dsh plugin --profile <profile> add chatgpt-pro-research@0.3.6
dsh plugin --profile <profile> add gpt-image-design@0.3.6
```

验证：312 项测试通过（含本地 Chrome）；typecheck、build、bundle smoke 与完整模拟验收通过。真实 Free 账号与付费 API 未在本轮调用；账号能力和额度仍由服务端决定。社区市场的固定版本独立更新。
