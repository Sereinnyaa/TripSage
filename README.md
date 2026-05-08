# TripSage 差旅出行助手

面向个体商旅用户的多 Agent 智能差旅助手，覆盖意图识别 → 事项收集 → 偏好管理 → 政策问答 → 信息查询 → 行程生成全链路。

## 项目背景

高校师生及企业初级员工等个体商旅用户面临两类核心痛点：

- **跨平台信息整合耗时**：规划一次出行需在多个平台间切换（机票、酒店、天气、政策），平均耗时 2-3 小时
- **偏好无法跨会话积累**：每次出差需重新输入住宿/航司偏好，缺乏个性化记忆

现有企业商旅平台（如阿里商旅、携程商旅）均为 B2B 产品，需公司统一部署采购，个人用户无法使用且不支持政策对话查询。TripSage 填补了这一空白。

## 核心工作

独立设计并实现面向个体商旅用户的多 Agent 差旅助手，覆盖完整出行链路：

### 需求定义与优先级

- 三大核心功能优先级：**政策问答准确性 > 偏好记忆 > 响应效率**
- 以**出差前规划**为核心场景（频率最高、信息密度最大）
- 辅助场景：在途政策查询、行程历史回顾

### 产品架构：Plan-and-Execute 多 Agent 系统

```
用户输入
  → IntentionAgent（6 类语义意图识别 + 查询改写 + 调度计划）
  → OrchestrationAgent（优先级并行调度）
    ├─ 优先级 1: MemoryQuery | EventCollection | Preference | InformationQuery | RAGKnowledge（并行）
    └─ 优先级 2: ItineraryPlanning（依赖优先级 1 结果）
  → 结果聚合 + 记忆更新
```

- **6 类意图识别**：行程规划、记忆查询、偏好管理、知识问答、信息查询、事项收集
- **5 类专职 Agent**：行程规划 / 偏好管理 / 知识问答 / 实时查询 / 对话管理
- **优先级并行调度**：同优先级 Agent 通过 `asyncio.gather` 并行执行，不同优先级串行依赖
- **插件化 Skill 架构**：懒加载 + 即插即用，新增功能无需修改主流程，支持水平扩展

### 个性化记忆系统

- **短期记忆**：滑动窗口（10 轮对话），保证当次对话连贯
- **长期记忆**：JSON 文件持久化，跨会话积累偏好与行程历史
- **偏好管理 Agent**：LLM 语义识别追加（"还喜欢"）vs 覆盖（"搬家到"）动作
- **LLM 异步总结**：自动总结历史会话和行程记录，注入意图识别上下文

### RAG 知识库

- 覆盖 **8 类商旅文档**：差旅标准、报销规定、预订指南、FAQ、应急指南、平台指南、城市指南、环保倡议
- **ChromaDB** 向量数据库 + **BGE-small-zh-v1.5** 嵌入模型（本地部署，Windows 兼容）
- 智能分块（Chunking）+ 余弦相似度检索（Top-K=3）
- 每条回答附带文档溯源，准确率 **96%**

### 评测体系

- 构建标注测试集，定位 Top Bad Case 类型（同义表达 / 复合意图 / 上下文依赖）
- 驱动三轮迭代优化，形成可复现评测 SOP

## 项目成果

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 意图识别准确率 | 65% | 90%+ | +25% |
| 知识库问答准确率 | - | 96% | 新增 |
| 用户偏好记忆准确率 | - | 95% | 新增 |
| 系统响应时间 | 30s | 15s | -50% |
| 系统启动速度 | - | 3s | 懒加载 |

---

## 快速开始

### 1. 环境准备

```bash
python -m venv venv
source venv/Scripts/activate   # Windows
pip install -r requirements.txt
```

### 2. 配置 API

编辑 `config.py`：

```python
LLM_CONFIG = {
    "api_key": "your-api-key",
    "model_name": "deepseek-v4-pro",
    "base_url": "https://api.deepseek.com/v1",
    "temperature": 0.7,
    "max_tokens": 8192,
}
```

### 3. 初始化知识库

```bash
python .claude/skills/ask-question/script/init_knowledge_base.py
```

### 4. 启动

**Web 界面**（推荐）：
```bash
uvicorn web.app:app --host 0.0.0.0 --port 8000
# 浏览器打开 http://localhost:8000
```

**CLI 界面**：
```bash
python cli.py
```

---

## 系统架构

```
用户输入
   ↓
┌──────────────────────────────────────────────┐
│  IntentionAgent（意图识别智能体）              │
│  · 6 类语义意图识别（准确率 90%+）            │
│  · 关键实体提取 + 查询改写                     │
│  · 生成优先级调度计划                          │
│  · Progressive Disclosure 渐进式暴露          │
└──────────────────────────────────────────────┘
   ↓
┌──────────────────────────────────────────────┐
│  OrchestrationAgent（协调器）                  │
│  · 按优先级分批次调度                          │
│  · 同优先级 asyncio.gather 并行               │
│  · 结果聚合 + 记忆更新                         │
└──────────────────────────────────────────────┘
   ↓
┌─────────── 优先级 1（并行执行）───────────────┐
│  MemoryQuery    EventCollection   Preference  │
│  InformationQuery    RAGKnowledge             │
└──────────────────────────────────────────────┘
   ↓
┌─────────── 优先级 2（依赖优先级 1）───────────┐
│  ItineraryPlanning（行程规划）                 │
└──────────────────────────────────────────────┘
   ↓
  结果输出
```

---

## 6 类意图识别

