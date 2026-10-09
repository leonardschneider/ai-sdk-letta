---
"@ai-sdk-letta/server": minor
---

Model picker for adopted agents. `GET /api/adoption/agents/<id>/model` lists the local Letta backend's models (provider labels: ChatGPT subscription, Claude subscription or Anthropic, OpenAI API, Google; cached for 5 minutes) and `PUT /api/adoption/agents/<id>/model` `{ model }` changes the agent's model in Letta with matching `model_settings` and context window, so Letta Code uses it too; refused with `runtime_busy`, `letta_code_active`, `view_only` or `model_unknown`. The runtime restarts so the next turn uses it. `AdoptionBackend` gains `setModel` and `models`; the agent info carries `model` (the definition's for the app's own agent). New exports: `localModels`, `modelOptions`, `modelSettings`, `providerLabel`, `anthropicOAuth`, `publicModel`, `MODEL_HANDLE`, `MODEL_CACHE_MS`. The app shows the model in the agent menu and adds **Model…**.
