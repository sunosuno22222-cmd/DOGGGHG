import fs from 'node:fs';
import path from 'node:path';

export interface ZernioAccountRecord {
  id: string;
  discordUserId: string;
  zernioAccountId: string;
  platform: 'tiktok' | string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'connected' | 'expired' | 'revoked';
  isDefault?: boolean;
  connectedAt: string;
  updatedAt: string;
}

export interface ZernioPublicAccountInfo {
  id: string;
  zernioAccountId: string;
  platform: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'connected' | 'expired' | 'revoked';
  isDefault: boolean;
  connectedAt: string;
  updatedAt: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const ZERNIO_FILE = path.resolve(DATA_DIR, 'zernio-accounts.json');

function readAll(): Record<string, ZernioAccountRecord> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ZERNIO_FILE)) return {};
  try {
    const raw = fs.readFileSync(ZERNIO_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, ZernioAccountRecord>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, ZernioAccountRecord>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${ZERNIO_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, ZERNIO_FILE);
}

export function getZernioAccounts(discordUserId?: string): ZernioAccountRecord[] {
  const all = readAll();
  const list = Object.values(all);
  if (!discordUserId) return list;
  return list.filter((a) => a.discordUserId === discordUserId);
}

export function getZernioAccount(idOrKey: string): ZernioAccountRecord | null {
  const all = readAll();
  if (all[idOrKey]) return all[idOrKey];
  for (const acc of Object.values(all)) {
    if (acc.id === idOrKey || acc.zernioAccountId === idOrKey || acc.username === idOrKey) {
      return acc;
    }
  }
  return null;
}

export function saveZernioAccount(record: ZernioAccountRecord): ZernioAccountRecord {
  const all = readAll();
  const id = record.id || record.zernioAccountId || `z_acc_${Date.now()}`;
  record.id = id;
  record.updatedAt = new Date().toISOString();

  const userAccounts = Object.values(all).filter((a) => a.discordUserId === record.discordUserId);
  if (userAccounts.length === 0 || record.isDefault) {
    record.isDefault = true;
    for (const a of userAccounts) {
      if (a.id !== id) a.isDefault = false;
      all[a.id] = a;
    }
  }

  all[id] = record;
  writeAll(all);
  return record;
}

export function setDefaultZernioAccount(idOrKey: string, discordUserId: string): boolean {
  const all = readAll();
  const target = getZernioAccount(idOrKey);
  if (!target || target.discordUserId !== discordUserId) return false;

  for (const [k, v] of Object.entries(all)) {
    if (v.discordUserId === discordUserId) {
      v.isDefault = v.id === target.id || v.zernioAccountId === target.zernioAccountId;
      all[k] = v;
    }
  }
  writeAll(all);
  return true;
}

export function deleteZernioAccount(idOrKey: string, discordUserId?: string): boolean {
  const all = readAll();
  const target = getZernioAccount(idOrKey);
  if (!target) return false;
  if (discordUserId && target.discordUserId !== discordUserId) return false;

  const targetKey = target.id || target.zernioAccountId || idOrKey;
  delete all[targetKey];
  for (const [k, v] of Object.entries(all)) {
    if (v.id === targetKey || v.zernioAccountId === target.zernioAccountId) {
      delete all[k];
    }
  }

  const remaining = Object.values(all).filter((a) => a.discordUserId === target.discordUserId);
  if (remaining.length > 0 && !remaining.some((a) => a.isDefault)) {
    remaining[0].isDefault = true;
    all[remaining[0].id] = remaining[0];
  }

  writeAll(all);
  return true;
}

export function toPublicZernioInfo(record: ZernioAccountRecord | null): ZernioPublicAccountInfo | null {
  if (!record) return null;
  return {
    id: record.id || record.zernioAccountId,
    zernioAccountId: record.zernioAccountId,
    platform: record.platform,
    username: record.username,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    status: record.status,
    isDefault: Boolean(record.isDefault),
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
  };
}
