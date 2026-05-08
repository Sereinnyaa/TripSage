"""
TripSage差旅出行助手 - Web API

FastAPI 应用，提供 REST API 和聊天界面。
"""
import asyncio
import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.requests import Request

from config_agentscope import init_agentscope
from config import LLM_CONFIG, SYSTEM_CONFIG, RESILIENCE_CONFIG
from agentscope.model import OpenAIChatModel
from context.memory_manager import MemoryManager
from agents.intention_agent import IntentionAgent
from agents.lazy_agent_registry import LazyAgentRegistry
from agents.orchestration_agent import OrchestrationAgent
from utils.circuit_breaker import CircuitBreaker, CircuitOpenError
from utils.llm_resilience import retry_with_backoff
from web.response_formatter import format_result_to_markdown

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger("tripsage.web")


# ── Pydantic models ──────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    user_id: str = "web_user"


class PreferenceRequest(BaseModel):
    type: str
    value: str
    user_id: str = "web_user"


# ── App singleton ────────────────────────────────────────────

class TripSageWebApp:
    """管理 Agent 系统生命周期，支持多用户记忆隔离"""

    def __init__(self):
        self.session_id = None
        self.model = None
        self.intention_agent = None
        self.circuit_breaker = None
        self._initialized = False
        self._lock = asyncio.Lock()

        # 共享资源（仅初始化一次）
        # 每个 user_id 独立的状态
        self._user_states = {}       # user_id -> {memory_manager, agent_cache, orchestrator, lock}

    async def initialize(self):
        if self._initialized:
            return
        self.session_id = str(uuid.uuid4())[:8]
        init_agentscope()

        self.model = OpenAIChatModel(
            model_name=LLM_CONFIG["model_name"],
            api_key=LLM_CONFIG["api_key"],
            client_kwargs={
                "base_url": LLM_CONFIG["base_url"],
                "timeout": float(SYSTEM_CONFIG.get("timeout", 60)),
            },
            temperature=LLM_CONFIG.get("temperature", 0.7),
            max_tokens=LLM_CONFIG.get("max_tokens", 8192),
        )

        self.intention_agent = IntentionAgent(
            name="IntentionAgent",
            model=self.model,
        )

        rc = RESILIENCE_CONFIG
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=rc.get("circuit_failure_threshold", 5),
            recovery_timeout_sec=rc.get("circuit_recovery_timeout_sec", 60.0),
            half_open_successes=rc.get("circuit_half_open_successes", 2),
        )

        self._initialized = True
        logger.info(f"TripSageWebApp initialized (session: {self.session_id})")

    def _get_user_state(self, user_id: str) -> dict:
        """获取或创建用户专属状态（记忆管理器、智能体缓存、编排器）"""
        if user_id not in self._user_states:
            mm = MemoryManager(
                user_id=user_id,
                session_id=self.session_id,
                llm_model=self.model,
            )
            cache = {}
            lazy = LazyAgentRegistry(
                model=self.model,
                cache=cache,
                memory_manager=mm,
            )
            orch = OrchestrationAgent(
                name="OrchestrationAgent",
                agent_registry=lazy,
                memory_manager=mm,
            )
            self._user_states[user_id] = {
                "memory_manager": mm,
                "agent_cache": cache,
                "orchestrator": orch,
                "lock": asyncio.Lock(),
            }
            logger.info(f"Created user state for: {user_id}")
        return self._user_states[user_id]

    async def process_message(self, user_id: str, message: str) -> dict:
        """处理用户消息，返回格式化结果"""
        us = self._get_user_state(user_id)
        mm = us["memory_manager"]
        orch = us["orchestrator"]

        async with us["lock"]:
            from agentscope.message import Msg

            rc = RESILIENCE_CONFIG
            max_retries = rc.get("max_retries", 3)

            # 1. 熔断检查
            self.circuit_breaker.raise_if_open()

            # 2. 长期记忆摘要 + 短期上下文
            long_term_summary = await self._get_long_term_summary(mm, message)
            recent_context = mm.short_term.get_recent_context(n_turns=5)

            context_messages = []
            if long_term_summary:
                context_messages.append(Msg(name="system", content=long_term_summary, role="system"))
            for msg in recent_context:
                context_messages.append(Msg(name=msg["role"], content=msg["content"], role=msg["role"]))
            context_messages.append(Msg(name="user", content=message, role="user"))

            # 3. 意图识别
            try:
                intention_result = await retry_with_backoff(
                    lambda: self.intention_agent.reply(context_messages),
                    max_retries=max_retries,
                    base_delay_sec=rc.get("retry_base_delay_sec", 1.0),
                    max_delay_sec=rc.get("retry_max_delay_sec", 30.0),
                )
                self.circuit_breaker.record_success()
            except CircuitOpenError:
                raise
            except Exception as e:
                self.circuit_breaker.record_failure()
                return self._error_response(f"意图识别失败: {e}")

            try:
                intention_data = json.loads(intention_result.content)
            except json.JSONDecodeError:
                return self._error_response("无法理解您的需求，请重新描述")

            # 4. 保存用户消息到记忆
            mm.add_message("user", message)

            # 5. 编排调度
            try:
                orchestration_result = await retry_with_backoff(
                    lambda: orch.reply(intention_result),
                    max_retries=max_retries,
                    base_delay_sec=rc.get("retry_base_delay_sec", 1.0),
                    max_delay_sec=rc.get("retry_max_delay_sec", 30.0),
                )
                self.circuit_breaker.record_success()
            except CircuitOpenError:
                raise
            except Exception as e:
                self.circuit_breaker.record_failure()
                return self._error_response(f"处理请求失败: {e}")

            try:
                result_data = json.loads(orchestration_result.content)
            except json.JSONDecodeError:
                result_data = {"error": "解析结果失败", "results": []}

            # 6. 保存助手响应到记忆
            mm.add_message("assistant", json.dumps(result_data, ensure_ascii=False))

            # 7. 格式化结果
            markdown, agents_called = format_result_to_markdown(result_data)

            if not markdown:
                markdown = "已处理您的请求。如需查看详情，请检查侧边栏中的偏好或行程历史。"

            return {
                "reply": markdown,
                "agents_called": agents_called,
                "status": result_data.get("status", "success"),
                "data": self._extract_sidebar_data(result_data),
            }

    async def _get_long_term_summary(self, mm: MemoryManager, user_input: str = "") -> str:
        """生成长期记忆摘要"""
        summary_parts = []

        prefs = mm.long_term.get_preference()
        if prefs:
            pref_lines = ["【用户背景信息】（来自长期记忆）"]
            for pref_key, pref_value in prefs.items():
                if pref_value:
                    if isinstance(pref_value, list):
                        pref_lines.append(f"  - {pref_key}: {', '.join(pref_value)}")
                    else:
                        pref_lines.append(f"  - {pref_key}: {pref_value}")
            if len(pref_lines) > 1:
                summary_parts.extend(pref_lines)

        try:
            chat_summary = await mm.get_long_term_summary_async(max_messages=50)
            if chat_summary:
                summary_parts.append("\n【历史会话总结】")
                summary_parts.append(chat_summary)
        except Exception as e:
            logger.warning(f"Failed to generate chat summary: {e}")

        all_trips = mm.long_term.get_trip_history(limit=None)
        if all_trips:
            relevant_trips = []
            other_trips = []
            for trip in all_trips:
                origin = trip.get("origin", "") or ""
                destination = trip.get("destination", "") or ""
                if (origin and origin in user_input) or (destination and destination in user_input):
                    relevant_trips.append(trip)
                else:
                    other_trips.append(trip)
            trips_to_show = relevant_trips[:2] + other_trips[:1]
            if trips_to_show:
                summary_parts.append("\n【历史行程】")
                for i, trip in enumerate(trips_to_show[:3], 1):
                    origin = trip.get("origin", "未知")
                    destination = trip.get("destination", "未知")
                    start_date = trip.get("start_date", "")
                    purpose = trip.get("purpose", "")
                    relevance_mark = ">> " if trip in relevant_trips else ""
                    summary_parts.append(
                        f"{i}. {relevance_mark}{origin} -> {destination} ({start_date}) - {purpose}"
                    )

        return "\n".join(summary_parts) if summary_parts else ""

    def _extract_sidebar_data(self, result_data: dict) -> dict:
        sidebar = {}
        for r in result_data.get("results", []):
            agent_name = r.get("agent_name", "")
            data = r.get("data", {}) if isinstance(r.get("data"), dict) else {}

            if agent_name == "preference":
                prefs = data.get("preferences", {})
                if isinstance(prefs, dict):
                    sidebar["updated_preferences"] = prefs.get("preferences", [])

            if agent_name == "itinerary_planning":
                itinerary = data.get("itinerary") or data.get("data", {}).get("itinerary")
                if itinerary:
                    sidebar["itinerary"] = itinerary

            if agent_name == "event_collection":
                sidebar["trip_info"] = {
                    "origin": data.get("origin") or data.get("data", {}).get("origin"),
                    "destination": data.get("destination") or data.get("data", {}).get("destination"),
                    "start_date": data.get("start_date") or data.get("data", {}).get("start_date"),
                    "end_date": data.get("end_date") or data.get("data", {}).get("end_date"),
                }

        return sidebar

    def _error_response(self, message: str) -> dict:
        return {
            "reply": f"**处理出错**: {message}",
            "agents_called": [],
            "status": "error",
            "data": {},
        }

    def get_status(self, user_id: str) -> dict:
        us = self._get_user_state(user_id)
        mm = us["memory_manager"]
        short_stats = mm.short_term.get_statistics()
        long_stats = mm.long_term.get_statistics()
        cb_status = self.circuit_breaker.get_status() if self.circuit_breaker else {}
        loaded = list(us["agent_cache"].keys())
        return {
            "short_term_memory": short_stats,
            "long_term_memory": long_stats,
            "loaded_agents": loaded,
            "circuit_breaker": cb_status,
            "user_id": user_id,
            "session_id": self.session_id,
        }

    def get_preferences(self, user_id: str) -> dict:
        us = self._get_user_state(user_id)
        return {"preferences": us["memory_manager"].long_term.get_preference()}

    def save_preference(self, user_id: str, pref_type: str, value: str) -> dict:
        us = self._get_user_state(user_id)
        us["memory_manager"].long_term.save_preference(pref_type, value)
        return {"status": "success", "message": f"已更新偏好: {pref_type}"}

    def get_history(self, user_id: str) -> dict:
        us = self._get_user_state(user_id)
        trips = us["memory_manager"].long_term.get_trip_history(limit=20)
        return {"trips": trips}

    def clear_memory(self, user_id: str) -> dict:
        us = self._get_user_state(user_id)
        us["memory_manager"].short_term.clear()
        return {"status": "success", "message": "短期记忆已清空"}


