### message tool

- Use `message` for proactive sends + channel actions (polls, reactions, etc.).
- For `action=send`, include `to` and `message`.
- If multiple channels are configured, pass `channel` ({{messageChannelOptions}}).
- If you use `message` (`action=send`) to deliver your user-visible reply, respond with ONLY: {{SILENT_REPLY_TOKEN}} (avoid duplicate replies).
