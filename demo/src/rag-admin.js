const MAX_DOCUMENT_LENGTH = 50_000;
const MAX_CHUNK_LENGTH = 850;
const MAX_PERSONAL_DOCUMENTS = 3;
const RETENTION_SECONDS = 24 * 60 * 60;
const CLEANUP_GRACE_SECONDS = 12 * 60 * 60;
const WORKSPACE_HEADER = "x-tripsage-workspace";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function digestHex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getWorkspaceIdFromRequest(request) {
  const token = String(request.headers.get(WORKSPACE_HEADER) || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) return "";
  return (await digestHex(token)).slice(0, 32);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function splitLongBlock(block) {
  if (block.length <= MAX_CHUNK_LENGTH) return [block];
  const parts = [];
  for (let offset = 0; offset < block.length; offset += MAX_CHUNK_LENGTH) {
    parts.push(block.slice(offset, offset + MAX_CHUNK_LENGTH));
  }
  return parts;
}

function chunkDocument(text, title) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap(splitLongBlock);
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const candidate = [current, block].filter(Boolean).join("\n\n");
    if (current && candidate.length > MAX_CHUNK_LENGTH) {
      chunks.push(current);
      current = `${title}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function documentSummary(document, builtIn = Boolean(document.built_in)) {
  return {
    id: document.id,
    name: document.name,
    title: document.title,
    category: document.category,
    size: document.size,
    chunk_count: document.chunk_count,
    built_in: builtIn,
    manageable: !builtIn,
    created_at: document.created_at,
    expires_at: builtIn ? null : document.expires_at,
  };
}

async function readDocumentsByPrefix(env, prefix, limit = 100) {
  const listing = await env.RAG_STORE.list({ prefix, limit });
  const entries = await Promise.all(
    listing.keys.map(async (entry) => ({
      key: entry.name,
      document: await env.RAG_STORE.get(entry.name, "json"),
    })),
  );
  return entries.filter((entry) => entry.document);
}

function isExpired(document) {
  return Boolean(document.expires_at && Date.parse(document.expires_at) <= Date.now());
}

async function deleteStoredDocument(key, document, env) {
  const vectorIds = Array.isArray(document.vector_ids) ? document.vector_ids : [];
  const mutation = vectorIds.length ? await env.RAG_INDEX.deleteByIds(vectorIds) : null;
  await env.RAG_STORE.delete(key);
  return mutation?.mutationId || null;
}

async function listDocuments(env, workspaceId) {
  const [builtInEntries, personalEntries] = await Promise.all([
    readDocumentsByPrefix(env, "doc:", 100),
    readDocumentsByPrefix(env, `workspace:${workspaceId}:doc:`, MAX_PERSONAL_DOCUMENTS + 5),
  ]);

  const activePersonal = [];
  for (const entry of personalEntries) {
    if (isExpired(entry.document)) {
      await deleteStoredDocument(entry.key, entry.document, env);
    } else {
      activePersonal.push(entry.document);
    }
  }

  const builtIns = builtInEntries.map(({ document }) => ({ ...document, built_in: true }));
  const personal = activePersonal.map((document) => ({ ...document, built_in: false }));
  return [...builtIns, ...personal].sort((left, right) => {
    if (Boolean(left.built_in) !== Boolean(right.built_in)) return left.built_in ? -1 : 1;
    return String(right.created_at || "").localeCompare(String(left.created_at || ""));
  });
}

async function uploadDocument(request, env, embedTexts, workspaceId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: "上传内容格式不正确。" }, 400);
  }

  const name = normalizeText(body?.name).slice(0, 120);
  const title = normalizeText(body?.title || name.replace(/\.[^.]+$/, "")).slice(0, 120);
  const category = normalizeText(body?.category || "个人知识").slice(0, 40);
  const content = normalizeText(body?.content);
  if (!name || !title) return json({ detail: "请填写文档名称。" }, 400);
  if (!/\.(txt|md|csv)$/i.test(name)) {
    return json({ detail: "目前仅支持 TXT、Markdown 和 CSV 文本文档。" }, 400);
  }
  if (content.length < 20) return json({ detail: "文档内容过短，至少需要 20 个字符。" }, 400);
  if (content.length > MAX_DOCUMENT_LENGTH) {
    return json({ detail: "单个文档请控制在 5 万字符以内。" }, 413);
  }

  const documents = await listDocuments(env, workspaceId);
  const personal = documents.filter((document) => !document.built_in);
  if (personal.length >= MAX_PERSONAL_DOCUMENTS) {
    return json({ detail: `当前浏览器最多上传 ${MAX_PERSONAL_DOCUMENTS} 份文档，请先删除一份。` }, 409);
  }
  if (personal.some((document) => String(document.name).toLowerCase() === name.toLowerCase())) {
    return json({ detail: "当前空间已存在同名文档，请先删除旧版本。" }, 409);
  }

  const id = `personal-${crypto.randomUUID()}`;
  const chunks = chunkDocument(content, title);
  const vectorIds = [];
  const mutations = [];
  const expiresAt = new Date(Date.now() + RETENTION_SECONDS * 1000).toISOString();
  for (let offset = 0; offset < chunks.length; offset += 12) {
    const batch = chunks.slice(offset, offset + 12);
    const embeddings = await embedTexts(batch, env);
    const vectors = batch.map((chunk, index) => {
      const chunkIndex = offset + index + 1;
      const vectorId = `${id}-${String(chunkIndex).padStart(3, "0")}`;
      vectorIds.push(vectorId);
      return {
        id: vectorId,
        values: embeddings[index],
        metadata: {
          scope: "workspace",
          workspace_id: workspaceId,
          document_id: id,
          title,
          category,
          file: name,
          chunk_index: chunkIndex,
          content: chunk,
          expires_at: expiresAt,
        },
      };
    });
    const mutation = await env.RAG_INDEX.upsert(vectors);
    mutations.push(mutation?.mutationId || null);
  }

  const document = {
    id,
    workspace_id: workspaceId,
    name,
    title,
    category,
    size: content.length,
    chunk_count: chunks.length,
    vector_ids: vectorIds,
    content,
    built_in: false,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };
  const key = `workspace:${workspaceId}:doc:${id}`;
  await env.RAG_STORE.put(key, JSON.stringify(document), {
    expirationTtl: RETENTION_SECONDS + CLEANUP_GRACE_SECONDS,
  });
  return json({ document: documentSummary(document, false), mutations }, 201);
}

async function findDocument(id, env, workspaceId) {
  if (id.startsWith("personal-")) {
    const key = `workspace:${workspaceId}:doc:${id}`;
    return { key, document: await env.RAG_STORE.get(key, "json"), builtIn: false };
  }
  const key = `doc:${id}`;
  return { key, document: await env.RAG_STORE.get(key, "json"), builtIn: true };
}

async function getDocument(id, env, workspaceId) {
  const found = await findDocument(id, env, workspaceId);
  if (!found.document || (!found.builtIn && isExpired(found.document))) {
    if (found.document) await deleteStoredDocument(found.key, found.document, env);
    return json({ detail: "没有找到该文档。" }, 404);
  }
  return json({
    document: {
      ...documentSummary(found.document, found.builtIn),
      content: found.document.content,
    },
  });
}

async function deleteDocument(id, env, workspaceId) {
  if (!id.startsWith("personal-")) return json({ detail: "内置资料为只读，不能删除。" }, 403);
  const found = await findDocument(id, env, workspaceId);
  if (!found.document) return json({ detail: "没有找到该文档。" }, 404);
  const mutation = await deleteStoredDocument(found.key, found.document, env);
  return json({ deleted: id, mutation });
}

export async function cleanupExpiredDocuments(env) {
  if (!env.RAG_STORE || !env.RAG_INDEX) return { checked: 0, deleted: 0 };
  let cursor;
  let checked = 0;
  let deleted = 0;
  do {
    const listing = await env.RAG_STORE.list({ prefix: "workspace:", limit: 250, cursor });
    for (const entry of listing.keys) {
      const document = await env.RAG_STORE.get(entry.name, "json");
      checked += 1;
      if (document && isExpired(document)) {
        await deleteStoredDocument(entry.name, document, env);
        deleted += 1;
      }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  return { checked, deleted };
}

export async function handleRagWorkspace(request, env, embedTexts) {
  if (!env.RAG_STORE || !env.RAG_INDEX) {
    return json({ detail: "知识库服务尚未完成配置。" }, 503);
  }
  const workspaceId = await getWorkspaceIdFromRequest(request);
  if (!workspaceId) return json({ detail: "当前浏览器的知识空间凭据无效，请刷新页面重试。" }, 401);

  const url = new URL(request.url);
  const collectionPath = "/api/rag/documents";
  if (url.pathname === "/api/rag/workspace" && request.method === "GET") {
    return json({
      ready: true,
      retention_hours: RETENTION_SECONDS / 3600,
      document_limit: MAX_PERSONAL_DOCUMENTS,
      character_limit: MAX_DOCUMENT_LENGTH,
    });
  }
  if (url.pathname === collectionPath && request.method === "GET") {
    const documents = await listDocuments(env, workspaceId);
    return json({
      documents: documents.map((document) => documentSummary(document)),
      personal_limit: MAX_PERSONAL_DOCUMENTS,
      retention_hours: RETENTION_SECONDS / 3600,
    });
  }
  if (url.pathname === collectionPath && request.method === "POST") {
    return uploadDocument(request, env, embedTexts, workspaceId);
  }
  if (url.pathname.startsWith(`${collectionPath}/`)) {
    const id = decodeURIComponent(url.pathname.slice(collectionPath.length + 1));
    if (!id || id.includes("/")) return json({ detail: "文档编号不正确。" }, 400);
    if (request.method === "GET") return getDocument(id, env, workspaceId);
    if (request.method === "DELETE") return deleteDocument(id, env, workspaceId);
  }
  return json({ detail: "接口不存在。" }, 404);
}
