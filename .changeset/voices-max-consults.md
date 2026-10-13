---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Inner voices: "Max consultations per turn" is now a setting (`maxConsults`, 1–100, default 30; was a hidden fixed limit of 8). Each `consult_voices` result says how many consultations are `left` of the turn's `of`; a refused call (`limit_reached`) carries the limit, and the agent's note states it (`voicesNote(minimum, maxConsults)`). `VoiceConsultant.maxConsults`, `maxConsultsOf`; `consultVoicesTool` now takes a per-turn counter (`{ count }`) instead of a `take()` callback; `CONSULT_LIMITS.perTurn` is the default (30) with `minPerTurn`/`maxPerTurn`.
