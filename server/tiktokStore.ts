import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Account, AccountStore, type Cookie as AutotokCookie } from 'autotok';

export interface TikTokCookieEntry {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface TikTokConnectionRecord {
  id?: string;
  discordUserId: string;
  accountKey: string;
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  sessionId: string;
  datacenter: string | null;
  userAgent: string;
  cookies: TikTokCookieEntry[];
  provider: 'autotok' | 'webhook' | 'online_service';
  webhookUrl?: string;
  webhookApiKey?: string;
  isDefault?: boolean;
  status?: 'active' | 'expired' | 'checking';
  connectedAt: string;
  updatedAt: string;
}

export interface TikTokPublicAccountInfo {
  id: string;
  accountKey: string;
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider: 'autotok' | 'webhook' | 'online_service';
  webhookUrl?: string;
  isDefault: boolean;
  connectedAt: string;
  updatedAt: string;
  status?: 'active' | 'expired' | 'checking';
}

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const TIKTOK_FILE = path.resolve(DATA_DIR, 'tiktok-connections.json');
export const AUTOTOK_ACCOUNTS_DIR = path.resolve(DATA_DIR, 'autotok-accounts');

const sharedAccountStore = new AccountStore(AUTOTOK_ACCOUNTS_DIR);

export function getAutotokAccountStore(): AccountStore {
  fs.mkdirSync(AUTOTOK_ACCOUNTS_DIR, { recursive: true });
  return sharedAccountStore;
}

export function makeAutotokAccountKey(discordUserId: string): string {
  const safe = discordUserId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `discord_${safe || 'user'}`;
}

export async function syncRecordToAutotokStore(record: TikTokConnectionRecord): Promise<Account> {
  const store = getAutotokAccountStore();
  const cookies: AutotokCookie[] =
    Array.isArray(record.cookies) && record.cookies.length > 0
      ? record.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.tiktok.com',
          path: c.path || '/',
        }))
      : [
          { name: 'sessionid', value: record.sessionId, domain: '.tiktok.com', path: '/' },
          ...(record.datacenter
            ? [{ name: 'tt-target-idc', value: record.datacenter, domain: '.tiktok.com', path: '/' }]
            : []),
        ];

  const account = new Account({
    name: record.accountKey || makeAutotokAccountKey(record.discordUserId),
    cookies,
    userAgent: record.userAgent,
  });
  await store.save(account);
  return account;
}

function getStorageKey(): Buffer {
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    process.env.DISCORD_CLIENT_SECRET?.trim() ||
    process.env.DISCORD_BOT_TOKEN?.trim() ||
    'aph-tiktok-local-storage-key';
  return crypto.createHash('sha256').update(`tiktok-store-v2:${secret}`).digest();
}

