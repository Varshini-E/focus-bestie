# Adaptive Day Planner - Anchor

An ADHD-aware, AI-powered day planner that schedules your tasks, acts as a body doubling agent during each work session, and dynamically replans your day as things change.

Built as part of the [Mistral AI Worldwide Hackathon](https://worldwide-hackathon.mistral.ai/) - San Francisco.

---

## What it does

Most planners are static — they don't care that you ran late, that you're drained after a hard block, or that you can't bring yourself to start. This app is built around the reality that days are messy.

You give it your tasks and a time window. It builds a Pomodoro-aware schedule, reasoning about what each task actually involves — if something implies travel, a meal, preparation, or waiting, those blocks get added automatically. When you open a block, an AI body doubling agent joins you via voice — you say your goals, the timer starts, and it stays present for the session. When time's up, it checks in, and based on your energy and what you got done, it replans the rest of the day.

If the day feels overwhelming, **Minimum Salvage Mode** strips everything back to one achievable task and one 25-minute work session.

---

## Use cases

- Students and professionals managing focus with ADHD or executive dysfunction
- Anyone whose day regularly goes sideways and needs a plan that adapts rather than breaks
- People who need help actually starting tasks

[Quick overview](https://www.loom.com/share/6d735594b1c44840ac34dd7dcf46b157)

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| AI scheduling | Mistral AI (`ministral-14b-latest`) |
| AI body doubling | Mistral AI (`ministral-14b-latest`) |
| Text-to-speech | ElevenLabs API (`eleven_multilingual_v2`) |
| Speech-to-text | Browser Web Speech API (SpeechRecognition) |
| Frontend | Vanilla HTML/CSS/JS, Jinja2 templates |

---

## Project structure

```
adaptive-day-planner/
├── main.py              # FastAPI app — all routes and request models
├── planner.py           # AI scheduling: generate_plan, generate_salvage_plan, replan_day
├── voice.py             # AI body doubling: greet, respond, summarise, initiation, wrapup, TTS
├── templates/
│   ├── index.html       # Home page — task input, schedule view, modals
│   └── session.html     # Session page — timer, voice transcript, overlay
├── static/
│   ├── app.js           # Home page logic
│   └── session.js       # Session logic — timer, voice flow, replan, initiation overlay
├── requirements.txt
└── .env                 # API keys (not committed)
```

---

## Setup

### 1. Install dependencies

```bash
cd adaptive-day-planner
pip install -r requirements.txt
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
MISTRAL_API_KEY=your_mistral_api_key_here

# Optional — needed for text-to-speech. Without it, the app still works but won't speak.
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

- Mistral: [console.mistral.ai](https://console.mistral.ai)
- ElevenLabs: [elevenlabs.io](https://elevenlabs.io) (optional)

### 3. Run

```bash
uvicorn main:app --reload
```

Open [http://localhost:8000](http://localhost:8000).

---
