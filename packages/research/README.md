# dsh-pro-research

用 ChatGPT Pro 网页会话做无人值守多轮调研的 DeepSeek Harness 插件。

> 这是订阅网页自动化，不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。请自行评估风险，不要把凭据写进仓库或日志。

## 安装

```bash
dsh plugin --profile desktop add dsh-pro-research
```

安装后在 DSH 设置页填写轮次上限、记录位置（project / local）、原始答复目录与浏览器 profile。首次使用先登录一次：

```text
让 agent 调用 pro_research(action="login")
```

弹出一个独立 Chrome 窗口，登录 ChatGPT 后关闭即可；登录态保存在 `~/.dsh/pro-research/browser`。

## 使用

在会话里说「用 Pro 调研一下……」，或直接调用 `pro_research` 工具：

```text
action=start, confirmed=true, title, question, brief, criteria[], materials[], rounds
```

其余动作：`status`、`list`、`resume`、`cancel`、`human_check`、`probe`、`login`。

侧边栏「Pro」面板列出主题、轮次、状态与记录路径；卡住时可恢复、取消或人工核对。

## 记录

- `store=project`：`<项目>/docs/research/<slug>/`，含问题、裁决、回执、最终汇总。
- `store=local`：`~/.dsh/pro-research/projects/<project>/<slug>/`。
- 原始答复默认只在本机 `rawAnswersDir/<topic-id>/`；`rawAnswers=repo` 才复制进项目。

## 边界

- 不自动 push；GitHub 只是 ChatGPT 自己的可选材料来源。
- 提交状态未知时不自动重发，需人工核对。
- 页面改版、账号风险、ToS 风险由使用者承担。

## 许可证

MIT。