export function encryptTikTokPayload(record: TikTokConnectionRecord): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getStorageKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(record), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `ttv2.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptTikTokPayload(blob: string): TikTokConnectionRecord | null {
  if (!blob || !blob.startsWith('ttv2.')) return null;
  const parts = blob.split('.');
  if (parts.length !== 4) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const encrypted = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getStorageKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json) as TikTokConnectionRecord;
    if (
      !parsed?.discordUserId ||
      !parsed?.openId ||
      !['autotok', 'webhook', 'online_service'].includes(parsed.provider)
    ) {
      return null;
    }
    if (parsed.provider === 'webhook' && !parsed.webhookUrl) {
      return null;
    }
    if (
      parsed.provider === 'autotok' &&
      (!parsed.sessionId || parsed.sessionId.startsWith('qr_complete_'))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readAll(): Record<string, TikTokConnectionRecord> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TIKTOK_FILE)) return {};
  try {
    const raw = fs.readFileSync(TIKTOK_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, TikTokConnectionRecord>;
    if (!parsed || typeof parsed !== 'object') return {};
    const valid: Record<string, TikTokConnectionRecord> = {};
    for (const [k, rec] of Object.entries(parsed)) {
      if (!rec) continue;
      const normalizedRec = {
        ...rec,
        id: rec.id || rec.accountKey || k,
        accountKey: rec.accountKey || k,
      };
      if (normalizedRec.provider === 'webhook' && normalizedRec.webhookUrl) {
        valid[normalizedRec.id] = normalizedRec;
        continue;
      }
      if (
        normalizedRec.provider === 'autotok' &&
        normalizedRec.sessionId &&
        !normalizedRec.sessionId.startsWith('qr_complete_')
      ) {
        valid[normalizedRec.id] = normalizedRec;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, TikTokConnectionRecord>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${TIKTOK_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, TIKTOK_FILE);
}

export function saveTikTokConnection(record: TikTokConnectionRecord): TikTokConnectionRecord {
  const all = readAll();
  const id = record.id || record.accountKey || makeAutotokAccountKey(record.discordUserId);
  record.id = id;
  record.updatedAt = new Date().toISOString();

  // If this user has no other accounts or none is default, set as default
  const userAccounts = Object.values(all).filter((a) => a.discordUserId === record.discordUserId);
  if (userAccounts.length === 0 || !userAccounts.some((a) => a.isDefault && a.id !== id)) {
    record.isDefault = true;
  }

  all[id] = record;
  writeAll(all);
  void syncRecordToAutotokStore(record).catch(() => {});
  return record;
}

export function getTikTokAccount(idOrKey: string): TikTokConnectionRecord | null {
  const all = readAll();
  if (all[idOrKey]) return all[idOrKey];
  return (
    Object.values(all).find(
      (a) =>
        a.id === idOrKey ||
        a.accountKey === idOrKey ||
        a.openId === idOrKey ||
        a.username.toLowerCase() === idOrKey.toLowerCase().replace(/^@+/, ''),
    ) ?? null
  );
}

export function getTikTokAccounts(discordUserId?: string): TikTokConnectionRecord[] {
  const all = readAll();
  const list = Object.values(all);
  if (!discordUserId) return list;
  return list.filter((a) => a.discordUserId === discordUserId);
}

export function getTikTokConnection(
  discordUserId: string,
  preferredAccountId?: string,
): TikTokConnectionRecord | null {
  const all = readAll();
  if (preferredAccountId) {
    const specific = getTikTokAccount(preferredAccountId);
    if (specific && (!discordUserId || specific.discordUserId === discordUserId)) {
      return specific;
    }
  }

  const userAccounts = Object.values(all).filter(
    (a) => a.discordUserId === discordUserId || a.id === discordUserId,
  );
  if (userAccounts.length === 0) {
    // If no exact match for this discordUserId, check if any account exists globally
    return all[discordUserId] ?? null;
  }

  const def = userAccounts.find((a) => a.isDefault);
  if (def) return def;

  userAccounts.sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
  );
  return userAccounts[0];
}

export function setDefaultTikTokAccount(idOrKey: string, discordUserId?: string): boolean {
  const all = readAll();
  const target = getTikTokAccount(idOrKey);
  if (!target) return false;
  if (discordUserId && target.discordUserId !== discordUserId) return false;

  for (const acc of Object.values(all)) {
    if (!discordUserId || acc.discordUserId === target.discordUserId) {
      acc.isDefault = acc.id === target.id;
    }
  }

  writeAll(all);
  return true;
}

export async function deleteTikTokAccount(
  idOrKey: string,
  discordUserId?: string,
): Promise<boolean> {
  const all = readAll();
  const target = getTikTokAccount(idOrKey);
  if (!target) return false;
  if (discordUserId && target.discordUserId !== discordUserId) return false;

  const targetKey = target.id || target.accountKey || idOrKey;
  delete all[targetKey];
  for (const [k, v] of Object.entries(all)) {
    if (v.id === targetKey || v.accountKey === target.accountKey) {
      delete all[k];
    }
  }

  // If deleted account was default, promote another account for the same user
  const remaining = Object.values(all).filter((a) => a.discordUserId === target.discordUserId);
  if (remaining.length > 0 && !remaining.some((a) => a.isDefault)) {
    remaining[0].isDefault = true;
  }

  writeAll(all);
  await getAutotokAccountStore().delete(target.accountKey).catch(() => {});
  return true;
}

export function getAnyConnectedTikTok(
  preferredDiscordUserIds: string[] = [],
): TikTokConnectionRecord | null {
  const all = readAll();
  for (const id of preferredDiscordUserIds) {
    if (id) {
      const match = getTikTokConnection(id);
      if (match) return match;
    }
  }
  const entries = Object.values(all);
  if (entries.length === 0) return null;
  const def = entries.find((e) => e.isDefault);
  if (def) return def;
  entries.sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
  );
  return entries[0];
}

export function deleteTikTokConnection(discordUserId: string): void {
  const accounts = getTikTokAccounts(discordUserId);
  if (accounts.length > 0) {
    for (const acc of accounts) {
      const accId = acc.id || acc.accountKey;
      if (accId) {
        void deleteTikTokAccount(accId, discordUserId).catch(() => {});
      }
    }
  } else {
    const all = readAll();
    const existing = all[discordUserId];
    if (existing) {
      delete all[discordUserId];
      writeAll(all);
    }
    const accountKey = existing?.accountKey || makeAutotokAccountKey(discordUserId);
    void getAutotokAccountStore().delete(accountKey).catch(() => {});
  }
}

export function toPublicTikTokInfo(
  record: TikTokConnectionRecord | null,
): TikTokPublicAccountInfo | null {
  if (!record) return null;
  const id = record.id || record.accountKey || record.discordUserId;
  return {
    id,
    accountKey: record.accountKey || id,
    openId: record.openId,
    username: record.username,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    provider: record.provider || 'autotok',
    webhookUrl: record.webhookUrl,
    isDefault: Boolean(record.isDefault),
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt || record.connectedAt,
    status: record.status || 'active',
  };
}
