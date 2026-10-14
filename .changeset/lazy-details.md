---
"@ai-sdk-letta/server": patch
---

The browser app no longer builds the hidden contents of collapsed tool lines (command, output, technical details) until you open them. A tool-heavy conversation went from ~18,000 to ~6,000 page elements; fixes Safari tabs growing to several GB and coming back blank.
