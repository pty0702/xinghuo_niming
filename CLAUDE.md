# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Run

```bash
source .venv/Scripts/activate && python main.py
```

Dependencies: `websockets`, `PyQt5`, `qasync` (all already installed in `.venv`).

## Architecture

```
main.py          Entry point: QApplication + qasync event loop, wires 5 workers to 5 GUI tabs
gui.py           PyQt5 UI: MainWindow → QTabWidget → ChatTab ×5 (conv list + chat log + config)
worker.py        Core: MatchWorker (QObject), async WebSocket client, state machine, protocol
readme,md        Reverse-engineered protocol documentation
```

**No server code — client-only, connects to `wss://xinghuo1v1.com/ws/`.**

## Two-layer state model (worker.py `MatchWorker`)

Layer 1 — random match state (cleared on `randomOut`):
- `_match_state`: `"idle"` | `"matching"` | `"matched"`
- `_matched_peer`: peer_id of current random match (set on code=15, cleared on rematch/randomOut)

Layer 2 — conversation state (persists across matches):
- `_peer_id` / `_peer_name`: currently selected chat window peer (NOT cleared on randomOut)
- `_conversations[peer_id]`: `{name, sex, status: "open"|"closed"}`

**Key invariant**: `randomOut` only clears Layer 1. Layer 2 conversations stay open. Sending messages checks `_conversations[peer_id].status == "open"`, never checks `_match_state` or `_matched_peer`.

## Behavior switches (top of worker.py)

```python
AUTO_GREETING = False           # auto-send greeting on female/保密 match
AUTO_SKIP_MALE = False          # auto-randomOut on male match
ENABLE_SERVER_CLOSE_CONV = False  # send closeConversation act to server
```

## Main loop modes

`_mode` drives the main loop branch:
- `MATCHING` — delay 1-3s, send `random`, wait for code=13/15
- `CHATTING` — active conversation, 60s auto-timeout → IDLE_CHAT
- `IDLE_CHAT` — conversation open but no active peer (peer left/timeout/no reply)

Mode transitions:
- code=15 + 女/保密 → CHATTING (with greeting if AUTO_GREETING)
- code=15 + 男 + AUTO_SKIP_MALE → stay MATCHING; else → CHATTING
- rematch command → MATCHING
- code=3 matching `_peer_id` → IDLE_CHAT
- close_conversation → MATCHING

## Command flow

GUI buttons call `worker.cmd_*()` methods (main thread) → command appended to `_cmd_deque` → `_process_commands()` drains deque from async context.

Key commands:
- `cmd_send_message(text)` — send to current `_peer_id`, validates via `_conv_is_open()`
- `cmd_send_to_peer(pid, pname, text)` — send to historical peer, switches `_peer_id`
- `cmd_rematch()` — randomOut to `_matched_peer`, clears match state, enters MATCHING, does NOT clear `_peer_id`
- `cmd_close_conversation(pid)` — sets conversation status to `"closed"`, emits `conv_closed` signal
- `cmd_pause()` / `cmd_resume()` — pause/resume auto-matching

## Signal wiring (main.py `wire_worker_gui`)

**Critical**: All worker→GUI signal connections MUST use lambda wrappers. Direct `connect(tab.method)` crashes with `0xC0000409` on Windows due to qasync incompatibility when QObject signals (non-widget) connect directly to QWidget methods.

```python
# Correct:
worker.status_changed.connect(lambda i, t, tb=tab: tb.set_status(t))
# Wrong (crashes):
worker.status_changed.connect(tab.set_status)
```

Signals (all carry `int worker_index` as first arg):
- `status_changed(int, str)` → `ChatTab.set_status()`
- `chat_message(int, str, str, str)` → `ChatTab.add_chat_message(type, sender, content)`
- `match_found(int, dict)` → register peer + switch chat view
- `conv_closed(int, str)` → mark conversation closed in GUI list
- `worker_log(int, str)` → shown as system chat message

## Protocol (from readme,md)

All messages JSON over WebSocket to `wss://xinghuo1v1.com/ws/`.

| act | direction | purpose | key response |
|---|---|---|---|
| `sign` | send | register identity (32-char client id, name, userSex, address) | code=12 |
| `random` | send | enter match queue | code=13 → code=15 |
| `touser_{id}_{name}` | send | send message to peer | code=7 echo |
| `randomOut` | send | leave match (msg=peer's sel_userid) | — |
| — | recv | code=15: match success (sel_userid, sel_userNikename, sel_userSex) | — |
| — | recv | code=7: incoming/echo message (fromuser.id, touser.id) | — |
| — | recv | code=3: user offline (userIdMd5) | — |

Constraints: `random.id` must equal `sign.id`. `touser.id` uses sign.id. `sign.id` is client-generated, distinct from server's internal ID.

### code=3 (user offline) handling

- Compare `data["userIdMd5"]` against `_peer_id` and `_matched_peer` separately
- If offline ID matches `_peer_id` → mark `_peer_left = True`, switch CHATTING→IDLE_CHAT
- If offline ID matches `_matched_peer` only → notify but don't change chat state
- **Never** send randomOut; **never** close conversation

### code=7 (incoming message) handling

- If `fromuser.id` matches `_peer_id` → display as received message
- If `fromuser.id` is a different peer → auto-create conversation if missing, show system notification "[新消息] 某某: ..."
- Echo messages (where fromuser.id is our own server-internal ID) are silently ignored (they don't match any `_peer_id`)

## GUI layout (gui.py `ChatTab`)

Each of the 5 tabs:
- Top: status label + match counter
- Config row: nickname input, greeting input, apply button
- Main area (QSplitter): left = conversation QListWidget + "关闭会话" button, right = QTextEdit chat log
- Input row: message QLineEdit + send button
- Action row: "重新匹配" + "暂停匹配" buttons

Chat messages use HTML formatting: blue for sent, green for received, gray italic for system.
Conversation list items store `peer_id` via `item.setData(1, peer_id)`.
