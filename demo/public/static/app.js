/** TripSage browser client */
const STORAGE = {
    preferences: 'tripsage_preferences_v1',
    conversations: 'tripsage_conversations_v1',
    legacyPlans: 'tripsage_recent_plans_v1',
    workspace: 'tripsage_workspace_token',
};

function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

function getOrCreateWorkspaceToken() {
    const existing = localStorage.getItem(STORAGE.workspace);
    if (/^[a-f0-9]{64}$/.test(existing || '')) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(STORAGE.workspace, token);
    return token;
}

function createLocalId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function loadConversations() {
    const stored = readJson(STORAGE.conversations, null);
    if (Array.isArray(stored)) return stored.filter(item => Array.isArray(item.messages) && item.messages.length).slice(0, 20);
    const legacy = readJson(STORAGE.legacyPlans, []);
    if (!Array.isArray(legacy)) return [];
    return legacy.slice(0, 20).map(plan => ({
        id: createLocalId(),
        title: [plan.origin, plan.destination].filter(Boolean).join(' → ') || '差旅规划',
        updated_at: Number(plan.saved_at) || Date.now(),
        departure_date: plan.departure_date || '',
        messages: [
            { role: 'user', content: String(plan.prompt || '') },
            { role: 'assistant', content: String(plan.reply || '') },
        ].filter(message => message.content),
    })).filter(item => item.messages.length);
}

const state = {
    workspaceToken: getOrCreateWorkspaceToken(),
    isLoading: false,
    liveTravelConfigured: null,
    activeConversationId: null,
    history: [],
    preferences: readJson(STORAGE.preferences, {}),
    conversations: loadConversations(),
};
localStorage.removeItem('tripsage_demo_usage');
localStorage.removeItem('tripsage_user_id');

const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const connectionStatus = document.getElementById('connection-status');
const prefsEl = document.getElementById('sidebar-preferences');
const historyEl = document.getElementById('sidebar-history');
const statusEl = document.getElementById('sidebar-status');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarToggleMobile = document.getElementById('sidebar-toggle-mobile');
const newChatBtn = document.getElementById('new-chat-btn');
const preferencesDialog = document.getElementById('preferences-dialog');
const preferencesForm = document.getElementById('preferences-form');
const welcomeMarkup = messagesEl.innerHTML;

marked.setOptions({ breaks: true, gfm: true });

document.addEventListener('DOMContentLoaded', () => {
    messageInput.addEventListener('keydown', handleKeyDown);
    messageInput.addEventListener('input', autoResize);
    sendBtn.addEventListener('click', sendMessage);
    newChatBtn?.addEventListener('click', startNewChat);
    bindSidebar();
    bindPreferenceDialog();
    bindWelcomeCards();
    renderPreferences();
    renderHistory();
    loadStatus();
});

function bindSidebar() {
    const isMobile = () => window.innerWidth <= 768;
    const sync = () => {
        sidebarToggle.style.display = isMobile() ? (sidebar.classList.contains('open') ? '' : 'none') : (sidebar.classList.contains('collapsed') ? 'none' : '');
        sidebarToggleMobile.style.display = isMobile() || sidebar.classList.contains('collapsed') ? 'flex' : 'none';
    };
    const close = () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('show'); sync(); };
    sidebarToggle.addEventListener('click', () => isMobile() ? close() : (sidebar.classList.add('collapsed'), sync()));
    sidebarToggleMobile.addEventListener('click', () => {
        if (isMobile()) { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('show'); }
        else sidebar.classList.remove('collapsed');
        sync();
    });
    sidebarOverlay.addEventListener('click', close);
    window.addEventListener('resize', sync);
    sync();
}

