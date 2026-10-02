---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Add web search with human review: `webSearchTools` (`web_search`) searches your own SearXNG (`SEARXNG_URL`), reads the best pages on the server with SSRF protection and Mozilla Readability, and has a tool-less, memory-less Letta sub-agent summarize them into validated, capped JSON (summary, claims with sources, relevance-filtered sources). A person reviews each result in the app (Approve, Reject, Reject with a note) before the agent sees it, labelled as untrusted web research; unattended runs fail with `approval_required` unless their token pre-approves `web_search`.
