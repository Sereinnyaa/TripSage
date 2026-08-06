import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "cases.jsonl");
const cases = [];

const cities = ["上海", "北京", "深圳", "广州", "杭州", "成都", "武汉", "南京", "西安", "厦门"];
const dates = ["2026-09-08", "2026-09-15", "2026-10-12", "2026-10-20", "2026-11-03", "2026-11-18", "2026-12-02", "2026-12-16"];
const purposes = ["客户拜访", "项目评审", "行业会议", "供应商沟通", "团队培训", "合同谈判"];
const budgets = ["经济型", "标准型", "舒适型"];
const travelerRoles = ["销售", "产品经理", "项目经理", "顾问", "培训讲师", "采购", "运营", "工程师", "设计师", "财务"];
const timeConstraints = ["上午抵达", "下午抵达", "避开早高峰", "避开晚高峰", "当天有会议", "次日有会议", "行李较多", "需要开票", "时间可调整", "优先少换乘"];
const usedInputs = new Set();
const splitFor = (index) => ((index * 37) % 10 < 7 ? "dev" : "test");
const pairFor = (index) => {
  const origin = cities[index % cities.length];
  const destination = cities[(index * 3 + 1) % cities.length];
  return origin === destination
    ? [origin, cities[(cities.indexOf(origin) + 1) % cities.length]]
    : [origin, destination];
};
const add = (module, index, input, expected, tags = []) => {
  if (usedInputs.has(input)) {
    const sequence = cases.length;
    const role = travelerRoles[sequence % travelerRoles.length];
    const constraint = timeConstraints[Math.floor(sequence / travelerRoles.length) % timeConstraints.length];
    const people = 1 + (Math.floor(sequence / 100) % 5);
    const budget = 350 + Math.floor(sequence / 500) * 150;
    input = `${input}。补充背景：${role}出行，${constraint}，${people}人同行，住宿预算每晚${budget}元。`;
  }
  usedInputs.add(input);
  cases.push({
    id: `${module}-${String(index + 1).padStart(4, "0")}`,
    module,
    split: splitFor(index),
    input,
    expected,
    tags,
  });
};

const intentSpecs = [
  {
    count: 120,
    intent: "itinerary_planning",
    templates: [
      (o, d, date, p, days) => `帮我规划${date}从${o}去${d}${days}天的${p}行程`,
      (o, d, date, p, days) => `我要从${o}到${d}出差${days}天，${date}出发，主要是${p}`,
      (o, d, date, p, days) => `${date}去${d}${p}，从${o}出发，给我安排${days}天交通住宿和日程`,
      (o, d, date, p, days) => `做一份${o}到${d}的差旅行程，时间${date}，共${days}天，任务是${p}`,
    ],
    expected: (o, d, date, _p, days) => ({
      primary_intent: "itinerary_planning",
      required_agents: ["event_collection", "itinerary_planning"],
      entities: { origin: o, destination: d, departure_date: date, duration_days: days },
    }),
  },
  {
    count: 70,
    intent: "rag_knowledge",
    templates: [
      (_o, d) => `公司规定去${d}出差能住什么标准的酒店？`,
      () => "差旅报销最晚什么时候提交，有什么材料要求？",
      () => "高铁可以订一等座吗？请按差旅制度回答并给出处",
      () => "航班延误产生的住宿费按规定能不能报销？",
    ],
    expected: () => ({ primary_intent: "rag_knowledge", required_agents: ["rag_knowledge"] }),
  },
  {
    count: 70,
    intent: "preference",
    templates: [
      () => "以后出差优先高铁，酒店尽量选地铁站附近",
      () => "我还喜欢靠窗座位，也偏好含早餐的酒店",
      () => "把我的住宿预算改成每晚五百元以内",
      (_o, _d, _date, _p, _days, index) => `以后第${(index % 5) + 1}类行程优先选择可免费取消的酒店`,
    ],
    expected: () => ({ primary_intent: "preference", required_agents: ["preference"] }),
  },
  {
    count: 50,
    intent: "memory_query",
    templates: [
      () => "我之前去过哪些城市出差？",
      () => "我保存过什么酒店和座位偏好？",
      (_o, d) => `我以前有没有去过${d}？`,
      () => "打开我最近一次行程的会话记录",
    ],
    expected: () => ({ primary_intent: "memory_query", required_agents: ["memory_query"] }),
  },
  {
    count: 50,
    intent: "information_query",
    templates: [
      (_o, d, date) => `查一下${d}${date}的天气和出行提醒`,
      (o, d, date) => `比较${date}${o}到${d}的飞机和高铁`,
      (_o, d) => `${d}机场到市中心通常怎么走？`,
      (_o, d) => `去${d}出差住哪个商务区通勤更方便？`,
    ],
    expected: () => ({ primary_intent: "information_query", required_agents: ["information_query"] }),
  },
  {
    count: 40,
    intent: "event_collection",
    templates: [
      (o, d) => `补充一下，我从${o}出发，目的地是${d}`,
      (_o, _d, date) => `出发日期确定为${date}，一共两个人`,
      (_o, _d, _date, p) => `这次出差目的是${p}，预计三天`,
      (o, d, date) => `${o}到${d}，${date}出发，其他信息之后补充`,
    ],
    expected: () => ({ primary_intent: "event_collection", required_agents: ["event_collection"] }),
  },
];

