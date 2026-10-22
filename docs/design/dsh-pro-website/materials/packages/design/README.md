# gpt-image-design

用 ChatGPT Pro 网页会话生成设计图与前端 HTML demo，并把产物保存到本地、在 DSH 侧边栏的画廊里预览。

> 订阅网页自动化，不是官方 API；页面改版、账号风控与 ToS 风险由使用者承担。

## 安装

```bash
dsh plugin --profile desktop add gpt-image-design
```

首次使用先登录（与研究插件共用同一浏览器 profile）：

```text
gpt_image_design(action="login")
```

## 使用

```text
gpt_image_design(action="start", confirmed=true, title="落地页首屏",
                 question="生成 3 个方向的首屏设计图和 1 个 HTML demo",
                 brief="深色科技风，中文大标题，右侧产品界面，单文件 HTML",
                 criteria=["至少 1 张完整首屏图", "一个可打开的 HTML demo"],
                 rounds=2, designs=3)
```

产物写入 `<主题>/artifacts/round-NN/`：

- `image-01.png` 等（ChatGPT 生成的图片）
- `code-01.html` 等（前端代码块，HTML 可在面板 iframe 预览）

面板「Image Design」列出主题、图片画廊、demo 预览与设计决策。

## 记录

- `store=project`：`<项目>/docs/design/`（设计插件使用 `docs/design`）
- `store=local`：`~/.dsh/gpt-image-design/`
- 原始答复默认只在本机；`rawAnswers=repo` 才复制进项目。

## 许可证

MIT。
