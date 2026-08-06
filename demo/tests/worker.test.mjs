import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = {
  AI: {
    async run(model, options) {
      assert.equal(model, "@cf/qwen/qwen3-30b-a3b-fp8");
      assert.equal(options.messages.at(-1).content, "帮我规划上海到北京三天出差");
      assert.equal(options.max_tokens, 2000);
      return { response: "这是一个测试行程。" };
    },
  },
  ASSETS: {
    async fetch() {
      return new Response("static", { status: 200 });
    },
  },
};

test("chat endpoint returns a Workers AI reply", async () => {
  const request = new Request("https://demo.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "帮我规划上海到北京三天出差" }),
  });
  const response = await worker.fetch(request, env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.reply, "这是一个测试行程。");
  assert.deepEqual(body.agents_called, []);
});

test("status endpoint exposes demo mode", async () => {
  const response = await worker.fetch(
    new Request("https://demo.example/api/status?user_id=tester"),
    env,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session_id, "tester");
  assert.deepEqual(body.loaded_agents, ["TripSage"]);
});

test("static requests are passed to the asset binding", async () => {
  const response = await worker.fetch(new Request("https://demo.example/"), env);
  assert.equal(await response.text(), "static");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("weather endpoint returns normalized Open-Meteo data", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith("https://geocoding-api.open-meteo.com")) {
      return Response.json({
        results: [{ name: "北京", admin1: "北京市", country: "中国", latitude: 39.9, longitude: 116.4 }],
      });
    }
    if (target.startsWith("https://api.open-meteo.com")) {
      return Response.json({
        timezone: "Asia/Shanghai",
        current: {
          time: "2026-08-04T15:00",
          temperature_2m: 30,
          apparent_temperature: 32,
          relative_humidity_2m: 55,
          precipitation: 0,
          weather_code: 1,
          wind_speed_10m: 9,
        },
        daily: {
          time: ["2026-08-04"],
          weather_code: [1],
          temperature_2m_max: [33],
          temperature_2m_min: [24],
          precipitation_probability_max: [20],
        },
      });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(new Request("https://demo.example/api/weather", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ city: "北京" }),
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.weather.location.name, "北京");
  assert.match(body.reply, /30°C/);
  assert.equal(body.weather.source, "Open-Meteo");
});

test("supplier status exposes official booking handoffs", async () => {
  const response = await worker.fetch(
    new Request("https://demo.example/api/suppliers/status"),
    env,
  );
  const body = await response.json();
  assert.equal(body.weather.configured, true);
  assert.equal(body.flights.provider, "飞猪旅行");
  assert.equal(body.flights.mode, "official-handoff");
  assert.equal(body.hotels.provider, "飞猪旅行");
  assert.equal(body.hotels.mode, "official-handoff");
  assert.equal(body.rail.mode, "official-handoff");
  assert.equal(body.knowledge.configured, false);
});

test("chat uses relevant Vectorize knowledge and exposes its source", async () => {
  let queryOptions;
  const ragEnv = {
    ...env,
    AI: {
      async run(model, options) {
        if (model === "@cf/baai/bge-m3") {
          assert.deepEqual(options.text, ["一线城市住宿标准是多少？"]);
          return { data: [Array(1024).fill(0.01)] };
        }
        const context = options.messages.find((item) =>
          item.role === "system" && item.content.includes("企业差旅演示知识库"),
        );
        assert.match(context.content, /不超过500元\/晚/);
        return { response: "一线城市住宿不超过500元/晚。\n\n资料来源：阿里商旅差旅标准和规定" };
      },
    },
    RAG_INDEX: {
      async query(vector, options) {
        assert.equal(vector.length, 1024);
        queryOptions = options;
        return {
          matches: [{
            id: "01-001",
            score: 0.91,
            metadata: {
              title: "阿里商旅差旅标准和规定",
              category: "差旅标准",
              file: "01_travel_standards.txt",
              content: "一线城市住宿标准：不超过500元/晚。",
            },
          }],
        };
      },
    },
  };
  const response = await worker.fetch(new Request("https://demo.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "一线城市住宿标准是多少？" }),
  }), ragEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(queryOptions, { topK: 5, returnMetadata: "all" });
  assert.deepEqual(body.agents_called, ["企业差旅知识库"]);
  assert.deepEqual(body.knowledge_sources, ["阿里商旅差旅标准和规定"]);
});

test("chat retrieves only the current anonymous workspace knowledge", async () => {
  let workspaceFilter;
  const personalEnv = {
    ...env,
    AI: {
      async run(model, options) {
        if (model === "@cf/baai/bge-m3") return { data: [Array(1024).fill(0.03)] };
        const context = options.messages.find((item) =>
          item.role === "system" && item.content.includes("晚餐标准为每人八十元"),
        );
        assert.ok(context);
        return { response: "你的临时资料中，晚餐标准为每人八十元。" };
      },
    },
    RAG_INDEX: {
      async query(_vector, options) {
        if (!options.filter) return { matches: [] };
        workspaceFilter = options.filter.workspace_id;
        return {
          matches: [{
            id: "personal-test-001",
            score: 0.94,
            metadata: {
              workspace_id: workspaceFilter,
              title: "我的餐饮规则",
              category: "个人差旅规则",
              file: "meal.md",
              content: "晚餐标准为每人八十元。",
            },
          }],
        };
      },
    },
  };
  const response = await worker.fetch(new Request("https://demo.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tripsage-workspace": "c".repeat(64) },
    body: JSON.stringify({ message: "我的差旅餐饮标准是什么？" }),
  }), personalEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(workspaceFilter, /^[a-f0-9]{32}$/);
  assert.deepEqual(body.knowledge_sources, ["我的餐饮规则"]);
});