function bindPreferenceDialog() {
    document.getElementById('edit-preferences-btn').addEventListener('click', () => {
        for (const [key, value] of Object.entries(state.preferences)) {
            const field = preferencesForm.elements.namedItem(key);
            if (field) field.value = value;
        }
        preferencesDialog.showModal();
    });
    document.getElementById('close-preferences-btn').addEventListener('click', () => preferencesDialog.close());
    preferencesForm.addEventListener('submit', event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(preferencesForm));
        state.preferences = Object.fromEntries(Object.entries(values).filter(([, value]) => String(value).trim()));
        localStorage.setItem(STORAGE.preferences, JSON.stringify(state.preferences));
        renderPreferences();
        preferencesDialog.close();
    });
    document.getElementById('clear-history-btn').addEventListener('click', () => {
        state.conversations = [];
        state.activeConversationId = null;
        state.history = [];
        localStorage.removeItem(STORAGE.conversations);
        localStorage.removeItem(STORAGE.legacyPlans);
        messagesEl.innerHTML = welcomeMarkup;
        bindWelcomeCards();
        renderHistory();
    });
    document.getElementById('clear-local-data-btn').addEventListener('click', () => {
        state.preferences = {};
        state.conversations = [];
        state.activeConversationId = null;
        state.history = [];
        localStorage.removeItem(STORAGE.preferences);
        localStorage.removeItem(STORAGE.conversations);
        localStorage.removeItem(STORAGE.legacyPlans);
        preferencesForm.reset();
        messagesEl.innerHTML = welcomeMarkup;
        bindWelcomeCards();
        renderPreferences();
        renderHistory();
        preferencesDialog.close();
    });
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || state.isLoading) return;
    state.isLoading = true;
    messageInput.value = '';
    autoResize();
    addMessage('user', text);
    showTypingIndicator();
    setInputDisabled(true);
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tripsage-workspace': state.workspaceToken },
            body: JSON.stringify({ message: text, history: state.history.slice(-8), preferences: state.preferences }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `服务器错误 (${response.status})`);
        hideTypingIndicator();
        let reply = data.reply || '已处理您的请求。';
        if (data.agents_called?.length) reply = `*调用: ${data.agents_called.join(', ')}*\n\n${reply}`;
        const messageNode = addMessage('assistant', reply);
        if (data.travel_query) renderTravelQueryCard(messageNode, data.travel_query);
        state.history.push({ role: 'user', content: text }, { role: 'assistant', content: data.reply || reply });
        state.history = state.history.slice(-8);
        saveConversationTurn(text, reply, data.reply || reply, data.travel_query);
    } catch (error) {
        hideTypingIndicator();
        addMessage('error', `处理失败：${error.message}`);
    } finally {
        state.isLoading = false;
        setInputDisabled(false);
        messageInput.focus();
    }
}

function addMessage(role, content) {
    messagesEl.querySelector('.welcome-screen')?.remove();
    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '我' : role === 'error' ? '!' : 'TS';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'assistant' || role === 'error') bubble.innerHTML = DOMPurify.sanitize(marked.parse(content));
    else bubble.textContent = content;
    wrapper.append(avatar, bubble);
    messagesEl.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}