let intentIndex = 0;
for (const spec of intentSpecs) {
  for (let i = 0; i < spec.count; i += 1) {
    const [origin, destination] = pairFor(intentIndex);
    const date = dates[(intentIndex * 5 + i) % dates.length];
    const purpose = purposes[(intentIndex + i * 2) % purposes.length];
    const days = 2 + ((intentIndex + i) % 4);
    const template = spec.templates[(i * 3 + intentIndex) % spec.templates.length];
    const input = template(origin, destination, date, purpose, days, i);
    add("intent", intentIndex, input, spec.expected(origin, destination, date, purpose, days), [spec.intent]);
    intentIndex += 1;
  }
}

const ragSources = [
  {
    source: "01_travel_standards.txt",
    topics: [
      ["差旅申请时限", ["提前", "3个工作日"]],
      ["国内航班舱位", ["国内航班", "经济舱"]],
      ["高铁座席标准", ["高铁", "二等座"]],
      ["长期出差审批", ["超过10天", "审批"]],
      ["紧急出差补审批", ["返回后3日", "审批"]],
    ],
  },
  {
    source: "02_reimbursement_policy.txt",
    topics: [
      ["常规报销时限", ["30个自然日", "报销"]],
      ["十二月出差报销", ["次年1月15日", "报销"]],
      ["住宿报销材料", ["住宿日期", "发票"]],
      ["逾期报销", ["书面说明", "主管审批"]],
      ["交通费用凭证", ["行程单", "车票"]],
    ],
  },
  {
    source: "03_booking_guide.txt",
    topics: [
      ["国内机票预订时间", ["提前7-14天", "国内机票"]],
      ["国际机票预订时间", ["提前21-30天", "国际机票"]],
      ["中转时间", ["至少2小时", "中转"]],
      ["在线值机", ["起飞前24小时", "值机"]],
      ["退改签检查", ["退改签政策", "票价"]],
    ],
  },
  {
    source: "04_faq.txt",
    topics: [
      ["申请被驳回", ["驳回原因", "重新提交"]],
      ["延长出差", ["行程变更申请", "主管审批"]],
      ["个人原因提前出发", ["个人原因", "费用自理"]],
      ["私家车出差", ["申请", "使用私家车"]],
      ["遗失发票", ["遗失发票", "说明"]],
    ],
  },
  {
    source: "05_emergency_procedures.txt",
    topics: [
      ["航班延误", ["延误证明", "保留凭证"]],
      ["航班取消", ["退改方案", "航空公司"]],
      ["到店无房", ["酒店", "替代住宿"]],
      ["证件遗失", ["报警", "证件"]],
      ["突发疾病", ["就医", "主管"]],
    ],
  },
  {
    source: "06_platform_guide.txt",
    topics: [
      ["平台差旅申请", ["在线提交", "审批状态"]],
      ["机票预订功能", ["实时价格", "改签"]],
      ["火车票功能", ["余票", "发车提醒"]],
      ["酒店预订功能", ["企业协议酒店", "取消"]],
      ["平台数据安全", ["数据安全", "平台"]],
    ],
  },
  {
    source: "07_city_specific_tips.txt",
    topics: [
      ["北京机场交通", ["机场快轨", "东直门"]],
      ["北京住宿区域", ["国贸", "中关村"]],
      ["上海机场交通", ["机场", "市中心"]],
      ["广州商务出行", ["广州", "交通"]],
      ["深圳住宿区域", ["深圳", "住宿"]],
    ],
  },
  {
    source: "08_environmental_initiatives.txt",
    topics: [
      ["五百公里内交通", ["500公里", "高铁"]],
      ["短途飞行", ["300公里", "高铁"]],
      ["多地路线优化", ["减少往返", "总里程"]],
      ["绿色住宿", ["一次性用品", "节约用水用电"]],
      ["无纸化办公", ["无纸化", "电子文档"]],
    ],
  },
];
const ragQuestionTemplates = [
  (topic) => `按照公司的差旅资料，${topic}具体怎么规定？`,
  (topic) => `我想确认${topic}，请给出规则和资料来源。`,
  (topic) => `关于${topic}有哪些必须注意的要求？`,
  (topic) => `同事问我${topic}怎么处理，请依据知识库回答。`,
  (topic) => `只根据企业差旅资料说明${topic}，并标明出处。`,
];
let ragIndex = 0;
for (let sourceIndex = 0; sourceIndex < ragSources.length; sourceIndex += 1) {
  const spec = ragSources[sourceIndex];
  const count = sourceIndex < 2 ? 32 : 31;
  for (let i = 0; i < count; i += 1) {
    const [topic, concepts] = spec.topics[(i * 2 + sourceIndex) % spec.topics.length];
    const base = ragQuestionTemplates[(i + sourceIndex) % ragQuestionTemplates.length](topic);
    const context = i % 2 === 0 ? `我正在准备第${(i % 7) + 1}次出差。` : `这是一次${purposes[i % purposes.length]}行程。`;
    add("rag", ragIndex, `${context}${base}`, {
      source: spec.source,
      topic,
      required_concepts: concepts,
      require_source_attribution: true,
    }, ["retrieval", "grounding"]);
    ragIndex += 1;
  }
}

