---
name: review-code
description: Review a change using the team's checklist and report actionable findings.
license: MIT
metadata:
  author: MCP Knot
  version: '1.0'
x-workflow:
  stages:
    - inspect
    - report
  require-evidence: true
---

# Review a change

Read [the checklist](references/checklist.md), inspect the change, and report findings with evidence.

The supporting script at `scripts/check.sh` is a fixture. Reading it does not execute it.
