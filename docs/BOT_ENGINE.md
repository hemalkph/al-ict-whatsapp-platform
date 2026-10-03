# Bot Engine

A **deterministic, rule-based** bot runtime. Not AI. The runtime is built first; Bot Studio (visual editor) comes after it works.

## Node types (target)

MESSAGE, BUTTONS, LIST, QUESTION, CONDITION, SET_VARIABLE, ACTION, WHATSAPP_FLOW, ADD_TAG, REMOVE_TAG, ASSIGN_TEAM, HANDOVER, SUBFLOW.

## Rules

- No admin-supplied executable JavaScript. ACTION nodes call an **allowlisted action registry**.
- A published bot version is **immutable**. Editing a draft never changes the live bot.
- Lifecycle: draft → test → publish → activate → rollback.
- Sessions record bot version, current node, variables/state, status and timestamps.
- Session states: ACTIVE, WAITING_FOR_INPUT, HANDED_OVER, COMPLETED, FAILED.
- Execution is logged per session for debugging.
