# gpt-image-design

用 ChatGPT Pro 网页会话或 OpenAI 兼容生图 API 生成设计图，并把产物保存到本地、在 DSH 侧边栏的画廊里预览。

两种通道二选一（`channel` 设置）：

| 通道 | 适合 | 产出 |
|---|---|---|
| `web`（默认） | 有 ChatGPT 订阅，想顺带生成 HTML demo | 图片 + 前端代码/HTML demo |
| `api` | 没有订阅，或想用 `gpt-image-1` 等 API 的质量/尺寸/参考图控制 | 只有图片；HTML demo 由 agent 另行生成 |

> `web` 通道是订阅网页自动化，不是官方 API；页面改版、账号风控与 ToS 风险由使用者承担。

## 安装

```bash
dsh plugin --profile desktop add gpt-image-design
```

网页通道首次使用先登录（与研究插件共用同一浏览器 profile）：

```text
gpt_image_design(action="login")
```

API 通道不需要登录；配好 key 后用 `probe` 自检。

## 网页通道

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

## API 通道

在 DSH 设置 → 插件 → `gpt-image-design` 里把 `channel` 改成 `api`，并填写：

| 设置 | 默认 | 说明 |
|---|---|---|
| `imageBaseUrl` | `https://api.openai.com/v1` | 含版本前缀的 API 根地址 |
| `imageApiKey` | 空 | key；留空则读环境变量 `GPT_IMAGE_API_KEY` |
| `imageModel` | `gpt-image-1` | 模型名，例如 `gpt-image-1`、`dall-e-3` 或服务商模型名 |
| `imageSize` | `auto` | `auto` 或 `1024x1024` / `1536x1024` / `1024x1536` 等 |
| `imageQuality` | `auto` | `auto` / `low` / `medium` / `high`（服务商支持时生效） |
| `imageFormat` | `png` | `png` / `jpeg` / `webp` |
| `imageAuth` | `bearer` | `bearer`（`Authorization: Bearer`）或 `api-key`（Azure 风格） |
| `imageEdit` | `auto` | 材料里的图片是否作为参考图发给 `/images/edits` |
| `imageTimeoutSeconds` | `300` | 单张图片的生成/下载超时 |

自检：

```text
gpt_image_design(action="probe")
```

返回 `channel: "api"`、`probe.ok`、模型列表或 `probe.reason`。`ok=false` 时先看 reason（key、base URL、模型名）。

改完设置或环境变量后要重载插件（重启 DSH）才生效；进行中的主题不受影响。

如果设置页没有渲染这些项，可以直接写进 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- id: gpt-image-design
  name: gpt-image-design
  config:
    channel: api
    imageBaseUrl: https://api.openai.com/v1
    imageApiKey: sk-...        # 或用环境变量 GPT_IMAGE_API_KEY
    imageModel: gpt-image-1
    imageSize: 1536x1024
```

发起：

```text
gpt_image_design(action="start", confirmed=true, title="深色首屏",
                 question="出三个方向的首屏",
                 brief="深色科技风，中文大标题，右侧产品界面",
                 criteria=["三张图方向可区分", "标题中文可读"],
                 designs=3)
```

每个方向调用一次生图接口（`designs=3` 就是 3 次请求），图片保存到 `artifacts/round-NN/image-01.png` 等。

### 接口约定

- `POST {imageBaseUrl}/images/generations`，JSON：`{model, prompt, n:1, size?, quality?, output_format?}`；
- 材料里有图片（`.png/.jpg/.jpeg/.webp`，最多 4 张、每张 25MB）且 `imageEdit=auto` 时改走
  `POST {imageBaseUrl}/images/edits`（multipart，`image[]`）；
- 响应支持 `data[].b64_json`、`data[].url`；`url` 会下载后落盘，鉴权头只发给 `imageBaseUrl` 同源地址；
- 服务商必须兼容 OpenAI images 的参数名；用 `image_size`、`batch_size` 等自定义参数的服务商暂不支持。

### 成本与轮次

- 每轮 = `designs` 次生图请求，按 API 计费；没有配置自动裁决（`judgeProvider` + `judgeModel`）时，API 通道默认只跑 1 轮，避免重复计费。显式传 `rounds` 可覆盖。
- 自动裁决在 API 通道只看得到提示词与结果清单，看不到图片本身；更可靠的是人工复核，或不配裁决、跑 1 轮后用 `continue` 显式加轮。
- 部分方向失败不会丢掉已成功的图；失败原因写进该轮答复和面板记录。
- DSH 重启后，进行中的 API 请求会丢失，这一轮不会自动重发；已生成的图片仍在 `artifacts/` 里。

### 安全

- key 只来自插件设置或 `GPT_IMAGE_API_KEY`；不会写进 `topic.json`、回执、日志或错误信息（错误体做了脱敏）。
- 插件设置存在本机 profile 配置里，不要提交到仓库；公开仓库场景建议使用环境变量。
- 参考图会发送到配置的服务商；敏感素材不要作为材料传入。

## 记录

- `store=project`：`<项目>/docs/design/`（设计插件使用 `docs/design`）
- `store=local`：`~/.dsh/gpt-image-design/`
- 原始答复默认只在本机；`rawAnswers=repo` 才复制进项目。
- API 通道的答复是提示词与结果清单（纯文本），不是模型自然语言回复。

## 许可证

MIT。
