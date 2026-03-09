import type { OpenClawConfig } from "../../config/types.js";
import { resolveDiscordAccount } from "../../discord/accounts.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import type { ChannelDirectoryEntry } from "./types.js";

export type DirectoryConfigParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function addAllowFromAndDmsIds(
  ids: Set<string>,
  allowFrom: readonly unknown[] | undefined,
  dms: Record<string, unknown> | undefined,
) {
  for (const entry of allowFrom ?? []) {
    const raw = String(entry).trim();
    if (!raw || raw === "*") {
      continue;
    }
    ids.add(raw);
  }
  addTrimmedEntries(ids, Object.keys(dms ?? {}));
}

function addTrimmedId(ids: Set<string>, value: unknown) {
  const trimmed = String(value).trim();
  if (trimmed) {
    ids.add(trimmed);
  }
}

function addTrimmedEntries(ids: Set<string>, values: Iterable<unknown>) {
  for (const value of values) {
    addTrimmedId(ids, value);
  }
}

function normalizeTrimmedSet(
  ids: Set<string>,
  normalize: (raw: string) => string | null,
): string[] {
  return Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalize(raw))
    .filter((id): id is string => Boolean(id));
}

function resolveDirectoryQuery(query?: string | null): string {
  return query?.trim().toLowerCase() || "";
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

function applyDirectoryQueryAndLimit(ids: string[], params: DirectoryConfigParams): string[] {
  const q = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);
  const filtered = ids.filter((id) => (q ? id.toLowerCase().includes(q) : true));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[] {
  return ids.map((id) => ({ kind, id }) as const);
}

export async function listDiscordDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();

  addAllowFromAndDmsIds(
    ids,
    account.config.allowFrom ?? account.config.dm?.allowFrom,
    account.config.dms,
  );
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, guild.users ?? []);
    for (const channel of Object.values(guild.channels ?? {})) {
      addTrimmedEntries(ids, channel.users ?? []);
    }
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<@!?(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `user:${cleaned}`;
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listDiscordDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, Object.keys(guild.channels ?? {}));
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<#(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `channel:${cleaned}`;
  });
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listTelegramDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const raw = [
    ...(account.config.allowFrom ?? []).map((entry) => String(entry)),
    ...Object.keys(account.config.dms ?? {}),
  ];
  const ids = Array.from(
    new Set(
      raw
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram|tg):/i, "")),
    ),
  )
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      return withAt;
    })
    .filter((id): id is string => Boolean(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listTelegramDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = Object.keys(account.config.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
