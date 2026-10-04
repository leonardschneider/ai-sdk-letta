---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Each adopted agent can have its own project folder, mounted read-write at `/project` in its sandbox: set it in the GUI (agent menu, **Project folder…**) or with `PUT /api/adoption/agents/<id>/project` `{ path | null }`. It is recorded in `adopted.json`, checked by the new `checkAdoptedProject` (absolute existing folder, not the home folder, `/` or `~/.letta`, no credentials in `.git/config`), and merged into the agent's sandbox by `adoptedDefinition`. The shell tools' descriptions and the "Update instructions" section tell the agent where the project is. Changing it restarts only that agent's runtime.
