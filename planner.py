import os
import json
import re
from datetime import datetime

from mistralai import Mistral

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
MODEL = "ministral-8b-latest"

# ── Tool definition ────────────────────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current local time as HH:MM. Call this to know what time it is right now.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    }
]


def _run_tool_phase(messages: list) -> list:
    """Run one tool-calling pass. If the model calls get_current_time, execute it
    and append the result. Returns the updated messages list."""
    resp = client.chat.complete(
        model=MODEL,
        messages=messages,
        tools=TOOLS,
        tool_choice="auto",
        temperature=0.2,
    )
    choice = resp.choices[0]
    if choice.finish_reason != "tool_calls":
        return messages  # no tool call

    tool_calls = choice.message.tool_calls or []
    messages = list(messages) + [
        {
            "role": "assistant",
            "content": choice.message.content or "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in tool_calls
            ],
        }
    ]
    for tc in tool_calls:
        result = (
            datetime.now().strftime("%H:%M")
            if tc.function.name == "get_current_time"
            else "unknown tool"
        )
        messages.append(
            {"role": "tool", "content": result, "tool_call_id": tc.id, "name": tc.function.name}
        )
    return messages


def _json_plan_phase(messages: list, temperature: float = 0.2) -> dict:
    """Phase 2: produce JSON from messages. Returns parsed dict."""
    response = client.chat.complete(
        model=MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        temperature=temperature,
    )
    raw = response.choices[0].message.content.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(f"Model did not return valid JSON:\n{raw}")


SYSTEM_PROMPT = """
You are a scheduling engine. Return strict JSON only — no markdown, no explanation.

Build a time-blocked day schedule from the tasks provided.

Rules:
- Respect day_start and day_end as the allowed window — tasks do NOT need to fill it entirely.
- Estimate realistic durations based on task complexity. Two simple tasks should NOT span 10 hours.
- First block must be a 5-minute "starter" on the first task to ease into it.
- Use Pomodoro-style blocks: 25 min work / 5 min break, 50 min / 10 min, or 75 min / 15 min — match complexity.
- Add short breaks between demanding tasks; add a meal block if the window spans a typical meal time.
- Do not schedule anything past day_end.
- "load" is an integer 1–5 (cognitive load). Use null for break and meal blocks.
- If all tasks can realistically be done in less time than the full window, end the schedule early — don't pad.

Return format:
{
  "day_start": "HH:MM",
  "day_end": "HH:MM",
  "blocks": [
    {
      "id": "unique-string",
      "type": "starter | task | break | meal",
      "start": "HH:MM",
      "end": "HH:MM",
      "title": "string",
      "load": 1-5 or null
    }
  ],
  "notes": ["string"]
}
"""


SALVAGE_SYSTEM_PROMPT = """
You are a minimal scheduling engine for someone who is overwhelmed. Return strict JSON only — no markdown, no explanation.

Pick exactly ONE task from the list — the most concrete and achievable — and schedule ONLY that.

Rules:
- Choose the simplest or most immediately doable task. Ignore all others.
- First block: 5-minute "starter" on that task.
- Second block: one 25-minute work session on the same task.
- Do NOT add more tasks, extra breaks, or padding.
- Do not schedule anything past day_end.
- "load" is an integer 1–5. Use null for break blocks.
- The notes field should explain which task was chosen and why.

Return format: same JSON structure as a normal plan.
"""


def generate_plan(tasks: list[str], day_start: str, day_end: str) -> dict:
    user_prompt = (
        f"Tasks:\n{chr(10).join(f'- {t}' for t in tasks)}\n\n"
        f"Day start: {day_start}\nDay end: {day_end}\n\n"
        "Call get_current_time first to get the current time for scheduling context."
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    messages = _run_tool_phase(messages)
    return _json_plan_phase(messages, temperature=0.2)


def generate_salvage_plan(tasks: list[str], day_start: str, day_end: str) -> dict:
    user_prompt = (
        f"Tasks to choose from:\n{chr(10).join(f'- {t}' for t in tasks)}\n\n"
        f"Day start: {day_start}\nDay end: {day_end}\n\n"
        "Pick just ONE task and schedule only that. Call get_current_time first."
    )
    messages = [
        {"role": "system", "content": SALVAGE_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    messages = _run_tool_phase(messages)
    return _json_plan_phase(messages, temperature=0.3)


REPLAN_SYSTEM_PROMPT = """
You are an adaptive scheduling engine for someone with ADHD. Return strict JSON only — no markdown, no explanation.

Reschedule the remaining day based on feedback from a just-completed time block and the previously planned blocks.

ADHD-aware rules:
- Energy 1-2: schedule easier/shorter tasks next, add an extra break immediately.
- Energy 4-5: can place a demanding task next.
- Cognitive load 4-5: person found the work mentally taxing — schedule lighter or shorter tasks next, add a break.
- Cognitive load 1-2: work felt easy — can handle a more demanding task next.
- If goals were missed: break that task into smaller chunks and reschedule.
- First block must start exactly at current_time.
- Do not schedule anything past day_end.
- "load" is an integer 1–5. Use null for break and meal blocks.

Return format:
{
  "day_start": "HH:MM",
  "day_end": "HH:MM",
  "blocks": [
    {
      "id": "unique-string",
      "type": "starter | task | break | meal",
      "start": "HH:MM",
      "end": "HH:MM",
      "title": "string",
      "load": 1-5 or null
    }
  ],
  "notes": ["string"]
}
"""


def replan_day(
    current_plan: dict,
    completed_block_id: str,
    goals_done: list[str],
    goals_missed: list[str],
    energy: int,
    cognitive_load: int | None,
    notes: str,
    current_time: str,
    time_spent_minutes: int | None = None,
) -> dict:
    remaining = [
        b for b in current_plan.get("blocks", [])
        if b["id"] != completed_block_id and b["start"] >= current_time
    ]

    load_line = f"- Cognitive load: {cognitive_load}/5\n" if cognitive_load else ""
    time_line = f"- Time spent on this block: {time_spent_minutes} minute(s)\n" if time_spent_minutes is not None else ""
    user_prompt = (
        f"A time block just ended. Reschedule the rest of the day.\n\n"
        f"Feedback:\n"
        f"- Goals achieved: {goals_done or 'none'}\n"
        f"- Goals missed: {goals_missed or 'none'}\n"
        f"- Energy level: {energy}/5\n"
        f"{load_line}"
        f"{time_line}"
        f"- Notes: \"{notes}\"\n"
        f"- Current time: {current_time}\n"
        f"- Day end: {current_plan.get('day_end')}\n\n"
        f"Remaining planned blocks (reschedule starting from {current_time}):\n"
        f"{json.dumps(remaining, indent=2)}\n\n"
        "Call get_current_time to confirm the exact current time before scheduling."
    )

    messages = [
        {"role": "system", "content": REPLAN_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    # Phase 1: let model call get_current_time
    messages = _run_tool_phase(messages)

    # Phase 2: produce the JSON replan
    return _json_plan_phase(messages, temperature=0.3)