function renderTravelQueryCard(messageNode, query) {
    const card = document.createElement('form');
    card.className = 'travel-query-card';
    const types = new Set(query.types || []);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    card.dataset.durationDays = String(Number(query.duration_days) || 0);
    card.innerHTML = `
        <div class="query-card-head"><div><strong>查询实时方案</strong><span>补全查询必需信息，不需要手机号或证件号</span></div><span class="supplier-badge">飞猪</span></div>
        <div class="query-grid">
            <label>出发地<input name="origin" maxlength="30" required value="${escapeAttr(query.origin || '')}" placeholder="上海"></label>
            <label>目的地<input name="destination" maxlength="30" required value="${escapeAttr(query.destination || '')}" placeholder="北京"></label>
            <label>出发日期<input type="date" name="departure_date" min="${today}" required value="${escapeAttr(query.departure_date || '')}"></label>
            <label>返程 / 退房日期<input type="date" name="return_date" min="${today}" value="${escapeAttr(query.return_date || '')}"></label>
            <label>出行人数<input type="number" name="adults" min="1" max="9" value="${Number(query.adults) || 1}"></label>
            <label>住宿区域（可选）<input name="area" maxlength="40" placeholder="例如：国贸" value=""></label>
        </div>
        <fieldset class="query-types"><legend>查询内容</legend>
            <label><input type="checkbox" name="types" value="flight" ${types.has('flight') ? 'checked' : ''}> 飞机</label>
            <label><input type="checkbox" name="types" value="train" ${types.has('train') ? 'checked' : ''}> 高铁 / 火车</label>
            <label><input type="checkbox" name="types" value="hotel" ${types.has('hotel') ? 'checked' : ''}> 酒店</label>
        </fieldset>
        <button class="query-submit" type="submit">${state.liveTravelConfigured === false ? '打开飞猪查询' : '查询实时价格'}</button>
        <div class="travel-results" aria-live="polite"></div>`;
    messageNode.querySelector('.bubble').appendChild(card);
    const dep = card.elements.departure_date;
    const back = card.elements.return_date;
    dep.addEventListener('change', () => {
        back.min = dep.value || today;
        if (back.value && back.value <= dep.value) back.value = '';
        const duration = Number(card.dataset.durationDays);
        if (!back.value && dep.value && duration > 1) {
            const end = new Date(`${dep.value}T00:00:00Z`);
            end.setUTCDate(end.getUTCDate() + duration - 1);
            back.value = end.toISOString().slice(0, 10);
        }
    });
    card.addEventListener('submit', event => runTravelSearch(event, card));
}