| 意图类型 | 示例 | 调度 Agent |
|----------|------|-----------|
| `itinerary_planning` | "从上海去北京出差 3 天" | EventCollection + Preference + ItineraryPlanning |
| `memory_query` | "我去过哪些地方" | MemoryQuery |
| `preference` | "我喜欢住汉庭" | Preference |
| `rag_knowledge` | "北京住宿标准多少" | RAGKnowledge |
| `information_query` | "杭州明天天气" | InformationQuery |
| `event_collection` | "我要去深圳出差" | EventCollection |

---

## 子智能体（Skills）

所有子智能体以 **Skill Plugin** 形式位于 `.claude/skills/`，通过 `LazyAgentRegistry` 动态发现与懒加载。

| Agent | 职责 | 技术要点 |
|-------|------|----------|
| **RAGKnowledgeAgent** | 差旅政策知识库问答 | ChromaDB + BGE-small-zh-v1.5，8 类文档，文档溯源 |
| **EventCollectionAgent** | 提取行程要素 | 出发地/目的地/日期/目的，主动推断缺失信息 |
| **PreferenceAgent** | 偏好管理与智能更新 | LLM 语义识别 append/replace 动作 |
| **MemoryQueryAgent** | 历史记忆查询 | 查询 trip_history、preferences、chat_summary |
| **InformationQueryAgent** | 实时信息查询 | wttr.in（天气）+ DDGS（网络搜索）+ LLM 摘要 |
| **ItineraryPlanningAgent** | 生成完整行程计划 | 每日时间表、住宿、餐饮、交通、注意事项 |

---

## Web 界面

基于 **FastAPI + 原生 HTML/CSS/JS** 的聊天式界面：

- 渐变配色 + Inter 字体 + 毛玻璃效果
- Markdown 渲染（marked.js），支持表格、代码块
- 侧边栏：偏好设置、行程历史、系统状态（30s 自动刷新）
- 响应式布局（桌面/移动端适配）
- 熔断器状态指示 + 连接检测

**桌面端：**

![TripSage 桌面界面](images\界面.png)
![TripSage 桌面界面2](images\界面2.png)

**移动端：**

<p align="center">
  <img src="images\手机页面1.png" alt="移动端-聊天界面" width="45%">
  &nbsp;&nbsp;
  <img src="images\手机页面2.png" alt="移动端-侧边栏" width="45%">
</p>

---

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `help` | 显示帮助 |
| `status` | 查看记忆状态和统计 |
| `health` | LLM 可达性 + 熔断器状态 |
| `clear` | 清空短期记忆 |
| `history` | 查看历史行程 |
| `preferences` | 查看用户偏好 |
| `exit` | 退出 |

健康检查（非交互）：`python cli.py health`

---

## 技术栈

| 类别 | 技术 |
|------|------|
| Agent 框架 | AgentScope 1.0.16 |
| LLM | DeepSeek API（兼容 OpenAI SDK） |
| 向量数据库 | ChromaDB（本地持久化） |
| Embedding | BGE-small-zh-v1.5（本地部署） |
| Web 框架 | FastAPI + Uvicorn |
| 前端 | 原生 HTML/CSS/JS + marked.js |
| 记忆系统 | 短期（内存滑动窗口）+ 长期（JSON 持久化） |
| 网络搜索 | wttr.in（天气）+ DDGS（搜索） |
| CLI 界面 | Rich 13.9.4 |
| 韧性保障 | 熔断器 + 指数退避重试 + 健康检查 |

---

## 项目结构

```
tripsage/
├── agents/                          # 核心编排层
│   ├── intention_agent.py           # 意图识别（LLM 语义理解）
│   ├── orchestration_agent.py       # 协调器（优先级并行调度）
│   └── lazy_agent_registry.py       # 插件注册器（动态发现 + 懒加载）
├── .claude/skills/                  # Skill Plugins
│   ├── ask-question/                # RAG 知识库问答
│   ├── event-collection/            # 事项收集
│   ├── plan-trip/                   # 行程规划
│   ├── preference/                  # 偏好管理
│   ├── query-info/                  # 信息查询
│   └── memory-query/                # 记忆查询
├── context/                         # 记忆系统
│   ├── memory_manager.py            # 记忆管理器（外观模式）
│   ├── short_term_memory.py         # 短期记忆（10 轮滑动窗口）
│   └── long_term_memory.py          # 长期记忆（JSON 持久化）
├── web/                             # Web 界面
│   ├── app.py                       # FastAPI 应用 + API 路由
│   ├── response_formatter.py        # 结果 → Markdown 格式化
│   ├── templates/index.html         # 聊天 SPA 页面
│   └── static/                      # CSS + JS
├── utils/                           # 工具与韧性
│   ├── circuit_breaker.py           # 熔断器（CLOSED→OPEN→HALF_OPEN）
│   ├── llm_resilience.py            # 指数退避重试 + 健康检查
│   ├── json_parser.py               # 鲁棒 JSON 解析
│   └── skill_loader.py              # SKILL.md 加载器
├── data/
│   ├── memory/                      # 用户长期记忆（{user_id}.json）
│   └── models/bge-small-zh-v1.5/    # 本地 Embedding 模型
├── tests/                           # 测试
├── cli.py                           # CLI 入口
├── config.py                        # LLM / 系统 / RAG 配置
├── config_agentscope.py             # AgentScope 初始化
└── requirements.txt
```

---

## 测试

```bash
# 端到端集成测试
python tests/test_cli_qa.py

# 模块测试
python tests/test_memory_system.py    # 两层记忆系统
python tests/test_intention_agent.py  # 意图识别
python tests/test_orchestration.py    # 协调调度
python tests/test_rag_agent.py        # RAG 知识库
```

---

## 许可证

MIT License
