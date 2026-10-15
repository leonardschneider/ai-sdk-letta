---
"ai-sdk-letta": patch
"@ai-sdk-letta/server": patch
---

Resources no longer fail when an agent workspace holds more than 20,000 files: the files are still listed and versioning pauses (`ResourceStore.overLimit`, `overLimit` in the tree response, a note in the panel) until it is back under. Common generated folders and tool caches are never versioned (`.next`, `.nuxt`, `.svelte-kit`, `.output`, `.turbo`, `.parcel-cache`, `.vite`, `target`, `.lake`, `.tox`, `venv`, `.venv-*`).
