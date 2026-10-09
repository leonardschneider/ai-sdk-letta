---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": minor
---

Reasoning effort in the model picker. Each model lists its reasoning efforts (`efforts`, one per catalog tier, the default marked); `GET /api/adoption/agents/<id>/model` also returns the agent's current `effort` (read from Letta's `model_settings`, else the record), and `PUT` accepts `{ model, effort? }`: the effort is validated against that model's tiers (`effort_unknown`), the settings and context window come from the chosen tier, and the record keeps it (`AdoptionRecord.effort`). The same model and effort change nothing; another effort updates Letta and restarts the runtime. New exports: `effortOf`, `EFFORT_ORDER`, `EFFORT_VALUE`, `ModelEffort`. The app's **Model…** dialog gets a Reasoning choice and the agent menu shows the effort next to the model.
