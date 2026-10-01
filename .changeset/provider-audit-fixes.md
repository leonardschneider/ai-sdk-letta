---
"@ai-sdk-letta/provider": patch
---

Dropped the unused `@ai-sdk/provider-utils` 3.x dependency, which was the only thing pulling in `undici` 5.29.0 (several high-severity advisories). Also moved `@ai-sdk/provider` from 2.x to `^4.0.18`, the version `ai` 7 uses. The model still implements `LanguageModelV2`, which `@ai-sdk/provider` 4 still exports, so the public API and runtime behaviour are unchanged.
