---
"@ai-sdk-letta/server": patch
---

Markdown file previews in the Resources panel render LaTeX maths, always on, as written for static sites and editors: `$$...$$` display (on one line or several), `$...$` inline (with Pandoc's guards, so "$5 and $10" stay prices), `\(...\)`, `\[...\]` and the Markdown-escaped `\\(...\\)` and `\\[...\\]` used by Hugo; in files that use the escaped form, `\\\\`, `\\,` and `\*` inside maths read as `\\`, `\,` and `*`, as the site's Markdown would have made them. Code is never touched and invalid TeX shows as an inline error. YAML (`---`) or TOML (`+++`) front matter at the top of a file shows as a muted metadata block instead of a rule and a paragraph. Replies keep their rules: only `\(...\)` and `\[...\]`, never `$`.
