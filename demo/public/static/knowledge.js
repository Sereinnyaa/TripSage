function getOrCreateWorkspaceToken() {
    const storageKey = 'tripsage_workspace_token';
    const existing = localStorage.getItem(storageKey);
    if (/^[a-f0-9]{64}$/.test(existing || '')) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(storageKey, token);
    return token;
}

const state = {
    token: getOrCreateWorkspaceToken(),
    documents: [],
    activeDocument: null,
    personalLimit: 3,
};

const uploadForm = document.getElementById('upload-form');
const uploadButton = document.getElementById('upload-button');
const uploadMessage = document.getElementById('upload-message');
const fileInput = document.getElementById('file-input');
const categoryInput = document.getElementById('category-input');
const dropzone = document.getElementById('dropzone');
const dropTitle = document.getElementById('drop-title');
const documentList = document.getElementById('document-list');
const searchInput = document.getElementById('search-input');
const dialog = document.getElementById('document-dialog');
const toast = document.getElementById('toast');

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-tripsage-workspace': state.token,
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `请求失败 (${response.status})`);
    return data;
}

async function loadDocuments() {
    try {
        const data = await api('/api/rag/documents');
        state.documents = data.documents || [];
        state.personalLimit = Number(data.personal_limit || 3);
        renderDocuments();
        renderStats();
    } catch (error) {
        documentList.innerHTML = `<div class="empty-library">${escapeHtml(error.message)}</div>`;
        showToast(error.message, true);
    }
}

function renderStats() {
    const builtIn = state.documents.filter((document) => document.built_in);
    const personal = state.documents.filter((document) => !document.built_in);
    const chunks = state.documents.reduce((sum, document) => sum + Number(document.chunk_count || 0), 0);
    document.getElementById('stat-built-in').textContent = builtIn.length;
    document.getElementById('stat-personal').textContent = personal.length;
    document.getElementById('stat-chunks').textContent = chunks;
    document.getElementById('personal-limit').textContent = `最多 ${state.personalLimit} 份`;
    document.getElementById('upload-quota').textContent = `${personal.length} / ${state.personalLimit}`;
    uploadButton.disabled = personal.length >= state.personalLimit;
    uploadButton.textContent = personal.length >= state.personalLimit ? '空间已满，请先删除一份' : '加入我的知识库';
}

function renderDocuments() {
    const query = searchInput.value.trim().toLowerCase();
    const documents = state.documents.filter((document) =>
        `${document.name} ${document.title} ${document.category}`.toLowerCase().includes(query),
    );
    if (!documents.length) {
        documentList.innerHTML = '<div class="empty-library">没有匹配的资料</div>';
        return;
    }
    documentList.innerHTML = documents.map((document) => {
        const expiry = document.built_in ? '长期可用' : `约 ${formatExpiry(document.expires_at)}后清理`;
        return `
            <div class="document-row" data-id="${escapeHtml(document.id)}">
                <div>
                    <div class="document-title">
                        <strong title="${escapeHtml(document.name)}">${escapeHtml(document.title || document.name)}</strong>
                        <span class="tag ${document.built_in ? 'built-in-tag' : 'personal-tag'}">${document.built_in ? '内置只读' : '我的上传'}</span>
                    </div>
                    <div class="document-meta">${escapeHtml(document.category)} · ${document.chunk_count} 个片段 · ${formatSize(document.size)} · ${expiry}</div>
                </div>
                <div class="row-actions">
                    <button type="button" data-action="view">查看</button>
                    ${document.manageable ? '<button type="button" class="delete-button" data-action="delete">删除</button>' : ''}
                </div>
            </div>
        `;
    }).join('');
}

searchInput.addEventListener('input', renderDocuments);

documentList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('.document-row');
    if (!button || !row) return;
    const id = row.dataset.id;
    if (button.dataset.action === 'view') await viewDocument(id);
    if (button.dataset.action === 'delete') await removeDocument(id, button);
});

async function viewDocument(id) {
    try {
        const data = await api(`/api/rag/documents/${encodeURIComponent(id)}`);
        state.activeDocument = data.document;
        document.getElementById('dialog-category').textContent = data.document.built_in
            ? `${data.document.category} · 内置只读`
            : `${data.document.category} · 当前浏览器`;
        document.getElementById('dialog-title').textContent = data.document.title || data.document.name;
        document.getElementById('dialog-content').textContent = data.document.content;
        dialog.showModal();
    } catch (error) {
        showToast(error.message, true);
    }
}

async function removeDocument(id, button) {
    const item = state.documents.find((document) => document.id === id);
    if (!item?.manageable) return;
    if (!window.confirm(`删除“${item.title || item.name}”？删除只影响当前浏览器的知识空间。`)) return;
    button.disabled = true;
    try {
        await api(`/api/rag/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.documents = state.documents.filter((document) => document.id !== id);
        renderDocuments();
        renderStats();
        showToast('已从你的知识空间删除。');
    } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
    }
}

fileInput.addEventListener('change', updateSelectedFile);
function updateSelectedFile() {
    dropTitle.textContent = fileInput.files[0]?.name || '拖入文档，或点击选择';
}

for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragging');
    });
}
for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('dragging');
    });
}
dropzone.addEventListener('drop', (event) => {
    if (!event.dataTransfer.files.length) return;
    fileInput.files = event.dataTransfer.files;
    updateSelectedFile();
});

uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    if (!/\.(txt|md|csv)$/i.test(file.name)) {
        uploadMessage.textContent = '请选择 TXT、Markdown 或 CSV 文档。';
        return;
    }
    uploadButton.disabled = true;
    uploadButton.textContent = '正在生成知识片段…';
    uploadMessage.textContent = '处理完成后即可在对话中查询，请不要关闭页面。';
    try {
        const content = await file.text();
        if (content.length > 50_000) throw new Error('单份文档最多 5 万字符。');
        const data = await api('/api/rag/documents', {
            method: 'POST',
            body: JSON.stringify({ name: file.name, category: categoryInput.value.trim(), content }),
        });
        state.documents = [...state.documents, data.document];
        renderDocuments();
        renderStats();
        uploadForm.reset();
        categoryInput.value = '个人差旅规则';
        updateSelectedFile();
        uploadMessage.textContent = '';
        showToast('已加入临时知识库，检索通常在数秒内生效。');
    } catch (error) {
        uploadMessage.textContent = error.message;
    } finally {
        renderStats();
    }
});

document.getElementById('dialog-close').addEventListener('click', () => dialog.close());
document.getElementById('dialog-done').addEventListener('click', () => dialog.close());
document.getElementById('download-button').addEventListener('click', () => {
    if (!state.activeDocument) return;
    const blob = new Blob([state.activeDocument.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.activeDocument.name || 'knowledge.txt';
    anchor.click();
    URL.revokeObjectURL(url);
});

let toastTimer;
function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast show${isError ? ' error' : ''}`;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function formatSize(value) {
    const characters = Number(value || 0);
    if (characters < 1000) return `${characters} 字符`;
    return `${(characters / 1000).toFixed(1)}k 字符`;
}

function formatExpiry(value) {
    const remaining = Math.max(0, Date.parse(value) - Date.now());
    const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
    return `${hours} 小时`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

loadDocuments();