const preferenceTypes = [
  ["hotel_brands", ["全季", "汉庭", "亚朵", "如家"]],
  ["airlines", ["东航", "南航", "国航", "深航"]],
  ["seat_preference", ["靠窗", "靠过道", "前排"]],
  ["budget_level", ["经济型", "标准型", "舒适型"]],
  ["transportation_preference", ["高铁优先", "直飞优先", "公共交通优先"]],
];
const preferenceTemplates = {
  append: (value) => [`我还喜欢${value}`, `把${value}也加入我的差旅偏好`, `除了原来的选择，我也接受${value}`],
  replace: (value) => [`以后改成${value}`, `请把原来的偏好替换为${value}`, `今后的行程只按${value}考虑`],
  query: (_value, type) => [`我保存过哪些${type}偏好？`, `查看我的${type}设置`, `之前记住的${type}是什么？`],
};
for (let i = 0; i < 150; i += 1) {
  const [type, values] = preferenceTypes[i % preferenceTypes.length];
  const action = i < 60 ? "append" : i < 120 ? "replace" : "query";
  const value = values[(i * 3 + Math.floor(i / 5)) % values.length];
  const templates = preferenceTemplates[action](value, type);
  const input = `${templates[(i + Math.floor(i / 7)) % templates.length]}，用于${purposes[i % purposes.length]}场景。`;
  add("preference_memory", i, input, {
    preference_type: type,
    action,
    ...(action === "query" ? {} : { value }),
  }, [action]);
}

const itineraryRequirements = [
  "优先高铁并靠近地铁住宿",
  "控制预算并选择可免费取消的酒店",
  "上午到达，下午安排客户会议",
  "避免红眼航班，酒店需要含早餐",
  "每天最多安排两个正式事项",
  "最后一天预留两小时返程缓冲",
];
for (let i = 0; i < 120; i += 1) {
  const [origin, destination] = pairFor(i + 17);
  const days = 2 + (i % 4);
  const requirement = itineraryRequirements[(i * 5) % itineraryRequirements.length];
  const purpose = purposes[(i * 2) % purposes.length];
  const budget = budgets[i % budgets.length];
  const input = `规划${dates[i % dates.length]}从${origin}到${destination}的${days}天${purpose}行程，${requirement}，预算定位${budget}。`;
  add("itinerary", i, input, {
    entities: { origin, destination, departure_date: dates[i % dates.length], duration_days: days, purpose },
    required_sections: ["交通建议", "住宿区域", "每日安排", "出行提醒"],
    constraints: [requirement, `预算定位${budget}`],
  }, ["constraint_following", "completeness"]);
}

const toolSpecs = [
  { count: 25, type: "weather", endpoint: "/api/weather" },
  { count: 20, type: "flight", endpoint: "/api/travel/search" },
  { count: 20, type: "train", endpoint: "/api/travel/search" },
  { count: 15, type: "hotel", endpoint: "/api/travel/search" },
];
let toolIndex = 0;
for (const spec of toolSpecs) {
  for (let i = 0; i < spec.count; i += 1) {
    const [origin, destination] = pairFor(toolIndex + 31);
    const date = dates[(toolIndex * 3) % dates.length];
    const input = spec.type === "weather"
      ? `查询${destination}${date}的天气、降水概率和差旅提醒`
      : spec.type === "hotel"
        ? `查询${destination}${date}入住两晚的酒店实时方案，${1 + (i % 2)}人`
        : `查询${date}${origin}到${destination}的${spec.type === "flight" ? "航班" : "高铁"}实时方案，${1 + (i % 3)}人`;
    const entities = spec.type === "weather" || spec.type === "hotel"
      ? { destination, date }
      : { origin, destination, date };
    add("tool_routing", toolIndex, input, {
      endpoint: spec.endpoint,
      tool_type: spec.type,
      entities,
      fallback_required: true,
    }, [spec.type]);
    toolIndex += 1;
  }
}

mkdirSync(here, { recursive: true });
writeFileSync(output, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
console.log(`Generated ${cases.length} cases at ${output}`);
