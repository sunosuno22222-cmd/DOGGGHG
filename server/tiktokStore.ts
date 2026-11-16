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
  connectedAt: string;
  updatedAt: string;
}

export interface TikTokPublicAccountInfo {
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider: 'autotok' | 'webhook' | 'online_service';
  webhookUrl?: string;
  connectedAt: string;
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
      if (rec && rec.provider === 'autotok' && rec.sessionId) {
        valid[k] = rec;
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
  all[record.discordUserId] = record;
  writeAll(all);
  void syncRecordToAutotokStore(record).catch(() => {});
  return record;
}

export function getTikTokConnection(discordUserId: string): TikTokConnectionRecord | null {
  const all = readAll();
  return all[discordUserId] ?? null;
}

export function getAnyConnectedTikTok(
  preferredDiscordUserIds: string[] = [],
): TikTokConnectionRecord | null {
  const all = readAll();
  for (const id of preferredDiscordUserIds) {
    if (id && all[id]) return all[id];
  }
  const entries = Object.values(all);
  if (entries.length === 0) return null;
  entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return entries[0];
}

export function deleteTikTokConnection(discordUserId: string): void {
  const all = readAll();
  const existing = all[discordUserId];
  if (existing) {
    delete all[discordUserId];
    writeAll(all);
  }
  const accountKey = existing?.accountKey || makeAutotokAccountKey(discordUserId);
  void getAutotokAccountStore().delete(accountKey).catch(() => {});
}

export function toPublicTikTokInfo(
  record: TikTokConnectionRecord | null,
): TikTokPublicAccountInfo | null {
  if (!record) return null;
  return {
    openId: record.openId,
    username: record.username,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    provider: record.provider || 'autotok',
    webhookUrl: record.webhookUrl,
    connectedAt: record.connectedAt,
  };
}
