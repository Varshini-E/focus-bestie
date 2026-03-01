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

COACH_SYSTEM = """You are a body doubling agent — a calm, warm, upbeat presence helping someone with ADHD work through a focused session.
Keep every response to 2-3 short sentences. Be warm, direct, and human — no bullet lists, no fluff.
Speak naturally as if you are in a voice conversation. Never use markdown, asterisks, or special characters.
Never use generic pep-talk phrases like "you've got this", "you can do it", "I believe in you", or "you're doing great" — they feel hollow. Be specific and grounded instead.
When the user tells you their goals at the start of a session: wish them luck and say their timer is starting. Two sentences only — no extra tips, no questions.
Mid-session when the user talks to you: be their body double — present, grounding. Acknowledge what they say, help them find one small next step if they're stuck, or briefly celebrate if they're making progress. Keep it short."""


def generate_greeting(block: dict) -> str:
    prompt = (
        f"The user is about to start this block: '{block.get('title')}' "
        f"({block.get('type')}, {block.get('start')}–{block.get('end')}). "
        "Greet them warmly in one sentence, then ask what specific goal(s) they want to accomplish this session in one sentence. "
        "Do NOT mention the timer at all. Never use markdown, asterisks, or special characters."
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


def chat_respond(
    conversation: list[dict],
    user_text: str,
    block: dict,
    is_session_end_reply: bool = False,
    is_goals_message: bool = False,
    is_mid_session: bool = False,
) -> str:
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    if is_session_end_reply:
        messages.append({
            "role": "user",
            "content": (
                f"{user_text}\n\n"
                "[The user just told you what they completed. Commend their effort warmly in one sentence, "
                "suggest a short break in one sentence, and tell them to click 'Complete & Replan Day' whenever they're ready.]"
            ),
        })
    elif is_goals_message:
        messages.append({
            "role": "user",
            "content": (
                f"{user_text}\n\n"
                "[The user just stated their goals for this session. Do NOT generate any content, examples, or suggestions related to the task. "
                "Simply wish them luck in one sentence, then say their timer is starting in one sentence. Nothing else.]"
            ),
        })
    elif is_mid_session:
        messages.append({
            "role": "user",
            "content": (
                f"{user_text}\n\n"
                f"[The user said this while working on '{block.get('title')}' with their timer running. "
                "Be their body double — present and grounding. If they sound anxious or stuck, acknowledge it warmly "
                "and help them see one tiny next step. If they're sharing progress, celebrate briefly. 2-3 sentences max.]"
            ),
        })
    else:
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
    """Coach asks what was completed when timer ends."""
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    time_info = f" They spent {time_spent_minutes} minute{'s' if time_spent_minutes != 1 else ''} on this." if time_spent_minutes is not None else ""
    messages.append({
        "role": "user",
        "content": (
            f"[The timer just ended for '{block.get('title')}' ({block.get('start')}–{block.get('end')}).{time_info}] "
            "Warmly acknowledge that the session is done — however it went is okay. "
            "Then gently ask what they managed to get done. 2 sentences, no pressure."
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
            "Warmly acknowledge that they chose to wrap up — no pressure, every bit counts. "
            "Then gently ask what they got done this session. 2 sentences, no judgment."
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
    """Celebrates after the 2-minute initiation timer — announces full session is resuming."""
    messages = [{"role": "system", "content": COACH_SYSTEM}]
    messages += conversation
    messages.append({
        "role": "user",
        "content": (
            f"[The 2-minute starter timer just finished for '{block.get('title')}'. "
            "The user got going on the task.] "
            "Celebrate their momentum in one short sentence. "
            "Then tell them their full session timer is resuming now — one sentence. "
            "Do NOT ask a question."
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
