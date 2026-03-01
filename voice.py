import os
from dotenv import load_dotenv
load_dotenv()
import json
import base64

import httpx
from mistralai import Mistral

mistral_client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

ELEVENLABS_KEY  = os.environ.get("ELEVENLABS_API_KEY", "")
VOICE_ID        = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Rachel
CHAT_MODEL      = "ministral-8b-latest"

COACH_SYSTEM = """You are an upbeat, focused ADHD coach helping someone work through a session.
Keep every response to 2-3 short sentences. Be warm and direct — no bullet lists, no fluff.
Speak naturally as if you are in a voice conversation. Never use markdown, asterisks, or special characters.
When the user tells you their goals for the session: acknowledge with energy, say their timer is starting now, then give ONE brief concrete tip on exactly how to begin immediately. Do not ask any follow-up questions."""


def generate_greeting(block: dict) -> str:
    prompt = (
        f"The user is about to start this block: '{block.get('title')}' "
        f"({block.get('type')}, {block.get('start')}–{block.get('end')}). "
        "Greet them briefly and ask what specific goal(s) they want to hit this session. never use markdown formatting, asterisks, or special characters in your responses."
    )
    resp = mistral_client.chat.complete(
        model=CHAT_MODEL,
        messages=[
            {"role": "system",  "content": COACH_SYSTEM},
            {"role": "user",    "content": prompt},
        ],
        temperature=0.7,
    )
    return resp.choices[0].message.content.strip()


def chat_respond(conversation: list[dict], user_text: str, block: dict) -> str:
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    messages.append({"role": "user", "content": user_text})
    resp = mistral_client.chat.complete(
        model=CHAT_MODEL,
        messages=messages,
        temperature=0.7,
    )
    return resp.choices[0].message.content.strip()


def summarize_session(conversation: list[dict], block: dict) -> dict:
    conv_text = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in conversation)
    prompt = (
        f"This is a voice conversation about a work session for: \"{block.get('title')}\".\n\n"
        f"Conversation:\n{conv_text}\n\n"
        "Extract:\n"
        "1. Goals stated as completed or achieved\n"
        "2. Goals missed or not done\n"
        "3. A one-sentence note about the session\n\n"
        'Return JSON only: {"goals_done": [...], "goals_missed": [...], "notes": "..."}'
    )
    resp = mistral_client.chat.complete(
        model=CHAT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.2,
    )
    raw = resp.choices[0].message.content.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"goals_done": [], "goals_missed": [], "notes": raw[:200]}


def generate_session_end(block: dict, conversation: list[dict], time_spent_minutes: int | None = None) -> str:
    """Coach speaks at the end of the timer — asks how it went and suggests a break."""
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    time_info = f" They spent {time_spent_minutes} minute{'s' if time_spent_minutes != 1 else ''} on this." if time_spent_minutes is not None else ""
    messages.append({
        "role": "user",
        "content": (
            f"[The timer just ended for '{block.get('title')}' ({block.get('start')}–{block.get('end')}).{time_info}] "
            "Check in warmly. Acknowledge how long they spent if known, appreciate the effort, ask what they accomplished, "
            "and gently suggest a short break before the next block."
        ),
    })
    resp = mistral_client.chat.complete(model=CHAT_MODEL, messages=messages, temperature=0.7)
    return resp.choices[0].message.content.strip()


def generate_initiation(block: dict) -> dict:
    """Returns spoken encouragement and a display-only step breakdown for task initiation."""
    prompt = (
        f"The user is struggling to start: '{block.get('title')}' "
        f"({block.get('start')}–{block.get('end')}). "
        "Return JSON with exactly two fields: "
        '"text": a 2-sentence spoken message — tell them to commit to just 2 minutes, the bar is on the floor. '
        '"breakdown": a list of 2-4 ultra-small concrete first actions specific to this task, each under 10 words. '
        'Example: {"text": "Just 2 minutes...", "breakdown": ["Open the document", "Write one sentence"]}'
    )
    resp = mistral_client.chat.complete(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": COACH_SYSTEM},
            {"role": "user",   "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
    )
    raw = resp.choices[0].message.content.strip()
    try:
        data = json.loads(raw)
        return {
            "text":      data.get("text", "Just 2 minutes — the bar is on the floor. You can do this."),
            "breakdown": data.get("breakdown", []),
        }
    except json.JSONDecodeError:
        return {"text": raw[:200], "breakdown": []}


def generate_wrapup_prompt(block: dict, conversation: list[dict], time_spent_minutes: int | None = None) -> str:
    """Spoken prompt when user manually triggers wrap-up — asks what they accomplished."""
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    time_info = f" They worked for {time_spent_minutes} minute{'s' if time_spent_minutes != 1 else ''}." if time_spent_minutes is not None else ""
    messages.append({
        "role": "user",
        "content": (
            f"[The user chose to end their session on '{block.get('title')}' ({block.get('start')}–{block.get('end')}).{time_info}] "
            "Acknowledge that they're wrapping up, then ask briefly what they accomplished this session. "
            "Keep it to 2 sentences. Don't ask about energy or load."
        ),
    })
    resp = mistral_client.chat.complete(model=CHAT_MODEL, messages=messages, temperature=0.7)
    return resp.choices[0].message.content.strip()


def generate_day_summary(completed_blocks: list[dict]) -> str:
    """Short AI-generated summary of what's been done today."""
    if not completed_blocks:
        return "Nothing completed yet — the day is still ahead of you!"
    blocks_text = "\n".join(
        f"- {b.get('title', '?')} ({b.get('start', '?')}–{b.get('end', '?')})"
        for b in completed_blocks
    )
    prompt = (
        f"The user completed these time blocks today:\n{blocks_text}\n\n"
        "Write a short, warm 2-3 sentence summary of their progress. Be specific and encouraging. "
        "No bullet points — just plain conversational text."
    )
    resp = mistral_client.chat.complete(
        model=CHAT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
    )
    return resp.choices[0].message.content.strip()


def generate_initiation_end(block: dict, conversation: list[dict]) -> str:
    """Checks in after the 2-minute initiation timer — asks warmly about continuing."""
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    messages.append({
        "role": "user",
        "content": (
            f"[The 2-minute starter timer just finished for '{block.get('title')}'. "
            "The user just got going on the task.] "
            "Acknowledge the momentum they built in 2 sentences, "
            "then ask if they want to keep going with the full session."
        ),
    })
    resp = mistral_client.chat.complete(model=CHAT_MODEL, messages=messages, temperature=0.7)
    return resp.choices[0].message.content.strip()


def text_to_speech(text: str) -> str:
    """Returns base64-encoded MP3. Returns '' if ELEVENLABS_API_KEY is not set."""
    if not ELEVENLABS_KEY:
        return ""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    r = httpx.post(
        url,
        headers={"xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.75},
        },
        timeout=20.0,
    )
    r.raise_for_status()
    return base64.b64encode(r.content).decode()
