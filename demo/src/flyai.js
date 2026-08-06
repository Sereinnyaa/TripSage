const FLYAI_ENDPOINT = "https://flyai.open.fliggy.com/mcp";

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function createSignature(body, authorization, timestamp, nonce, secret) {
  const canonical = [
    "POST",
    "/mcp",
    timestamp,
    nonce,
    await sha256Hex(body),
    await sha256Hex(authorization),
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return bytesToBase64Url(new Uint8Array(signature));
}

function randomNonce() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function parseMcpPayload(payload) {
  if (payload?.error) throw new Error(payload.error.message || "FlyAI request failed");
  const blocks = payload?.result?.content;
  const text = Array.isArray(blocks)
    ? blocks.filter((item) => item?.type === "text").map((item) => item.text || "").join("")
    : "";
  if (!text) return payload?.result || {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("FlyAI returned an invalid response");
  }
}

function parseSse(text) {
  const dataLines = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (!dataLines.length) throw new Error("FlyAI returned an empty response");
  return JSON.parse(dataLines.at(-1));
}

export async function callFlyAi(toolName, args, env) {
  if (!env.FLYAI_API_KEY || !env.FLYAI_SIGN_SECRET) {
    throw new Error("FlyAI is not configured");
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const authorization = `Bearer ${env.FLYAI_API_KEY}`;
  const timestamp = String(Date.now());
  const nonce = randomNonce();
  const signature = await createSignature(
    body,
    authorization,
    timestamp,
    nonce,
    env.FLYAI_SIGN_SECRET,
  );
  const response = await fetch(FLYAI_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
      "x-ttid": "ai2c(sk.clawhub)",
      "x-flyai-sign-ver": "7",
      "x-flyai-sign-alg": "hmac-sha256",
      "x-flyai-ts": timestamp,
      "x-flyai-nonce": nonce,
      "x-flyai-sign": signature,
    },
    body,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`FlyAI HTTP ${response.status}`);
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? parseSse(raw)
    : JSON.parse(raw);
  return parseMcpPayload(payload);
}

function safeSupplierUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return "";
    if (!["feizhu.com", "fliggy.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function firstSegment(item) {
  return item?.journeys?.[0]?.segments?.[0] || {};
}

function lastSegment(item) {
  const segments = item?.journeys?.[0]?.segments || [];
  return segments.at(-1) || {};
}

function normalizeTransportItem(item, type) {
  const first = firstSegment(item);
  const last = lastSegment(item);
  const price = item.ticketPrice || item.adultPrice || item.price || "";
  return {
    type,
    name: first.marketingTransportName || (type === "flight" ? "航班" : "列车"),
    number: first.marketingTransportNo || first.transportNo || "",
    departure_time: first.depDateTime || "",
    arrival_time: last.arrDateTime || "",
    departure_station: [first.depStationName, first.depTerm].filter(Boolean).join(" "),
    arrival_station: [last.arrStationName, last.arrTerm].filter(Boolean).join(" "),
    duration: item.totalDuration || item?.journeys?.[0]?.totalDuration || first.duration || "",
    seat: first.seatClassName || "",
    route_type: item?.journeys?.[0]?.journeyType || "",
    price: String(price),
    jump_url: safeSupplierUrl(item.jumpUrl),
  };
}

function normalizeHotelItem(item) {
  return {
    type: "hotel",
    name: String(item.name || "酒店"),
    address: String(item.address || ""),
    nearby: String(item.interestsPoi || ""),
    star: String(item.star || ""),
    score: String(item.score || ""),
    score_desc: String(item.scoreDesc || ""),
    price: String(item.price || ""),
    jump_url: safeSupplierUrl(item.detailUrl || item.jumpUrl),
  };
}

export function normalizeFlyAiResults(payload, type) {
  const items = payload?.data?.itemList || [];
  if (!Array.isArray(items)) return [];
  const normalized = type === "hotel"
    ? items.map(normalizeHotelItem)
    : items.map((item) => normalizeTransportItem(item, type));
  return normalized.filter((item) => item.jump_url || item.name).slice(0, 6);
}