# ── FastAPI app ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.tripsage = TripSageWebApp()
    await app.state.tripsage.initialize()
    yield


app = FastAPI(title="TripSage差旅出行助手", lifespan=lifespan)

web_dir = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(web_dir, "static")), name="static")


def _tripsage(request: Request) -> TripSageWebApp:
    return request.app.state.tripsage


# ── Routes ───────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    index_path = os.path.join(web_dir, "templates", "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.post("/api/chat")
async def chat(request: Request, body: ChatRequest):
    ts = _tripsage(request)
    try:
        result = await ts.process_message(body.user_id, body.message)
        return result
    except CircuitOpenError:
        raise HTTPException(status_code=503, detail="服务暂时不可用，请稍后再试")
    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/status")
async def status(request: Request, user_id: str = Query("web_user")):
    return _tripsage(request).get_status(user_id)


@app.get("/api/history")
async def history(request: Request, user_id: str = Query("web_user")):
    return _tripsage(request).get_history(user_id)


@app.get("/api/preferences")
async def get_preferences(request: Request, user_id: str = Query("web_user")):
    return _tripsage(request).get_preferences(user_id)


@app.post("/api/preferences")
async def update_preferences(request: Request, body: PreferenceRequest):
    return _tripsage(request).save_preference(body.user_id, body.type, body.value)


@app.get("/api/health")
async def health(request: Request):
    ts = _tripsage(request)
    from utils.llm_resilience import run_health_check as check_llm_health
    ok, msg = await check_llm_health(
        base_url=LLM_CONFIG["base_url"],
        api_key=LLM_CONFIG["api_key"],
        model_name=LLM_CONFIG["model_name"],
        timeout_sec=RESILIENCE_CONFIG.get("health_check_timeout_sec", 10.0),
    )
    cb = ts.circuit_breaker.get_status() if ts.circuit_breaker else {}
    return {
        "status": "ok" if ok else "degraded",
        "llm": ok,
        "message": msg,
        "circuit_state": cb.get("state", "unknown"),
    }


@app.post("/api/clear")
async def clear_memory(request: Request, user_id: str = Query("web_user")):
    return _tripsage(request).clear_memory(user_id)