async function runTravelSearch(event, card) {
    event.preventDefault();
    const data = new FormData(card);
    const types = data.getAll('types');
    const resultsEl = card.querySelector('.travel-results');
    if (!types.length) { resultsEl.innerHTML = '<p class="query-error">请至少选择一种查询内容。</p>'; return; }
    if (state.liveTravelConfigured === false) {
        window.open('https://www.fliggy.com/', '_blank', 'noopener,noreferrer');
        resultsEl.innerHTML = '<p class="result-empty">实时查询尚未接入，已为你打开飞猪。</p>';
        return;
    }
    const button = card.querySelector('.query-submit');
    button.disabled = true;
    button.textContent = '正在查询…';
    resultsEl.innerHTML = '<div class="result-loading">正在连接飞猪查询，请稍候…</div>';
    const common = {
        origin: data.get('origin'), destination: data.get('destination'),
        departure_date: data.get('departure_date'), return_date: data.get('return_date'),
        adults: Number(data.get('adults')), area: data.get('area'),
    };
    const responses = await Promise.all(types.map(async type => {
        try {
            const response = await fetch('/api/travel/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...common, type }) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.detail || '查询失败');
            return { type, payload };
        } catch (error) { return { type, error: error.message }; }
    }));
    resultsEl.innerHTML = '';
    responses.forEach(item => renderResultGroup(resultsEl, item));
    button.disabled = false;
    button.textContent = '重新查询';
    scrollToBottom();
}

function renderResultGroup(container, item) {
    const names = { flight: '航班', train: '高铁 / 火车', hotel: '酒店' };
    const section = document.createElement('section');
    section.className = 'result-group';
    section.innerHTML = `<div class="result-group-head"><h4>${names[item.type]}</h4>${item.payload ? `<span>${formatObserved(item.payload.observed_at)} 查询</span>` : ''}</div>`;
    if (item.error) section.insertAdjacentHTML('beforeend', `<p class="query-error">${escapeHtml(item.error)} <a href="https://www.fliggy.com/" target="_blank" rel="noopener noreferrer">打开飞猪</a></p>`);
    else if (!item.payload.results?.length) section.insertAdjacentHTML('beforeend', '<p class="result-empty">本次没有返回可展示方案，可调整日期后重试。</p>');
    else {
        const list = document.createElement('div');
        list.className = 'result-list';
        item.payload.results.forEach(result => list.appendChild(item.type === 'hotel' ? hotelResult(result) : transportResult(result)));
        section.appendChild(list);
        section.insertAdjacentHTML('beforeend', `<p class="supplier-note">${escapeHtml(item.payload.note)}</p>`);
    }
    container.appendChild(section);
}

function transportResult(result) {
    const node = document.createElement('article');
    node.className = 'result-card';
    const dep = splitDateTime(result.departure_time);
    const arr = splitDateTime(result.arrival_time);
    node.innerHTML = `<div class="result-main"><div class="result-title"><strong>${escapeHtml([result.name, result.number].filter(Boolean).join(' '))}</strong><span>${escapeHtml(result.seat || result.route_type)}</span></div><div class="time-row"><div><strong>${dep.time}</strong><span>${escapeHtml(result.departure_station)}</span></div><i></i><div><strong>${arr.time}</strong><span>${escapeHtml(result.arrival_station)}</span></div></div><p class="result-meta">${escapeHtml([dep.date, result.duration, result.route_type].filter(Boolean).join(' · '))}</p></div><div class="result-action"><strong>${escapeHtml(result.price || '以页面为准')}</strong>${result.jump_url ? `<a href="${escapeAttr(result.jump_url)}" target="_blank" rel="noopener noreferrer">去飞猪查看</a>` : ''}</div>`;
    return node;
}

function hotelResult(result) {
    const node = document.createElement('article');
    node.className = 'result-card hotel-result';
    node.innerHTML = `<div class="result-main"><div class="result-title"><strong>${escapeHtml(result.name)}</strong><span>${escapeHtml([result.star, result.score ? `${result.score}分` : ''].filter(Boolean).join(' · '))}</span></div><p class="hotel-address">${escapeHtml([result.address, result.nearby].filter(Boolean).join(' · '))}</p></div><div class="result-action"><strong>${escapeHtml(result.price || '以页面为准')}</strong>${result.jump_url ? `<a href="${escapeAttr(result.jump_url)}" target="_blank" rel="noopener noreferrer">查看房型</a>` : ''}</div>`;
    return node;
}

function saveConversationTurn(prompt, displayReply, modelReply, query) {
    const now = Date.now();
    let conversation = state.conversations.find(item => item.id === state.activeConversationId);
    if (!conversation) {
        conversation = {
            id: createLocalId(),
            title: query ? ([query.origin, query.destination].filter(Boolean).join(' → ') || prompt) : prompt,
            updated_at: now,
            departure_date: query?.departure_date || '',
            messages: [],
        };
        state.activeConversationId = conversation.id;
        state.conversations.unshift(conversation);
    }
    conversation.messages.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: displayReply, model_content: modelReply, travel_query: query || null },
    );
    conversation.messages = conversation.messages.slice(-60);
    conversation.updated_at = now;
    if (query?.departure_date) conversation.departure_date = query.departure_date;
    state.conversations = [conversation, ...state.conversations.filter(item => item.id !== conversation.id)].slice(0, 20);
    persistConversations();
    renderHistory();
}

function persistConversations() {
    let retained = state.conversations.slice(0, 20);
    while (retained.length) {
        try {
            localStorage.setItem(STORAGE.conversations, JSON.stringify(retained));
            localStorage.removeItem(STORAGE.legacyPlans);
            state.conversations = retained;
            return;
        } catch {
            if (retained.length === 1) return;
            retained = retained.slice(0, -1);
        }
    }
}

function renderPreferences() {
    const names = { home_location: '常驻地', transportation_preference: '交通', seat_preference: '座席 / 舱位', hotel_preference: '住宿', budget_level: '预算' };
    const rows = Object.entries(state.preferences).filter(([, value]) => value).map(([key, value]) => `<div class="preference-item"><span class="pref-key">${names[key] || key}</span><span class="pref-value">${escapeHtml(value)}</span></div>`).join('');
    prefsEl.innerHTML = rows || '<p class="empty-state">尚未设置，仅在需要时填写即可</p>';
}

