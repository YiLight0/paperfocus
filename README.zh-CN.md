# PaperFocus

**面向研究论文的提问引导证据高亮工具**

[English](README.md) · [中文演示讲稿](docs/paperfocus-talk.zh-CN.md)

PaperFocus 是一个本地优先的 PDF 阅读器。用户使用自然语言提出问题后，系统调用 [TypeSafe Jev](https://docs.typesafe.ai/introduction) 为论文中的候选内容进行相关性评分，再把最有价值的原文证据映射回 PDF 的准确位置。它不生成一篇替代原文的总结，而是帮助读者更快进入需要亲自精读的位置。

## 为什么做 PaperFocus

当实验细节、限定条件和原始表述十分重要时，论文仍然需要精读。传统对话式阅读通常需要反复提问、等待生成回答，再手动返回 PDF 核验出处。PaperFocus 将这个过程缩短为：

1. 打开论文；
2. 提出一个具体问题；
3. 直接跳转到最相关的原句、段落、图片与图注。

## 主要功能

- 拖入或选择 PDF，在本地完成解析和页面渲染。
- 使用自然语言提问，例如“这篇论文的实验是如何设计的？”
- 两阶段分析：先筛选段落，再定位句子级证据。
- 使用连续黄色深浅表达本次分析中的相对显著程度。
- 图片与图注作为同一处证据；图注使用文字高亮，匹配图片使用向外偏移的明黄色粗虚线框。
- 支持按原文顺序或相关性排列结果。
- 可调最低显著度，默认 75%，在常见论文中通常保留约五处主要证据。
- 点击结果定位原文，并自动跳到最相关位置；支持 50%–200% 缩放以及单栏、双栏和三栏布局。
- 支持恢复最近问题和导出 JSON。
- 显示每次提问的 Jev 请求处理时间，不显示上传和本地解析时间。

## 系统架构

```text
PDF
 └─ 使用 PyMuPDF 在本地解析
     ├─ 页面与渲染坐标
     ├─ 段落与句子
     └─ 图注与邻近图片区域
          ↓
      Jev 筛选段落
          ↓
      Jev 评分句子与证据
          ↓
      普通代码完成排序、合并与显著度映射
          ↓
      在原始 PDF 页面上显示高亮
```

Jev 只负责语义判断。PDF 解析、分批、坐标映射、筛选、排序、阈值和渲染均由 Python 与浏览器代码控制。应用运行时直接调用 TypeSafe 原生 `POST /v1/systemone` 接口；TypeSafe agent skill 只用于辅助开发，不是运行依赖。

## 开始使用

### 环境要求

- Python 3.10 或更高版本
- 从 [TypeSafe 控制台](https://console.typesafe.ai/) 获取 API Key

### 安装与启动

```bash
git clone https://github.com/YiLight0/paperfocus.git
cd paperfocus
python -m pip install -r requirements.txt
```

复制 `.env.example` 为 `.env`，然后填写：

```env
TYPESAFE_API_KEY=your_key_here
TYPESAFE_MODEL=jev-latest
PORT=8765
MAX_PDF_MB=200
```

启动本地服务：

```bash
python server.py
```

打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)。Windows 用户也可以双击 `启动阅读器.cmd`。

也可以通过界面中的“连接 Jev”临时输入密钥。网页输入的密钥只保存在服务端内存，不会写入 `.env`。`.env` 已被 Git 忽略，HTTP 服务也不会提供该文件。

需要显式代理时，在 `.env` 中增加：

```env
TYPESAFE_PROXY=http://127.0.0.1:7890
```

## 分析流程

PaperFocus 首先并行筛选全文段落，再分析最多 24 个候选段落中的句子。进入最终筛选前最多保留 64 个候选证据，每段最多四处。系统按照保守的 UTF-8 字节预算自动分批，没有固定的 16 句限制。

Jev 返回的 0–3 分只用于当前问题的候选排序。PaperFocus 根据排名和分差计算连续的**相对显著度**：最显著证据记为 100%，其余结果相对于本次分析逐级降低。这个百分比不是统计准确率，也不是模型校准置信度。

同一页面中相邻的证据会合并为一处。除非问题明确询问，系统默认跳过参考文献、作者机构和重复页眉页脚。如果某段内容整体相关，但没有足够准确的单句，系统可以回退到段落高亮。

## 数据与计时边界

- PDF 上传、解析、渲染和坐标计算均在本地完成。
- 候选文本和用户问题会发送到 TypeSafe API 进行评分。
- 上传文档与网页临时填写的密钥只保存在服务端内存，服务停止后即消失。
- 页面显示的是服务端累计观察到的 Jev 请求处理时间，不包括上传、本地解析、浏览器渲染和前端调度；它也不能被表述为完全排除网络的 GPU 纯推理时间。

## 当前限制

- 默认上限为 200 MB、100 页和 5,000 个可提取句子；可通过 `MAX_PDF_MB` 修改文件大小上限。
- PDF 必须能够提取文字，扫描件需要单独接入 OCR。
- Jev 当前只接收文本。图片相关性依据图注和版面位置推断，系统不会宣称理解图片像素或图表数值。
- 复杂多子图、跨页图注、公式、表格、缩写和特殊多栏版式可能被错误分割。
- 当前渲染页用于证据导航，暂不支持原生 PDF 文字选择。
- 在重要场景中使用前，应当使用目标领域数据验证模型质量、耗时和阈值。

## 测试

运行解析和请求校验测试：

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Playwright 浏览器测试会拦截模型响应，在不消耗 API 额度的情况下验证上传、控件、定位、高亮、排序和响应式布局：

```bash
node tests/browser.cjs
```

模拟界面测试不代表真实 Jev 的质量与耗时。

## 项目结构

```text
app.js            浏览器交互、评分流程与证据渲染
document.py       PDF 解析、分段、图片匹配与请求分批
index.html        极简应用结构
server.py         本地 HTTP 服务与 TypeSafe 原生 API 调用
settings.py       环境变量配置
style.css         响应式阅读界面
tests/            解析与浏览器交互测试
docs/             演示讲稿及相关文档
```

## 参考资料

- [TypeSafe 简介](https://docs.typesafe.ai/introduction)
- [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart)
- [System One 概念](https://docs.typesafe.ai/concepts/system-one)
- [Jev 模型与价格](https://docs.typesafe.ai/models)

