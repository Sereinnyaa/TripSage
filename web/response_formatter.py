"""
TripSage Web - 结果格式化

将 OrchestrationAgent 返回的 JSON 结果转为 Markdown 字符串，
前端使用 marked.js 渲染。
"""


def format_result_to_markdown(result_data: dict) -> tuple[str, list[str]]:
    """
    将编排结果格式化为 Markdown 字符串。

    Returns:
        (markdown_text, agents_called_list)
    """
    results = result_data.get("results", [])
    agents_called = []
    md_parts = []

    for result in results:
        agent_name = result.get("agent_name", "")
        status = result.get("status", "")
        data = result.get("data", {})

        display_name = _agent_display_name(agent_name)
        if status == "success" or status == "no_knowledge":
            agents_called.append(f"{display_name} ✓")
        elif status == "error":
            agents_called.append(f"{display_name} ✗")

        if status == "error":
            error_msg = data.get("error", "未知错误") if isinstance(data, dict) else str(data)
            md_parts.append(f"**{display_name}** 执行失败: {error_msg}")
            continue

        if status != "success" and not (agent_name == "rag_knowledge" and status == "no_knowledge"):
            continue

        # --- 各 Agent 类型渲染 ---

        if agent_name == "itinerary_planning":
            itinerary = _deep_get(data, "itinerary")
            if not itinerary:
                continue
            title = itinerary.get("title", "行程规划")
            duration = itinerary.get("duration", "未知")
            md_parts.append(f"## {title}")
            md_parts.append(f"**时长**: {duration}")
            md_parts.append("")

            for day_plan in itinerary.get("daily_plans", []):
                day_num = day_plan.get("day", 1)
                md_parts.append(f"### 第 {day_num} 天")
                activities = day_plan.get("activities") or day_plan.get("time_slots") or []
                for slot in activities:
                    time = slot.get("time", "")
                    activity = slot.get("activity") or slot.get("location") or ""
                    description = slot.get("description", "")
                    transport = slot.get("transport", "")
                    line = f"- **{time}** {activity}"
                    if description:
                        line += f" — {description}"
                    if transport:
                        line += f"  ({transport})"
                    md_parts.append(line)

                meals = day_plan.get("meals", {})
                if meals:
                    md_parts.append("")
                    if meals.get("lunch"):
                        md_parts.append(f"> 午餐: {meals['lunch']}")
                    if meals.get("dinner"):
                        md_parts.append(f"> 晚餐: {meals['dinner']}")
                md_parts.append("")

            notes = itinerary.get("notes", [])
            if notes:
                md_parts.append("### 注意事项")
                for note in notes:
                    md_parts.append(f"- {note}")
                md_parts.append("")

        elif agent_name == "preference":
            raw_prefs = data.get("preferences")
            if not raw_prefs:
                raw_prefs = _deep_get(data, "preferences")
            if isinstance(raw_prefs, dict):
                prefs_list = raw_prefs.get("preferences", [])
            else:
                prefs_list = raw_prefs if isinstance(raw_prefs, list) else []

            if prefs_list:
                md_parts.append("### 已更新偏好设置")
                type_names = {
                    "home_location": "常驻地",
                    "transportation_preference": "交通偏好",
                    "hotel_brands": "酒店偏好",
                    "airlines": "航空公司偏好",
                    "seat_preference": "座位偏好",
                    "meal_preference": "餐食偏好",
                    "budget_level": "预算等级",
                }
                for pref in prefs_list:
                    pref_type = pref.get("type", "")
                    pref_value = pref.get("value", "")
                    action = pref.get("action", "replace")
                    display_type = type_names.get(pref_type, pref_type)
                    action_text = "追加" if action == "append" else "设置为"
                    md_parts.append(f"- {display_type} {action_text} **{pref_value}**")
                md_parts.append("")

        elif agent_name == "event_collection":
            origin = _deep_get(data, "origin")
            destination = _deep_get(data, "destination")
            start_date = _deep_get(data, "start_date")
            end_date = _deep_get(data, "end_date")
            missing_info = _deep_get(data, "missing_info") or []

            has_itinerary = any(r.get("agent_name") == "itinerary_planning" for r in results)
            if not has_itinerary and (destination or origin):
                md_parts.append("### 已收集行程信息")
                if origin:
                    md_parts.append(f"- 出发地: **{origin}**")
                if destination:
                    md_parts.append(f"- 目的地: **{destination}**")
                if start_date:
                    md_parts.append(f"- 出发日期: **{start_date}**")
                if end_date:
                    md_parts.append(f"- 返程日期: **{end_date}**")
                md_parts.append("")
            if missing_info:
                md_parts.append(f"> 还需要补充: {', '.join(missing_info)}")
                md_parts.append("")

        elif agent_name == "information_query":
            query_results = _deep_get(data, "results") or data
            if isinstance(query_results, dict):
                summary = query_results.get("summary", "")
                message = query_results.get("message", "")
                error = query_results.get("error", "")
                sources = query_results.get("sources", []) or []

                if summary:
                    md_parts.append(summary)
                    md_parts.append("")
                elif message:
                    md_parts.append(f"> {message}")
                    md_parts.append("")
                elif error:
                    md_parts.append(f"> {error}")
                    md_parts.append("")

                if sources:
                    md_parts.append("**参考来源**:")
                    for i, source in enumerate(sources[:3], 1):
                        url = source.get("url", "") if isinstance(source, dict) else str(source)
                        title = source.get("title", url) if isinstance(source, dict) else url
                        md_parts.append(f"{i}. [{title}]({url})")
                    md_parts.append("")

        elif agent_name == "rag_knowledge":
            answer = _deep_get(data, "answer") or _deep_get(data, "content")
            if isinstance(answer, dict):
                answer = answer.get("answer", str(answer))
            if isinstance(answer, str) and answer.strip().startswith("{") and answer.strip().endswith("}"):
                try:
                    import json
                    json_obj = json.loads(answer)
                    if isinstance(json_obj, dict) and "answer" in json_obj:
                        answer = json_obj["answer"]
                except Exception:
                    pass
            if answer:
                md_parts.append(str(answer))
                md_parts.append("")

        elif agent_name == "memory_query":
            query_result = _deep_get(data, "answer") or _deep_get(data, "result") or _deep_get(data, "content")
            if query_result:
                md_parts.append(str(query_result))
                md_parts.append("")

        else:
            # 通用兜底
            fallback = None
            for k in ["answer", "content", "result", "message", "summary", "text"]:
                val = _deep_get(data, k)
                if val and isinstance(val, str) and val.strip():
                    fallback = val
                    break
            if fallback:
                md_parts.append(fallback)
                md_parts.append("")

    markdown = "\n".join(md_parts).strip()
    return markdown, agents_called


def _deep_get(data: dict, key: str):
    """从 data or data.data 中获取值"""
    if not isinstance(data, dict):
        return None
    if key in data:
        return data[key]
    inner = data.get("data")
    if isinstance(inner, dict) and key in inner:
        return inner[key]
    return None


def _agent_display_name(agent_name: str) -> str:
    names = {
        "event_collection": "事项收集",
        "preference": "偏好管理",
        "itinerary_planning": "行程规划",
        "information_query": "信息查询",
        "rag_knowledge": "知识库查询",
        "memory_query": "记忆查询",
    }
    return names.get(agent_name, agent_name)