function renderHistory() {
    historyEl.innerHTML = state.conversations.length ? state.conversations.map(conversation => {
        const active = conversation.id === state.activeConversationId;
        const meta = conversation.departure_date || new Date(conversation.updated_at).toLocaleDateString('zh-CN');
        return `<button class="trip-item${active ? ' active' : ''}" data-conversation-id="${escapeAttr(conversation.id)}"${active ? ' aria-current="true"' : ''}><span class="trip-route">${escapeHtml(conversation.title || '差旅对话')}</span><span class="trip-meta">${escapeHtml(meta)} · ${Math.ceil(conversation.messages.length / 2)} 轮</span></button>`;
    }).join('') : '<p class="empty-state">暂无会话记录</p>';
    historyEl.querySelectorAll('[data-conversation-id]').forEach(button => button.addEventListener('click', () => {
        openConversation(button.dataset.conversationId);
    }));
}

function openConversation(id) {
    if (state.isLoading) return;
    const conversation = state.conversations.find(item => item.id === id);
    if (!conversation) return;
    state.activeConversationId = conversation.id;
    state.history = conversation.messages.map(message => ({
        role: message.role,
        content: message.model_content || message.content,
    })).slice(-8);
    messagesEl.innerHTML = '';
    conversation.messages.forEach(message => {
        const node = addMessage(message.role, message.content);
        if (message.role === 'assistant' && message.travel_query) renderTravelQueryCard(node, message.travel_query);
    });
    messageInput.value = '';
    autoResize();
    renderHistory();
    messageInput.focus();
}

async function loadStatus() {
    try {
        const response = await fetch('/api/suppliers/status');
        const suppliers = await response.json();
        const live = suppliers.flights?.mode === 'live-search' && suppliers.hotels?.mode === 'live-search';
        state.liveTravelConfigured = live;
        if (!live) document.querySelectorAll('.query-submit').forEach(button => { button.textContent = '打开飞猪查询'; });
        const knowledge = suppliers.knowledge?.configured;
        statusEl.innerHTML = `<div class="status-item"><span class="stat-label">规划服务</span><span class="stat-value green">在线</span></div><div class="status-item"><span class="stat-label">实时天气</span><span class="stat-value green">已接入</span></div><div class="status-item"><span class="stat-label">差旅知识库</span><span class="stat-value ${knowledge ? 'green' : 'yellow'}">${knowledge ? '已接入' : '待配置'}</span></div><div class="status-item"><span class="stat-label">机酒高铁</span><span class="stat-value ${live ? 'green' : 'yellow'}">${live ? '已接入' : '仅跳转'}</span></div>`;
        updateConnectionStatus(true);
    } catch { updateConnectionStatus(false); }
}

function showTypingIndicator() {
    const node = document.createElement('div');
    node.className = 'message assistant'; node.id = 'typing-indicator';
    node.innerHTML = '<div class="avatar">TS</div><div class="bubble typing-indicator"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(node); scrollToBottom();
}
function hideTypingIndicator() { document.getElementById('typing-indicator')?.remove(); }
function handleKeyDown(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }
function autoResize() { messageInput.style.height = 'auto'; messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`; }
function scrollToBottom() { messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' }); }
function setInputDisabled(disabled) { messageInput.disabled = disabled; sendBtn.disabled = disabled; }
function bindWelcomeCards() { document.querySelectorAll('.welcome-card').forEach(card => card.addEventListener('click', () => { messageInput.value = card.dataset.example || ''; messageInput.focus(); autoResize(); })); }
function startNewChat() { if (state.isLoading) return; state.activeConversationId = null; state.history = []; messagesEl.innerHTML = welcomeMarkup; messageInput.value = ''; autoResize(); bindWelcomeCards(); renderHistory(); messageInput.focus(); }
function updateConnectionStatus(online) { connectionStatus.className = online ? 'header-indicator' : 'header-indicator offline'; connectionStatus.querySelector('.indicator-text').textContent = online ? '在线' : '离线'; }
function splitDateTime(value) { const [date = '', time = ''] = String(value || '').split(' '); return { date, time: time.slice(0, 5) || '--:--' }; }
function formatObserved(value) { try { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
