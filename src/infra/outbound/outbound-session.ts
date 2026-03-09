import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../../config/sessions.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { buildAgentSessionKey, type RoutePeer } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import {
  looksLikeUuid,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../../signal/identity.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import { resolveTelegramTargetChatType } from "../../telegram/inline-buttons.js";
import { parseTelegramThreadId } from "../../telegram/outbound-params.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
};

function normalizeThreadId(value?: string | number | null): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${channel.toLowerCase()}:`;
  if (lower.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

function inferPeerKind(params: {
  channel: ChannelId;
  resolvedTarget?: ResolvedMessagingTarget;
}): ChatType {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    const plugin = getChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return "channel";
    }
    return "group";
  }
  return "direct";
}

function buildBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

function resolveDiscordSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseDiscordTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  const peer: RoutePeer = {
    kind: isDm ? "direct" : "channel",
    id: parsed.id,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer,
  });
  const explicitThreadId = normalizeThreadId(params.threadId);
  const threadCandidate = explicitThreadId ?? normalizeThreadId(params.replyToId);
  // Discord threads use their own channel id; avoid adding a :thread suffix.
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadCandidate,
    useSuffix: false,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isDm ? "direct" : "channel",
    from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
    to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId: explicitThreadId ?? undefined,
  };
}

function resolveTelegramSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const parsedThreadId = parsed.messageThreadId;
  const fallbackThreadId = normalizeThreadId(params.threadId);
  const resolvedThreadId = parsedThreadId ?? parseTelegramThreadId(fallbackThreadId);
  // Telegram topics are encoded in the peer id (chatId:topic:<id>).
  const chatType = resolveTelegramTargetChatType(params.target);
  // If the target is a username and we lack a resolvedTarget, default to DM to avoid group keys.
  const isGroup =
    chatType === "group" ||
    (chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  // For groups: include thread ID in peerId. For DMs: use simple chatId (thread handled via suffix).
  const peerId =
    isGroup && resolvedThreadId ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer,
  });
  // Use thread suffix for DM topics to match inbound session key format
  const threadKeys =
    resolvedThreadId && !isGroup
      ? { sessionKey: `${baseSessionKey}:thread:${resolvedThreadId}` }
      : null;
  return {
    sessionKey: threadKeys?.sessionKey ?? baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup
      ? `telegram:group:${peerId}`
      : resolvedThreadId
        ? `telegram:${chatId}:topic:${resolvedThreadId}`
        : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}

function resolveSignalSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "signal");
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith("group:")) {
    const groupId = stripped.slice("group:".length).trim();
    if (!groupId) {
      return null;
    }
    const peer: RoutePeer = { kind: "group", id: groupId };
    const baseSessionKey = buildBaseSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "signal",
      accountId: params.accountId,
      peer,
    });
    return {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  let recipient = stripped.trim();
  if (lowered.startsWith("username:")) {
    recipient = stripped.slice("username:".length).trim();
  } else if (lowered.startsWith("u:")) {
    recipient = stripped.slice("u:".length).trim();
  }
  if (!recipient) {
    return null;
  }

  const uuidCandidate = recipient.toLowerCase().startsWith("uuid:")
    ? recipient.slice("uuid:".length)
    : recipient;
  const sender = resolveSignalSender({
    sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
    sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient,
  });
  const peerId = sender ? resolveSignalPeerId(sender) : recipient;
  const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
  const peer: RoutePeer = { kind: "direct", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "signal",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "direct",
    from: `signal:${displayRecipient}`,
    to: `signal:${displayRecipient}`,
  };
}

function resolveMatrixSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "matrix");
  const isUser =
    params.resolvedTarget?.kind === "user" || stripped.startsWith("@") || /^user:/i.test(stripped);
  const rawId = stripKindPrefix(stripped);
  if (!rawId) {
    return null;
  }
  const peer: RoutePeer = { kind: isUser ? "direct" : "channel", id: rawId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `matrix:${rawId}` : `matrix:channel:${rawId}`,
    to: `room:${rawId}`,
  };
}

function resolveMattermostSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^mattermost:/i, "").trim();
  const lower = trimmed.toLowerCase();
  const isUser = lower.startsWith("user:") || trimmed.startsWith("@");
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const peer: RoutePeer = { kind: isUser ? "direct" : "channel", id: rawId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
    threadId,
  };
}

function resolveBlueBubblesSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "bluebubbles");
  const lower = stripped.toLowerCase();
  const isGroup =
    lower.startsWith("chat_id:") ||
    lower.startsWith("chat_guid:") ||
    lower.startsWith("chat_identifier:") ||
    lower.startsWith("group:");
  const rawPeerId = isGroup
    ? stripKindPrefix(stripped)
    : stripped.replace(/^(imessage|sms|auto):/i, "");
  // BlueBubbles inbound group ids omit chat_* prefixes; strip them to align sessions.
  const peerId = isGroup
    ? rawPeerId.replace(/^(chat_id|chat_guid|chat_identifier):/i, "")
    : rawPeerId;
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
    to: `bluebubbles:${stripped}`,
  };
}

function resolveNextcloudTalkSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").trim();
  trimmed = trimmed.replace(/^room:/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const peer: RoutePeer = { kind: "group", id: trimmed };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "group",
    from: `nextcloud-talk:room:${trimmed}`,
    to: `nextcloud-talk:${trimmed}`,
  };
}

function resolveNostrSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, "nostr").trim();
  if (!trimmed) {
    return null;
  }
  const peer: RoutePeer = { kind: "direct", id: trimmed };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "direct",
    from: `nostr:${trimmed}`,
    to: `nostr:${trimmed}`,
  };
}

function normalizeTlonShip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}

function resolveTlonSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = stripProviderPrefix(params.target, "tlon");
  trimmed = trimmed.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  let isGroup =
    lower.startsWith("group:") || lower.startsWith("room:") || lower.startsWith("chat/");
  let peerId = trimmed;
  if (lower.startsWith("group:") || lower.startsWith("room:")) {
    peerId = trimmed.replace(/^(group|room):/i, "").trim();
    if (!peerId.startsWith("chat/")) {
      const parts = peerId.split("/").filter(Boolean);
      if (parts.length === 2) {
        peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      }
    }
    isGroup = true;
  } else if (lower.startsWith("dm:")) {
    peerId = normalizeTlonShip(trimmed.slice("dm:".length));
    isGroup = false;
  } else if (lower.startsWith("chat/")) {
    peerId = trimmed;
    isGroup = true;
  } else if (trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length === 2) {
      peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      isGroup = true;
    }
  } else {
    peerId = normalizeTlonShip(trimmed);
  }

  const peer: RoutePeer = { kind: isGroup ? "group" : "direct", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "tlon",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `tlon:group:${peerId}` : `tlon:${peerId}`,
    to: `tlon:${peerId}`,
  };
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

type OutboundSessionResolver = (
  params: ResolveOutboundSessionRouteParams,
) => OutboundSessionRoute | null | Promise<OutboundSessionRoute | null>;

const OUTBOUND_SESSION_RESOLVERS: Partial<Record<ChannelId, OutboundSessionResolver>> = {
  discord: resolveDiscordSession,
  telegram: resolveTelegramSession,
  signal: resolveSignalSession,
  matrix: resolveMatrixSession,
  mattermost: resolveMattermostSession,
  bluebubbles: resolveBlueBubblesSession,
  "nextcloud-talk": resolveNextcloudTalkSession,
  nostr: resolveNostrSession,
  tlon: resolveTlonSession,
};

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const resolver = OUTBOUND_SESSION_RESOLVERS[params.channel];
  if (!resolver) {
    return resolveFallbackSession(nextParams);
  }
  return await resolver(nextParams);
}

export async function ensureOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
