import os
import json
from pathlib import Path
from datetime import datetime
from typing import List, Literal, Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from planner import generate_plan, generate_salvage_plan, replan_day
from voice import (
    generate_greeting, chat_respond, summarize_session,
    generate_session_end, generate_initiation, generate_initiation_end,
    generate_wrapup_prompt, generate_day_summary, text_to_speech,
)

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

LOG_FILE = Path("log.json")


def append_log(entry: dict):
    log = []
    if LOG_FILE.exists():
        try:
            log = json.loads(LOG_FILE.read_text())
        except json.JSONDecodeError:
            log = []
    log.append(entry)
    LOG_FILE.write_text(json.dumps(log, indent=2))


class PlanRequest(BaseModel):
    tasks: List[str]
    day_start: str
    day_end: str
    salvage: bool = False


class PlanBlock(BaseModel):
    id: str
    type: Literal["starter", "task", "break", "meal"]
    start: str
    end: str
    title: str
    load: Optional[int] = None


class DayPlan(BaseModel):
    day_start: str
    day_end: str
    blocks: List[PlanBlock]
    notes: List[str] = []


class ReplanRequest(BaseModel):
    current_plan: dict
    completed_block_id: str
    goals_done: List[str]
    goals_missed: List[str]
    energy: int
    cognitive_load: Optional[int] = None
    notes: Optional[str] = ""
    current_time: str
    time_spent_minutes: Optional[int] = None

class VoiceGreetRequest(BaseModel):
    block: dict


class VoiceRespondRequest(BaseModel):
    conversation: List[dict]
    user_text: str
    block: dict


class VoiceSummarizeRequest(BaseModel):
    conversation: List[dict]
    block: dict


class VoiceSessionEndRequest(BaseModel):
    conversation: List[dict]
    block: dict
    time_spent_minutes: Optional[int] = None


class VoiceInitiateRequest(BaseModel):
    block: dict


class VoiceWrapupRequest(BaseModel):
    conversation: List[dict]
    block: dict
    time_spent_minutes: Optional[int] = None


class SummaryRequest(BaseModel):
    completed_blocks: List[dict]


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/plan", response_model=DayPlan)
def plan(req: PlanRequest):
    try:
        fn = generate_salvage_plan if req.salvage else generate_plan
        result = fn(tasks=req.tasks, day_start=req.day_start, day_end=req.day_end)
        append_log({"timestamp": datetime.now().isoformat(), "type": "salvage_plan" if req.salvage else "plan", "plan": result})
        return result
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/replan", response_model=DayPlan)
def replan(req: ReplanRequest):
    try:
        result = replan_day(
            current_plan=req.current_plan,
            completed_block_id=req.completed_block_id,
            goals_done=req.goals_done,
            goals_missed=req.goals_missed,
            energy=req.energy,
            cognitive_load=req.cognitive_load,
            notes=req.notes or "",
            current_time=req.current_time,
            time_spent_minutes=req.time_spent_minutes,
        )
        append_log({
            "timestamp": datetime.now().isoformat(),
            "type": "replan",
            "feedback": req.model_dump(),
            "new_plan": result,
        })
        return result
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/session", response_class=HTMLResponse)
def session_page(request: Request):
    return templates.TemplateResponse("session.html", {"request": request})


@app.post("/api/voice/greet")
def voice_greet(req: VoiceGreetRequest):
    try:
        text  = generate_greeting(req.block)
        audio = text_to_speech(text)
        return {"text": text, "audio": audio}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/respond")
def voice_respond(req: VoiceRespondRequest):
    try:
        text  = chat_respond(req.conversation, req.user_text, req.block)
        audio = text_to_speech(text)
        return {"text": text, "audio": audio}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/summarize")
def voice_summarize(req: VoiceSummarizeRequest):
    try:
        return summarize_session(req.conversation, req.block)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/session_end")
def voice_session_end(req: VoiceSessionEndRequest):
    try:
        text  = generate_session_end(req.block, req.conversation, req.time_spent_minutes)
        audio = text_to_speech(text)
        return {"text": text, "audio": audio}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/initiate")
def voice_initiate(req: VoiceInitiateRequest):
    try:
        data  = generate_initiation(req.block)
        audio = text_to_speech(data["text"])
        return {"text": data["text"], "audio": audio, "breakdown": data["breakdown"]}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/initiate_end")
def voice_initiate_end(req: VoiceSummarizeRequest):
    try:
        text  = generate_initiation_end(req.block, req.conversation)
        audio = text_to_speech(text)
        return {"text": text, "audio": audio}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/voice/wrapup")
def voice_wrapup(req: VoiceWrapupRequest):
    try:
        text  = generate_wrapup_prompt(req.block, req.conversation, req.time_spent_minutes)
        audio = text_to_speech(text)
        return {"text": text, "audio": audio}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/summary")
def day_summary(req: SummaryRequest):
    try:
        summary = generate_day_summary(req.completed_blocks)
        return {"summary": summary}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
