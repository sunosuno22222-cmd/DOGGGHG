import {
  getZernioAccount,
  getZernioAccounts,
  toPublicZernioInfo,
  type ZernioAccountRecord,
  type ZernioPublicAccountInfo,
} from './zernioStore';
import {
  fetchZernioConnectUrl,
  publishPostViaZernio,
  verifyZernioAccountHealth,
  syncZernioAccounts,
} from './zernioService';
import type { ExpRecord } from './expStore';

export type TikTokConnectionRecord = ZernioAccountRecord;
export type TikTokPublicAccountInfo = ZernioPublicAccountInfo;

export function isTikTokConfigured(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY?.trim());
}

export function getTikTokAccounts(discordUserId?: string): ZernioAccountRecord[] {
  return getZernioAccounts(discordUserId);
}

export function getTikTokAccount(idOrKey: string): ZernioAccountRecord | null {
  return getZernioAccount(idOrKey);
}

export function getTikTokConnection(discordUserId: string, preferredId?: string | null): ZernioAccountRecord | null {
  const accounts = getZernioAccounts(discordUserId);
  if (accounts.length === 0) return null;
  if (preferredId) {
    const found = accounts.find((a) => a.id === preferredId || a.zernioAccountId === preferredId);
    if (found) return found;
  }
  return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

export function getAnyConnectedTikTok(preferredDiscordUserIds: string[] = []): ZernioAccountRecord | null {
  for (const uid of preferredDiscordUserIds) {
    if (uid) {
      const conn = getTikTokConnection(uid);
      if (conn) return conn;
    }
  }
  const all = getZernioAccounts();
  if (all.length === 0) return null;
  return all.find((a) => a.isDefault) || all[0] || null;
}

export function toPublicTikTokInfo(record: ZernioAccountRecord | null): ZernioPublicAccountInfo | null {
  return toPublicZernioInfo(record);
}

export async function verifyTikTokAccountHealth(accountIdOrKey: string): Promise<{ valid: boolean; reason?: string }> {
  return verifyZernioAccountHealth(accountIdOrKey);
}

export async function publishExpToTikTok(
  record: ExpRecord,
  discordUserId: string,
  mode: 'auto' | 'manual' | 'test' = 'auto',
  targetAccountId?: string | null,
): Promise<{
  outcome: 'published' | 'inbox_draft' | 'awaiting_confirmation' | 'not_connected' | 'error';
  publishId?: string;
  publishMode?: string;
  statusText?: string;
  error?: string;
  trackArtist?: string | null;
  trackTitle?: string | null;
}> {
  const account = getTikTokConnection(discordUserId, targetAccountId);
  if (!account) {
    return {
      outcome: 'not_connected',
      error: 'Nenhuma conta TikTok conectada via Zernio. Conecte sua conta em Contas TikTok.',
    };
  }

  const caption = `Exposição #${record.expNumber} — ${record.expCode}\n\nEnvolvido: ${record.involvedName}\nMotivo: ${record.description}`;
  const hashtags = ['#5573exp', '#exposição', '#discord', '#fy', '#fyp'];
  const videoUrl = record.mediaUrl || 'https://www.w3schools.com/html/mov_bbb.mp4';

  const result = await publishPostViaZernio({
    discordUserId,
    accountId: account.id || account.zernioAccountId,
    videoUrl,
    caption,
    hashtags,
  });

  if (!result.ok) {
    return {
      outcome: 'error',
      error: result.error || 'Falha ao publicar vídeo via Zernio.',
    };
  }

  return {
    outcome: 'published',
    publishId: result.postId || `z_pub_${Date.now()}`,
    publishMode: 'zernio_api',
    statusText: result.statusText || `Publicado com sucesso no TikTok (@${account.username}) via Zernio.`,
    trackArtist: 'Xishqa',
    trackTitle: 'кончится лето',
  };
}

export async function publishTestPostToTikTok(discordUserId: string): Promise<{
  outcome: 'published' | 'error';
  statusText?: string;
  error?: string;
  trackArtist?: string | null;
  trackTitle?: string | null;
}> {
  const account = getTikTokConnection(discordUserId);
  if (!account) {
    return {
      outcome: 'error',
      error: 'Nenhuma conta TikTok conectada via Zernio.',
    };
  }

  const result = await publishPostViaZernio({
    discordUserId,
    accountId: account.id || account.zernioAccountId,
    videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    caption: 'Olá, eu sou 5573exp, sou uma conta vinculada a um bot do Discord, onde meu principal objetivo é explanar os dados informados no canal do servidor.',
    hashtags: ['#5573exp', '#discord', '#fy'],
  });

  if (!result.ok) {
    return {
      outcome: 'error',
      error: result.error || 'Erro na publicação de teste via Zernio.',
    };
  }

  return {
    outcome: 'published',
    statusText: result.statusText || `Publicação de teste enviada com sucesso (@${account.username}) via Zernio.`,
    trackArtist: 'Xishqa',
    trackTitle: 'кончится лето',
  };
}