test("chat preserves planning text and returns a structured live-search query", async () => {
  const bookingEnv = {
    ...env,
    AI: { async run() { return { response: "高铁二等座553元，机票1500元，均有余票。" }; } },
  };
  const response = await worker.fetch(new Request("https://demo.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "比较上海到北京的飞机和高铁方案，并给我订票入口" }),
  }), bookingEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.booking_links, []);
  assert.doesNotMatch(body.reply, /553元|1500元/);
  assert.match(body.reply, /具体班次与查询时价格请使用下方查询卡核对/);
  assert.equal(body.travel_query.origin, "上海");
  assert.equal(body.travel_query.destination, "北京");
  assert.deepEqual(body.travel_query.types, ["flight", "train"]);
  assert.deepEqual(body.travel_query.missing_fields, ["departure_date"]);
});

test("travel search returns normalized FlyAI results and a safe deep link", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://flyai.open.fliggy.com/mcp");
    assert.match(options.headers.authorization, /^Bearer /);
    assert.ok(options.headers["x-flyai-sign"]);
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.params.name, "search_flight");
    assert.equal(requestBody.params.arguments.origin, "上海");
    return Response.json({
      jsonrpc: "2.0",
      id: requestBody.id,
      result: { content: [{ type: "text", text: JSON.stringify({ data: { itemList: [{
        ticketPrice: "¥520",
        jumpUrl: "https://router.feizhu.com/example",
        totalDuration: "150分钟",
        journeys: [{ journeyType: "直达", segments: [{
          marketingTransportName: "示例航司", marketingTransportNo: "TS100",
          depDateTime: "2026-08-20 08:00:00", arrDateTime: "2026-08-20 10:30:00",
          depStationName: "虹桥机场", arrStationName: "首都机场", seatClassName: "经济舱",
        }] }],
      }] } }) }] },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(new Request("https://demo.example/api/travel/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "flight", origin: "上海", destination: "北京", departure_date: "2026-08-20", adults: 1 }),
  }), { ...env, FLYAI_API_KEY: "test-key", FLYAI_SIGN_SECRET: "test-sign-secret" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results[0].price, "¥520");
  assert.equal(body.results[0].number, "TS100");
  assert.equal(body.results[0].jump_url, "https://router.feizhu.com/example");
});

test("anonymous knowledge workspaces isolate personal uploads", async () => {
  const store = new Map();
  const upserted = [];
  const workspaceEnv = {
    ...env,
    RAG_STORE: {
      async list({ prefix = "" }) {
        return { keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
    RAG_INDEX: {
      async upsert(vectors) { upserted.push(...vectors); return { mutationId: "upsert-1" }; },
      async deleteByIds() { return { mutationId: "delete-1" }; },
    },
    AI: {
      async run(model, options) {
        assert.equal(model, "@cf/baai/bge-m3");
        return { data: options.text.map(() => Array(1024).fill(0.02)) };
      },
    },
  };
  const missingWorkspace = await worker.fetch(
    new Request("https://demo.example/api/rag/documents"),
    workspaceEnv,
  );
  assert.equal(missingWorkspace.status, 401);

  const workspaceToken = "a".repeat(64);
  const uploaded = await worker.fetch(new Request("https://demo.example/api/rag/documents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tripsage-workspace": workspaceToken },
    body: JSON.stringify({
      name: "custom-policy.md",
      category: "公司制度",
      content: "公司差旅住宿制度\n\n一线城市住宿标准不超过每晚六百元，超标需要主管审批。",
    }),
  }), workspaceEnv);
  const body = await uploaded.json();
  assert.equal(uploaded.status, 201);
  assert.equal(body.document.name, "custom-policy.md");
  assert.equal(body.document.built_in, false);
  assert.equal(upserted.length, 1);
  assert.equal(store.size, 1);

  const ownList = await worker.fetch(new Request("https://demo.example/api/rag/documents", {
    headers: { "x-tripsage-workspace": workspaceToken },
  }), workspaceEnv);
  const ownBody = await ownList.json();
  assert.equal(ownBody.documents.length, 1);
  assert.equal(ownBody.documents[0].manageable, true);

  const otherList = await worker.fetch(new Request("https://demo.example/api/rag/documents", {
    headers: { "x-tripsage-workspace": "b".repeat(64) },
  }), workspaceEnv);
  const otherBody = await otherList.json();
  assert.equal(otherBody.documents.length, 0);
});

test("AI failure returns a usable degraded response", async () => {
  const failingEnv = {
    ...env,
    AI: { async run() { throw new Error("remote unavailable"); } },
  };
  const response = await worker.fetch(new Request("https://demo.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "比较上海到北京的飞机和高铁方案" }),
  }), failingEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.match(body.reply, /查询卡/);
  assert.ok(body.travel_query);
});
