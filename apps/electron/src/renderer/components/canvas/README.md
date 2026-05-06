# Canvas Session — spectator v0.1

Direction 1, PLAN-001. Renders a session's `Message[]` as a React Flow node graph. Read-only (spectator) — no edits write back.

See:
- [Direction 1](../../../../../../roadmap/directions/01-canvas-session.md)
- [PLAN-001](../../../../../../roadmap/plans/in-progress/PLAN-001-canvas-session-spectator-v0.md)
- [ADR-0004 (canvas SDK choice)](../../../../../../roadmap/decisions/0004-canvas-sdk.md)

## Layout

```
canvas/
├── CanvasSession.tsx          # Main React Flow editor
├── event-mapper.ts            # Message[] → { nodes, edges }
├── nodes/
│   ├── TextNode.tsx           # user/assistant text
│   ├── ToolCallNode.tsx       # tool invocation (with status + input)
│   └── ResultNode.tsx         # tool output
├── types.ts                   # Local node-data types
└── __tests__/
    └── event-mapper.test.ts
```

Mounted via `CanvasSessionPage.tsx` (one level up). Entry point is exposed as a navigation route; for v0.1 there's no automatic redirection — you trigger it explicitly.
