---
"ai-sdk-letta": minor
"@ai-sdk-letta/server": minor
---

Claim confirmation. When a memory change relies on a statement it attributes to a person ("Bob from ops said …"), Jiminy lists it (`claims`) and the change is held until that person confirms it: they get a claim confirmation decision in their bell (Yes re-applies the change with `X-Confirmed-By`; No keeps it removed and notifies the requester and admins of an unconfirmed claim; Partly keeps it removed and sends their comment to the agent). Only the named member can confirm; admins may reject but never confirm for them. People are matched by display name, first name or Tailscale login and never guessed: outsiders and ambiguous names get an admin memory review ("cannot be verified"); claims about the requester need nothing. `matchClaimPerson`, `MemoryGuard.decideClaim` and the guard events `members`/`confirmClaims` are exported. Members may now switch their own conversation to Strict (trust mode); loosening it stays admin-only.
