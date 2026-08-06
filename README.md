# TripSage 差旅出行助手

面向个人与小团队的智能差旅助手。用一次对话完成行程规划、实时天气查询、机酒高铁方案查询和企业差旅知识问答。

**在线体验（国内网络通常需 VPN）：** [https://tripsage.tripsage-cloudflare-demo.workers.dev](https://tripsage.tripsage-cloudflare-demo.workers.dev)

<!-- 演示视频补录后放在此处 -->

> 当前线上版本是轻量体验版，适合功能演示和少量试用。查询结果仅供行程决策参考，实际价格、库存及退改规则以供应商页面为准。

## 界面预览

以下截图展示移动端轻量体验版的主要使用流程。

<table>
  <tr>
    <td align="center" width="33%">
      <img src="images/demo-mobile-home.jpg" alt="TripSage 首页" width="240"><br>
      <sub><b>首页</b><br>从行程规划、实时信息或差旅政策开始</sub>
    </td>
    <td align="center" width="33%">
      <img src="images/demo-mobile-plan.jpg" alt="TripSage 行程规划" width="240"><br>
      <sub><b>行程规划</b><br>通过对话生成交通、住宿与每日安排</sub>
    </td>
    <td align="center" width="33%">
      <img src="images/demo-mobile-search-form.jpg" alt="TripSage 实时方案查询" width="240"><br>
      <sub><b>实时查询</b><br>补充路线、日期、人数和查询类型</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="images/demo-mobile-search-result.jpg" alt="TripSage 实时查询结果" width="240"><br>
      <sub><b>方案比较</b><br>查看实时交通方案并跳转供应商</sub>
    </td>
    <td align="center" width="33%">
      <img src="images/demo-mobile-sidebar.jpg" alt="TripSage 本机会话与服务状态" width="240"><br>
      <sub><b>偏好与历史</b><br>在当前浏览器保存偏好、会话与行程</sub>
    </td>
    <td align="center" width="33%">
      <img src="images/demo-mobile-knowledge.jpg" alt="TripSage 个人差旅知识库" width="240"><br>
      <sub><b>个人知识空间</b><br>隔离检索当前浏览器上传的差旅资料</sub>
    </td>
  </tr>
</table>

## 核心能力

- **完整行程规划**：结合出发地、目的地、日期和偏好，生成交通、住宿区域与每日安排。
- **实时出行信息**：查询 Open-Meteo 天气，以及飞猪机票、酒店和高铁方案。
- **企业差旅知识库**：通过 RAG 检索差旅标准、报销规定、预订指南和应急流程，并展示资料来源。
- **个人知识空间**：无需账号即可上传 TXT、Markdown 或 CSV 文档；当前浏览器只能检索自己的临时资料。
- **本机会话历史**：在浏览器中保存偏好、近期会话和行程，点击记录可恢复完整对话。
- **预订跳转**：将已识别的城市、日期和人数带入查询流程，并提供供应商跳转入口。

## 两种运行版本

| 版本 | 适用场景 | 主要技术 | 数据保存 |
|---|---|---|---|
| `demo/` Cloudflare 轻量版 | 在线展示、短期试用 | Workers AI、Vectorize、KV、Open-Meteo、FlyAI | 偏好和会话保存在当前浏览器；个人知识文档临时保存在云端隔离空间 |
| Python 完整版 | 本地开发、Agent 编排研究 | AgentScope、FastAPI、ChromaDB、DeepSeek 兼容 API | 本地 JSON 记忆与 ChromaDB 知识库 |

## 在线轻量版架构

```text
浏览器
├─ 对话、偏好、行程历史 ─────────────── localStorage
├─ POST /api/chat ─────────────────── Workers AI
├─ POST /api/weather ──────────────── Open-Meteo
├─ POST /api/travel/search ────────── FlyAI / 飞猪
└─ /knowledge.html
   ├─ 文档原文与过期信息 ───────────── Cloudflare KV
   └─ 向量检索 ────────────────────── Cloudflare Vectorize
```

线上知识库包含 8 类示例资料：差旅标准、报销规定、预订指南、FAQ、应急指南、平台指南、城市指南和环保倡议。用户上传的个人资料通过浏览器生成的匿名空间标识隔离，并按设定时间自动清理。

## 部署 Cloudflare 轻量版

### 1. 安装依赖

```bash
cd demo
npm install
```

### 2. 创建 Cloudflare 资源

创建 Vectorize 索引和 KV Namespace，并将实际资源信息填写到 `demo/wrangler.jsonc`：

```bash
npx wrangler vectorize create tripsage-rag --dimensions=1024 --metric=cosine
npx wrangler kv namespace create RAG_STORE
```

### 3. 配置可选的实时供应商

天气使用 Open-Meteo，无需密钥。机票、酒店和高铁实时查询需要 FlyAI 凭证：

```bash
npx wrangler secret put FLYAI_API_KEY
npx wrangler secret put FLYAI_SIGN_SECRET
```

不要将任何真实凭证写入 `.env`、`wrangler.jsonc` 或提交到 Git。

未配置供应商凭证时，页面会安全降级为官方查询入口，不会展示未经验证的价格或库存。

### 4. 构建 RAG 资料

```bash
npm run rag:build
```

该命令会生成 `src/rag-data.generated.js` 和 `rag/kv-seed.generated.json`。部署到新的 Cloudflare 账户时，还需要使用 Workers AI 为分块生成向量，并将向量和文档元数据分别写入 Vectorize 与 KV；仓库目前不提供包含账户凭证的一键导入命令。

### 5. 检查与部署

```bash
npm test
npm run check
npm run deploy
```

## 启动 Python 完整版

### 1. 创建环境并安装依赖

```bash
python -m venv venv
source venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
```

PowerShell 可使用：

```powershell
.\venv\Scripts\Activate.ps1
```

### 2. 配置模型

根据自己的模型供应商修改 `config.py`。不要提交真实 API Key。

```python
LLM_CONFIG = {
    "api_key": "your-api-key",
    "model_name": "your-model",
    "base_url": "https://your-provider.example/v1",
    "temperature": 0.7,
    "max_tokens": 8192,
}
```

### 3. 初始化知识库

```bash
python .claude/skills/ask-question/script/init_knowledge_base.py
```

### 4. 启动 Web 或 CLI

```bash
uvicorn web.app:app --host 0.0.0.0 --port 8000
```

浏览器访问 `http://localhost:8000`。

```bash
python cli.py
```

## Python 多 Agent 设计

```text
用户输入
  → IntentionAgent：意图识别、实体提取、查询改写
  → OrchestrationAgent：按依赖关系调度任务
    ├─ MemoryQuery
    ├─ EventCollection
    ├─ Preference
    ├─ InformationQuery
    ├─ RAGKnowledge
    └─ ItineraryPlanning
  → 聚合回答并更新记忆
```

| Agent | 职责 |
|---|---|
| `IntentionAgent` | 识别规划、记忆、偏好、知识、信息查询和事项收集意图 |
| `OrchestrationAgent` | 并行执行无依赖任务，并按优先级组织结果 |
| `RAGKnowledgeAgent` | 检索差旅资料并提供来源 |
| `EventCollectionAgent` | 提取城市、日期、人数和出行目的 |
| `PreferenceAgent` | 维护交通、座席、住宿和预算偏好 |
| `InformationQueryAgent` | 查询天气与外部出行信息 |
| `ItineraryPlanningAgent` | 生成结构化差旅行程 |

## 项目结构

```text
TripSage/
├─ demo/                    # Cloudflare Workers 在线轻量版
│  ├─ public/              # 白蓝色响应式前端
│  ├─ rag/                 # 在线版示例知识资料
│  ├─ scripts/             # RAG 构建脚本
│  ├─ src/                 # Worker、FlyAI 与 RAG 接口
│  └─ tests/               # Worker 自动测试
├─ agents/                 # Python Agent 编排层
├─ context/                # 短期与长期记忆
├─ .claude/skills/         # Agent Skills 与本地 RAG
├─ web/                    # FastAPI Web 界面
├─ tests/                  # Python 测试
├─ cli.py                  # CLI 入口
├─ config.py               # 模型与系统配置
└─ requirements.txt
```

## 隐私与产品边界

- 轻量版不强制登录，不提供跨设备账号同步。
- 偏好、会话和行程历史默认保存在当前浏览器；清除浏览器数据后无法恢复。
- 匿名知识空间仅适合试用，不应上传身份证件、合同、财务明细等敏感资料。
- 预订和支付在供应商页面完成。
- 实时供应商能力取决于相应接口的可用性和额度，最终信息以供应商页面为准。

## 测试

Cloudflare 轻量版：

```bash
cd demo
npm test
npm run check
```

Python 完整版：

```bash
python tests/test_memory_system.py
python tests/test_intention_agent.py
python tests/test_orchestration.py
python tests/test_rag_agent.py
python tests/test_cli_qa.py
```

## License

[MIT License](LICENSE)
