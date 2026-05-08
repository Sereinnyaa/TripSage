/**
 * TripSage 差旅出行助手 - 前端逻辑
 */

// ── State ────────────────────────────────────────────
const state = {
    userId: 'web_user',
    isLoading: false,
};

// ── DOM refs ─────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const connectionStatus = document.getElementById('connection-status');
const prefsEl = document.getElementById('sidebar-preferences');
const historyEl = document.getElementById('sidebar-history');
const statusEl = document.getElementById('sidebar-status');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarToggleMobile = document.getElementById('sidebar-toggle-mobile');

// ── Marked config ────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    messageInput.addEventListener('keydown', handleKeyDown);
    messageInput.addEventListener('input', autoResize);
    sendBtn.addEventListener('click', () => sendMessage());

    // Sidebar toggle
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.add('collapsed');
        });
    }
    if (sidebarToggleMobile) {
        sidebarToggleMobile.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
    }

    // Click welcome cards to auto-fill input
    document.querySelectorAll('.welcome-card').forEach(card => {
        card.addEventListener('click', () => {
            const example = card.dataset.example;
            if (example) {
                messageInput.value = example;
                messageInput.focus();
                autoResize();
            }
        });
    });

    loadSidebar();
    setInterval(loadSidebar, 30000);
});

// ── Message sending ──────────────────────────────────
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || state.isLoading) return;

    state.isLoading = true;
    messageInput.value = '';
    autoResize();

    addMessage('user', escapeHtml(text));
    showTypingIndicator();
    disableInput(true);
    sendBtn.disabled = true;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, user_id: state.userId }),
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `服务器错误 (${res.status})`);
        }

        const data = await res.json();
        hideTypingIndicator();

        let reply = data.reply || '已处理您的请求。';
        if (data.agents_called && data.agents_called.length > 0) {
            reply = `*调用: ${data.agents_called.join(', ')}*\n\n` + reply;
        }
        addMessage('assistant', reply);
        loadSidebar();

    } catch (err) {
        hideTypingIndicator();
        addMessage('error', `处理失败: ${escapeHtml(err.message)}`);
    } finally {
        state.isLoading = false;
        disableInput(false);
        sendBtn.disabled = false;
        messageInput.focus();
    }
}

// ── Message rendering ────────────────────────────────
function addMessage(role, content) {
    // Remove welcome screen
    const welcome = messagesEl.querySelector('.welcome-screen');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (role === 'user') avatar.textContent = '我';
    else if (role === 'error') avatar.textContent = '!';
    else avatar.textContent = 'TS';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'assistant' || role === 'error') {
        bubble.innerHTML = marked.parse(content);
    } else {
        bubble.textContent = content;
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);

    scrollToBottom();
}

function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.id = 'typing-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'TS';

    const bubble = document.createElement('div');
    bubble.className = 'bubble typing-indicator';
    bubble.innerHTML = '<span></span><span></span><span></span>';

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();
}

function hideTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

// ── Sidebar ──────────────────────────────────────────
async function loadSidebar() {
    try {
        const [statusRes, prefsRes, historyRes] = await Promise.all([
            fetch('/api/status'),
            fetch('/api/preferences'),
            fetch('/api/history'),
        ]);

        if (statusRes.ok) renderStatus(await statusRes.json());
        if (prefsRes.ok) renderPreferences(await prefsRes.json());
        if (historyRes.ok) renderHistory(await historyRes.json());

        updateConnectionStatus(true);
    } catch {
        updateConnectionStatus(false);
    }
}

function renderStatus(data) {
    const st = data.short_term_memory || {};
    const lt = data.long_term_memory || {};
    const cb = data.circuit_breaker || {};

    let cbClass = 'green';
    if (cb.state === 'open') cbClass = 'red';
    else if (cb.state === 'half_open') cbClass = 'yellow';

    statusEl.innerHTML = `
        <div class="status-item"><span class="stat-label">LLM 服务</span><span class="stat-value green">正常</span></div>
        <div class="status-item"><span class="stat-label">熔断器</span><span class="stat-value ${cbClass}">${cb.state || 'closed'}</span></div>
        <div class="status-item"><span class="stat-label">短期记忆</span><span class="stat-value">${st.total_messages || 0} 条</span></div>
        <div class="status-item"><span class="stat-label">长期行程</span><span class="stat-value">${lt.total_trips || 0} 次</span></div>
        <div class="status-item"><span class="stat-label">已加载智能体</span><span class="stat-value">${(data.loaded_agents || []).length} 个</span></div>
        <div class="status-item"><span class="stat-label">会话</span><span class="stat-value">${data.session_id || '-'}</span></div>
    `;

    // Update session badge in sidebar footer
    const badge = document.querySelector('.session-badge');
    if (badge) badge.textContent = `会话: ${data.session_id || '--'}`;
}

function renderPreferences(data) {
    const prefs = data.preferences || {};
    const names = {
        home_location: '常驻地',
        transportation_preference: '交通偏好',
        hotel_brands: '酒店偏好',
        airlines: '航空公司偏好',
        seat_preference: '座位偏好',
        meal_preference: '餐食偏好',
        budget_level: '预算等级',
    };

    let html = '';
    for (const [key, value] of Object.entries(prefs)) {
        if (!value) continue;
        const displayKey = names[key] || key;
        const displayVal = Array.isArray(value) ? value.join(', ') : String(value);
        html += `<div class="preference-item">
            <span class="pref-key">${escapeHtml(displayKey)}</span>
            <span class="pref-value">${escapeHtml(displayVal)}</span>
        </div>`;
    }
    prefsEl.innerHTML = html || '<p class="empty-state">暂无偏好设置</p>';
}

function renderHistory(data) {
    const trips = data.trips || [];
    if (trips.length === 0) {
        historyEl.innerHTML = '<p class="empty-state">暂无历史行程</p>';
        return;
    }

    let html = '';
    for (const trip of trips.slice(0, 10)) {
        const origin = escapeHtml(trip.origin || '?');
        const dest = escapeHtml(trip.destination || '?');
        const date = escapeHtml(trip.start_date || '');
        const purpose = escapeHtml(trip.purpose || '');
        html += `<div class="trip-item">
            <div class="trip-route">${origin} → ${dest}</div>
            <div class="trip-meta">${date}  ${purpose}</div>
        </div>`;
    }
    historyEl.innerHTML = html;
}

// ── Helpers ──────────────────────────────────────────
function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

function autoResize() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

function disableInput(disabled) {
    messageInput.disabled = disabled;
}

function updateConnectionStatus(online) {
    if (online) {
        connectionStatus.className = 'header-indicator';
        connectionStatus.querySelector('.indicator-text').textContent = '在线';
        connectionStatus.title = '系统正常';
    } else {
        connectionStatus.className = 'header-indicator offline';
        connectionStatus.querySelector('.indicator-text').textContent = '离线';
        connectionStatus.title = '连接断开';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
