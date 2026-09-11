# dsh-move-rag

[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-3b82f6)](https://github.com/topics/dsh-plugin)

给 **DeepSeek Harness** 用的本地知识库插件：把 PDF / Word / 图片 / 代码丢进一个文件夹，它负责提取、切片、向量化、检索；桌面上常驻一个置顶小图标，**拖文件上去就入库**，点开就是搜索面板。

不依赖任何云端向量库、不下载模型权重——嵌入是在本地用哈希词向量算的，索引是一个 JSON 文件。

![桌面面板](docs/screenshot.png)

> 名字里的 **move** 指的是它的用法：把文件**拖**上去就入库，图标本身也**能拖**到屏幕边缘收起来。

## 功能

- **桌面临时面板**：一个真正的 Windows 窗口（WinForms），置顶、可拖动、拖到屏幕边缘自动收成一条箭头；浏览器最小化或关掉它都在
- **拖拽入库**：把 PDF / Word / txt / md / csv / 代码 / 图片拖到图标或面板上即可，支持本地解析（PDF 文本流 + ToUnicode CMap、DOCX）
- **本地 RAG**：定长切片 + 哈希嵌入（512 维）+ 余弦召回，面板里能直接试检索，看来源文件、相似度、原文片段
- **给模型的工具**：`knowledge_search`（检索）、`kb_dev`（状态/预览/按路径入库/重建索引），Agent 可以主动查你的资料
- **网页侧边栏面板**：DSH 网页里也有一行「知识库」，置顶开关控制桌面图标出不出现，可直接上传文件

## 环境要求

- **Windows**（桌面面板是 WinForms；宿主侧的文件写入用了 PowerShell 原语）
- DeepSeek Harness，Node.js `^22.19 || >=24`
- PowerShell 5.1（Windows 自带）

## 安装

```sh
dsh plugin --profile web add github:xingmen-1/dsh-move-rag
```

`dsh plugin add` 会做两件事：`pnpm add` 这个包，然后**发现包声明的 `dsh.bundle.patch` 并自动把这一层加进 profile**，所以不需要你手动改 `cordis.patch.yml`。

装完**重启 `dsh web`**（或 `dsh web` 里的 profile 重载）即可生效。

> 也可以从 npm 装：`dsh plugin --profile web add dsh-move-rag`

## 使用

1. **打开置顶**：网页侧边栏「知识库」→ 打开「置顶」开关 → 桌面右上角出现悬浮图标（关掉则图标进程退出）
2. **入库**：把文件拖到桌面图标上，或点开面板拖进去；面板底部会显示「已入库 N 个文件 · M 个片段」
3. **检索**：面板里输入问题 → 回车或点「检索」，结果按相似度排序，点文件行可以选中、点「移除」两次确认删除（文件会移到 `.kb/trash` 回收站）
4. **让 Agent 用**：直接问它「查一下知识库里关于 X 的内容」，它会调用 `knowledge_search`

右键桌面图标还有：打开网页面板 / 展开桌面面板 / 退出。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_KNOWLEDGE_ROOT` | `%USERPROFILE%\knowledge-docs` | 知识库根目录。文件在 `<root>/files`，索引在 `<root>/.kb/index.json`，删除的文件进 `<root>/.kb/trash` |
| `DSH_HOME` | `~/.dsh` | 插件把自己的运行文件与状态放在 `$DSH_HOME/knowledge/` |

## 数据放在哪

```
<root>/
  files/            入库的原始文件
  .kb/index.json    切片 + 向量索引（纯文本 JSON，可以直接看/备份/删）
  .kb/trash/        被移除的文件（可恢复）
$DSH_HOME/knowledge/
  engine.js         从包里复制出来的运行时代码
  impl.js
  desktop.ps1
  state/            置顶开关、请求队列、桌面图标 pid 与位置
```

## 开发笔记

几个踩过的坑，给要改这个插件的人：

- **Cordis loader 有模块体积上限**：插件入口文件不能太大（约 40KB 以上就挂载失败）。所以入口 `entry.js` 很小，真正的实现放在同级文件里，运行时用 `new Function` 读取求值。
- **ESM 按 URL 缓存模块**：同一个 `file://` 路径如果第一次导入失败，之后都会复用那个失败结果——迭代时换个文件名。
- **PowerShell 5.1 的 `New-Object 类型(参数...)` 简写在函数内部解析不可靠**，会变成数组参与运算并抛 `op_Addition` 错误。项目里统一用 `[类型]::new(...)`。
- **桌面面板的异常**会写进 `$DSH_HOME/knowledge/state/ui-error.log`（带脚本行号），不是弹框。
- 宿主侧改动后要重新挂载才能生效：删掉 `cordis.patch.yml` 再写回会强制重新加载。

## 已知限制

- 仅 Windows；Linux/macOS 需要替换桌面面板与宿主侧的文件写入实现
- 哈希嵌入是关键词级别的语义近似，不是真神经嵌入——召回质量对同义改写不敏感，胜在离线、零依赖、快
- 图片只按文件名索引，没有 OCR
- 单个上传文件上限 16MB（base64 走 JSON），本地路径入库上限 256MB

## 许可证

MIT，见 [LICENSE](LICENSE)。
