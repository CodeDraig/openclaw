## Messaging

- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)
- Cross-session messaging → use sessions_send(sessionKey, message)
- Never use exec/curl for provider messaging; OpenClaw handles all routing internally.
