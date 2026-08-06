# TripSage 轻量体验版

这个目录是独立的 Cloudflare Workers 部署版本，不会改动项目原有的 Python/FastAPI 完整版。

## 架构

- `public/`：原 TripSage 网页的静态资源
- `src/index.js`：仅保留聊天与兼容侧边栏的轻量 API
- Cloudflare Workers AI：使用 Qwen3 模型生成差旅行程建议
- Open-Meteo：实时天气和未来四天天气预报，无需密钥
- 飞猪与铁路 12306：提供官方查询入口，不抓取第三方页面价格
- 浏览器：保留最近 8 条对话和匿名知识空间钥匙，不建立账号数据库

## 本地检查与部署

```bash
npm install
npm test
npm run check
npm run deploy
```

`npm run dev` 使用 Cloudflare 远程开发环境测试 Workers AI，需要先完成 `npx wrangler login`。

## 供应商接口

天气接口开箱即用：

```http
POST /api/weather
Content-Type: application/json

{"city":"北京"}
```

机票和酒店当前不接入第三方价格 API。AI 根据问题提供飞猪入口，由用户在飞猪核对实时价格、库存和退改规则。

## 产品限制

- 调试版本不限制浏览器消息次数；公开推广前应增加服务端频率限制
- 不保存长期记忆、偏好或历史行程
- 天气已接入实时数据；机酒价格在飞猪确认，高铁由 12306 官方渠道确认
- Workers AI 当日免费额度用完后，接口会暂时返回繁忙提示

## 在线 RAG 知识库

- 原始资料位于 `rag/documents/`，当前包含 8 份差旅政策、报销、预订、应急、平台、城市与低碳出行文档。
- `npm run rag:build` 会把文档切分为可重复导入的 `src/rag-data.generated.js`。
- 线上检索使用 Cloudflare Vectorize 索引 `tripsage-rag`，查询向量由 `@cf/baai/bge-m3` 生成。
- Worker 只在差旅制度、报销、预订、应急或城市指南类问题中检索知识库，并把命中的资料标题随回答返回。
- `/knowledge.html` 是无密码的匿名知识空间：内置资料只读，每个浏览器最多上传 3 份 TXT、Markdown 或 CSV 文档。
- 浏览器本地生成随机空间钥匙，Worker 只使用其哈希 ID 隔离 KV 文档和 Vectorize 向量；聊天只能检索内置资料和当前浏览器的上传。
- 个人文档 24 小时后失效，定时任务会清理 KV 原文和对应向量。单份文档最多 5 万字符。

## 预订跳转

- AI 回答会根据问题附上铁路 12306 或飞猪旅行入口。
- 未获得实时供应商数据时，服务端会阻止回答展示未经验证的具体票价、车次、航班或库存。
- 预订跳转不代表 TripSage 已读取飞猪价格或完成下单。
