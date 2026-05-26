# meowmeow7 patch — 2026-05-26

本次改动 5 个文件,解压后**保持目录结构覆盖**到仓库根目录即可。

```
src/App.tsx
src/components/Settings.tsx
src/index.css
src/lib/cloudGateway.ts
worker/gateway.js
```

## 一、修 bug:Cloud Gateway 模式下 MCP 工具死循环

### 根因
`App.tsx` 多轮 tool 调用的第 2 轮起,前端把原始的 `promptMessages`(只有 user/assistant 文本)发给 Worker,**没有携带 `assistant.tool_calls` 和 `role:"tool"` 的工具返回**。
模型看不到工具结果,只能反复调用同一个工具,直到达到 `MAX_MCP_TOOL_ROUNDS=6` 才停。

### 修复
新增 `overrideMessages` 通道,专门用于"工具循环续传":

- `cloudGateway.ts`: `CloudGenerateRequest` 加 `overrideMessages?: any[]` 字段
- `App.tsx`:
  - `round > 0` 时,把已经在本地拼好的完整 `modelMessages`(含 tool_calls + tool 结果)放进 `overrideMessages` 发给 Worker
  - 删除 `[已处理]` 占位逻辑,避免 tool 结果被截断
- `worker/gateway.js`:
  - 检测到 `overrideMessages` 时,跳过 system/pin/style/depth 这些"首轮组装",**原样透传**给上游
  - 同时跳过把最后一条当作 user 消息持久化(否则会写 `role:"tool"` 到 messages 表)

### 结果
所有轮次**全部走 Cloud Gateway**,不再有 fallback 到 Direct Provider 的分支。模型在第 2 轮就能看到工具结果,正常推进对话。

## 二、UI 大改:Settings 抽屉

`src/components/Settings.tsx` 从 Tailwind 工具类整体迁到 cedar 设计系统;`src/index.css` 末尾新增约 660 行 `.cedar-settings-*` / `.cedar-btn-*` / `.cedar-field` / `.cedar-notice` 等公共类(含微信浅色主题覆盖)。

### 主要变化
| 项 | 改前 | 改后 |
|---|---|---|
| 抽屉宽度 | `max-w-3xl` (768px) | `min(1080px, 92vw)` |
| 遮罩 | 黑色 40% | 玻璃模糊 + 渐入动画 |
| 滑入 | 无动效 | cubic-bezier 200ms 从右滑入 |
| Tab | 圆角填充背景 | 下划线 + cedar-400 高亮 |
| 侧栏 | `w-64` Tailwind | `cedar-settings-aside` 19rem,激活项左侧 cedar 色条 + 渐变背景 + hover 微位移 |
| 加号按钮 | 蓝色文字 | 虚线边框,hover 转 cedar 色 |
| 表单容器 | `max-w-xl` 强制窄列 | 撑满可用宽度,Provider/MCP/语音 选项框不再"狭窄滚动" |
| Field 结构 | label+children | `cedar-field` + `cedar-field-label` + `cedar-field-hint` 三段式,label 用大写字距 |
| 按钮 | `bg-blue-600` / `border-neutral-300` | 语义化 `cedar-btn-primary` / `secondary` / `ghost` / `danger` |
| 操作区 | 跟随表单底部 | sticky `cedar-settings-footer`,带玻璃模糊背景 |
| 测试结果 | 普通 div | `cedar-notice.success` / `.error`,带 title + sub + tool 列表 |
| 微信主题 | 不一致 | 全部带 `.cedar-display-wechat` 浅色反相覆盖 |

### 影响范围
仅 Settings 抽屉的 5 个 Panel(Providers / Preferences / TTS / Sync / MCP)。主聊天 UI、Composer、侧边栏未触碰。

## 三、验证
- `npx tsc --noEmit` → exit 0,零类型错误
- Worker 端 `handleGenerate` 已兼容 v1 客户端(无 `overrideMessages` 时走老路径)

## 四、回滚
任意单文件都可独立回滚:
- 只想要 bug 修复 → 只覆盖 `App.tsx` + `cloudGateway.ts` + `worker/gateway.js`
- 只想要 UI 改造 → 只覆盖 `Settings.tsx` + `index.css`(注意 index.css 是追加,不会破坏现有样式)
