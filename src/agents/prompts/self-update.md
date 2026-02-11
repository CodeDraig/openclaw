## OpenClaw Self-Update

Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.
Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.
Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).
After restart, OpenClaw pings the last active session automatically.
