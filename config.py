"""
Configuration for the TripSage Multi-Agent System
"""
import os

# LLM Configuration
LLM_CONFIG = {
    "api_key": os.environ.get("TRIPSAGE_API_KEY", "your-api-key-here"),
    "model_name": os.environ.get("TRIPSAGE_MODEL", "deepseek-v4-pro"),
    "base_url": os.environ.get("TRIPSAGE_BASE_URL", "https://api.deepseek.com/v1"),
    "temperature": 0.7,
    "max_tokens": 8192,
}

# System Configuration
SYSTEM_CONFIG = {
    "enable_llm": True,  # Set to True to use LLM (recommended), False for rule-based
    "log_level": "INFO",
    "max_retries": 3,
    "timeout": 60,  # Increased timeout for better stability
}

# RAG 知识库：嵌入模型（自动检测本地 or HuggingFace 下载）
RAG_CONFIG = {
    "embedding_model": os.environ.get("TRIPSAGE_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"),
}

# 连接与可用性：重试、熔断、健康检查
RESILIENCE_CONFIG = {
    "max_retries": 3,              # 单次请求最大重试次数（与 SYSTEM_CONFIG 对齐）
    "retry_base_delay_sec": 1.0,   # 重试退避基数（秒）
    "retry_max_delay_sec": 30.0,   # 重试退避上限（秒）
    "circuit_failure_threshold": 5, # 连续失败多少次后熔断
    "circuit_recovery_timeout_sec": 60.0,  # 熔断后多少秒进入半开
    "circuit_half_open_successes": 2,      # 半开状态下连续成功多少次后关闭
    "health_check_timeout_sec": 10.0,      # 健康检查请求超时（秒）
}
