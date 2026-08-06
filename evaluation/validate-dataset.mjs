import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const records = readFileSync(join(here, "cases.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const expectedModules = {
  intent: 400,
  rag: 250,
  preference_memory: 150,
  itinerary: 120,
  tool_routing: 80,
};
const counts = {};
const splits = {};
const ids = new Set();
const inputs = new Set();

for (const record of records) {
  if (!record.id || !record.module || !record.split || !record.input || !record.expected) {
    throw new Error(`Invalid record: ${JSON.stringify(record)}`);
  }
  if (ids.has(record.id)) throw new Error(`Duplicate id: ${record.id}`);
  if (inputs.has(record.input)) throw new Error(`Duplicate input: ${record.input}`);
  ids.add(record.id);
  inputs.add(record.input);
  counts[record.module] = (counts[record.module] || 0) + 1;
  splits[record.split] = (splits[record.split] || 0) + 1;
}

if (records.length !== 1000) throw new Error(`Expected 1000 records, received ${records.length}`);
for (const [module, count] of Object.entries(expectedModules)) {
  if (counts[module] !== count) throw new Error(`${module}: expected ${count}, received ${counts[module] || 0}`);
}
if (splits.dev !== 700 || splits.test !== 300) {
  throw new Error(`Expected dev/test 700/300, received ${splits.dev || 0}/${splits.test || 0}`);
}

console.log(JSON.stringify({ total: records.length, modules: counts, splits }, null, 2));
