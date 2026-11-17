import fetch from 'node-fetch';
import {
  getZernioAccount,
  getZernioAccounts,
  saveZernioAccount,
  toPublicZernioInfo,
  type ZernioAccountRecord,
  type ZernioPublicAccountInfo,
} from './zernioStore';

const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

function getZernioApiKey(): string {
  return process.env.ZERNIO_API_KEY?.trim() || '';
}

function getZernioHeaders(): Record<string, string> {
  const apiKey = getZernioApiKey();
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function fetchZernioConnectUrl(
  discordUserId: string,
  redirectUri: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const apiKey = getZernioApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: 'ZERNIO_API_KEY não configurada nas variáveis de ambiente. Defina ZERNIO_API_KEY no arquivo .env.',
    };
  }

  try {
    const resp = await fetch(`${ZERNIO_BASE_URL}/auth/connect`, {
      method: 'POST',
      headers: getZernioHeaders(),
      body: JSON.stringify({
        platform: 'tiktok',
        redirect_uri: redirectUri,
        state: `discord_${discordUserId}`,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      // Fallback if endpoint differs
      const fallbackResp = await fetch(`${ZERNIO_BASE_URL}/accounts/connect`, {
        method: 'POST',
        headers: getZernioHeaders(),
        body: JSON.stringify({
          platform: 'tiktok',
          redirect_uri: redirectUri,
          state: `discord_${discordUserId}`,
        }),
      });
      if (fallbackResp.ok) {
        const data = (await fallbackResp.json()) as { url?: string; connect_url?: string };
        if (data?.url || data?.connect_url) {
          return { ok: true, url: data.url || data.connect_url };
        }
      }
      return {
        ok: false,
        error: `Zernio API retornou erro (${resp.status}): ${errText || 'Falha ao gerar link OAuth.'}`,
      };
    }

    const json = (await resp.json()) as { url?: string; connect_url?: string; auth_url?: string };
    const authUrl = json.url || json.connect_url || json.auth_url;
    if (!authUrl) {
      return { ok: false, error: 'Zernio não retornou a URL de autorização OAuth.' };
    }

    return { ok: true, url: authUrl };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Erro de comunicação com a API do Zernio.',
    };
  }
}

export async function syncZernioAccounts(discordUserId: string): Promise<ZernioAccountRecord[]> {
  const apiKey = getZernioApiKey();
  if (!apiKey) {
    // If no API key configured, return local store
    return getZernioAccounts(discordUserId);
  }

  try {
    const resp = await fetch(`${ZERNIO_BASE_URL}/accounts?platform=tiktok`, {
      headers: getZernioHeaders(),
    });

    if (resp.ok) {
      const json = (await resp.json()) as {
        data?: Array<{
          id: string;
          platform?: string;
          username?: string;
          name?: string;
          avatar_url?: string;
          status?: string;
        }>;
        accounts?: Array<{
          id: string;
          platform?: string;
          username?: string;
          name?: string;
          avatar_url?: string;
          status?: string;
        >>;
      };

      const items = json.data || json.accounts || [];
      for (const item of items) {
        if (!item.id) continue;
        const username = item.username || `tiktok_${item.id.slice(0, 8)}`;
        const record: ZernioAccountRecord = {
          id: `z_${item.id}`,
          discordUserId,
          zernioAccountId: item.id,
          platform: 'tiktok',
          username: username.replace(/^@+/, ''),
          displayName: item.name || `@${username}`,
          avatarUrl: item.avatar_url || null,
          status: item.status === 'expired' ? 'expired' : 'connected',
          connectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        saveZernioAccount(record);
      }
    }
  } catch {
    // Fallback to local store on network hiccup
  }

  return getZernioAccounts(discordUserId);
}

export async function verifyZernioAccountHealth(
  accountIdOrKey: string,
): Promise<{ valid: boolean; reason?: string }> {
  const account = getZernioAccount(accountIdOrKey);
  if (!account) {
    return { valid: false, reason: 'Conta não encontrada no sistema.' };
  }

  const apiKey = getZernioApiKey();
  if (!apiKey) {
    return { valid: true };
  }

  try {
    const resp = await fetch(`${ZERNIO_BASE_URL}/accounts/${encodeURIComponent(account.zernioAccountId)}`, {
      headers: getZernioHeaders(),
    });
    if (!resp.ok) {
      return { valid: false, reason: 'A sessão OAuth no Zernio expirou ou foi revogada.' };
    }
    const json = (await resp.json()) as { status?: string };
    if (json?.status === 'expired' || json?.status === 'revoked') {
      account.status = 'expired';
      saveZernioAccount(account);
      return { valid: false, reason: 'Autorização expirada no Zernio. Reconecte a conta.' };
    }
    return { valid: true };
  } catch {
    return { valid: true }; // Assume valid on temporary network issue
  }
}

export interface ZernioPublishParams {
  discordUserId: string;
  accountId?: string;
  videoUrl: string;
  caption: string;
  hashtags: string[];
  scheduledTime?: string; // ISO string for scheduling
}

export async function publishPostViaZernio(params: ZernioPublishParams): {
  ok: boolean;
  postId?: string;
  statusText?: string;
  error?: string;
} {
  const accounts = getZernioAccounts(params.discordUserId);
  const targetAccount = params.accountId
    ? accounts.find((a) => a.id === params.accountId || a.zernioAccountId === params.accountId)
    : accounts.find((a) => a.isDefault) || accounts[0];

  if (!targetAccount) {
    return {
      ok: false,
      error: 'Nenhuma conta TikTok conectada via Zernio para realizar a publicação.',
    };
  }

  const apiKey = getZernioApiKey();
  const captionFull = `${params.caption}\n\n${params.hashtags.join(' ')}`.trim();

  if (!apiKey) {
    // Simulation mode when ZERNIO_API_KEY is not set
    const postId = `z_post_${Date.now()}`;
    return {
      ok: true,
      postId,
      statusText: `Publicado com sucesso via Zernio (@${targetAccount.username}) [Modo Simulação]`,
    };
  }

  try {
    const resp = await fetch(`${ZERNIO_BASE_URL}/posts`, {
      method: 'POST',
      headers: getZernioHeaders(),
      body: JSON.stringify({
        accounts: [targetAccount.zernioAccountId],
        platforms: ['tiktok'],
        media_urls: [params.videoUrl],
        text: captionFull,
        scheduled_at: params.scheduledTime || undefined,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      return {
        ok: false,
        error: `Zernio API Post Error (${resp.status}): ${errBody || 'Falha ao publicar vídeo.'}`,
      };
    }

    const json = (await resp.json()) as { id?: string; post_id?: string; status?: string };
    const postId = json.id || json.post_id || `z_post_${Date.now()}`;

    return {
      ok: true,
      postId,
      statusText: `Publicado com sucesso no TikTok (@${targetAccount.username}) via Zernio (ID: ${postId})`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Erro de conexão ao publicar via Zernio.',
    };
  }
}
