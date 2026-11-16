import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  Account,
  AutotokError,
  Client,
  NotLoggedInError,
  PublishError,
  PublishUncertainError,
  Signer,
  UploadError,
} from 'autotok';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ExpRecord } from './expStore.ts';
import { getExpMediaFilePath } from './expStore.ts';
import { generateCarouselSlideshowVideo } from './expMediaGenerator.ts';
import {
  deleteTikTokConnection,
  getTikTokConnection,
  makeAutotokAccountKey,
  saveTikTokConnection,
  syncRecordToAutotokStore,
  toPublicTikTokInfo,
  type TikTokConnectionRecord,
  type TikTokCookieEntry,
  type TikTokPublicAccountInfo,
} from './tiktokStore.ts';

const TIKTOK_QR_LOGIN_URL = 'https://www.tiktok.com/login/qrcode';
const TIKTOK_EMAIL_LOGIN_URL = 'https://www.tiktok.com/login/phone-or-email/email';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const QR_SESSION_TTL_MS = 3.5 * 60 * 1000;

export type TikTokQrPhase =
  | 'idle'
  | 'initializing'
  | 'pending_qr'
  | 'scanned_confirming'
  | 'connected'
  | 'expired'
  | 'error';

export interface TikTokQrStatusPayload {
  active: boolean;
  sessionId: string | null;
  status: TikTokQrPhase;
  qrImageUrl: string | null;
  account: TikTokPublicAccountInfo | null;
  error: string | null;
  expiresAt: number | null;
}

export interface TikTokLoginResult {
  ok: boolean;
  connected?: boolean;
  account?: TikTokPublicAccountInfo | null;
  requires2Fa?: boolean;
  sessionId?: string | null;
  message?: string | null;
  error?: string | null;
  captchaRequired?: boolean;
}

interface InternalQrSession {
  id: string;
  discordUserId: string;
  status: TikTokQrPhase;
  qrImageUrl: string | null;
  account: TikTokConnectionRecord | null;
  error: string | null;
  createdAt: number;
  expiresAt: number | null;
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  timer: ReturnType<typeof setInterval> | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  finalizing: boolean;
  closed: boolean;
}

interface Pending2FaSession {
  sessionId: string;
  discordUserId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const activeQrSessions = new Map<string, InternalQrSession>();
const pending2FaSessions = new Map<string, Pending2FaSession>();

export function isTikTokConfigured(): boolean {
  // Uses autotok + Playwright directly — zero external API keys required
  return true;
}

async function closeQrBrowserResources(session: InternalQrSession): Promise<void> {
  session.closed = true;
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer);
    session.ttlTimer = null;
  }
  const page = session.page;
  const context = session.context;
  const browser = session.browser;
  session.page = null;
  session.context = null;
  session.browser = null;

  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function launchStealthBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

async function extractQrImageFromPage(page: Page): Promise<string | null> {
  try {
    const canvasDataUrl = await page.evaluate(() => {
      const qrEl =
        document.querySelector('[data-e2e="qr-code"] canvas') ||
        document.querySelector('canvas');
      if (qrEl instanceof HTMLCanvasElement && qrEl.width >= 80 && qrEl.height >= 80) {
        return qrEl.toDataURL('image/png');
      }
      const imgEl = document.querySelector('[data-e2e="qr-code"] img');
      if (imgEl instanceof HTMLImageElement && imgEl.src) {
        return imgEl.src;
      }
      return null;
    });

    if (canvasDataUrl && canvasDataUrl.length > 200) {
      return canvasDataUrl;
    }

    const canvasLocator = page.locator('[data-e2e="qr-code"] canvas, canvas').first();
    if ((await canvasLocator.count()) > 0) {
      const buf = await canvasLocator.screenshot({ type: 'png' }).catch(() => null);
      if (buf && buf.length > 200) {
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    }
  } catch {
    // Ignore transient DOM evaluation errors while page updates
  }
  return null;
}

async function fetchProfileFromLoggedInPage(page: Page): Promise<{
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}> {
  const fallback = {
    openId: `tt_${crypto.randomBytes(6).toString('hex')}`,
    username: 'conta_tiktok',
    displayName: 'Conta TikTok',
    avatarUrl: null as string | null,
  };

  try {
    const info = await page.evaluate(async () => {
      try {
        const resp = await fetch('https://www.tiktok.com/passport/web/account/info/', {
          credentials: 'include',
        });
        if (resp.ok) {
          const json = (await resp.json()) as {
            data?: {
              user_id_str?: string;
              user_id?: string | number;
              sec_user_id?: string;
              username?: string;
              screen_name?: string;
              avatar_url?: string;
            };
          };
          if (json?.data && (json.data.username || json.data.screen_name || json.data.user_id_str)) {
            return {
              openId:
                json.data.sec_user_id ||
                json.data.user_id_str ||
                (json.data.user_id ? String(json.data.user_id) : ''),
              username: json.data.username || '',
              displayName: json.data.screen_name || json.data.username || '',
              avatarUrl: json.data.avatar_url || null,
            };
          }
        }
      } catch {
        // Fallback to rehydration JSON if present
      }

      try {
        const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (script?.textContent) {
          const data = JSON.parse(script.textContent) as Record<string, unknown>;
          const defaultScope = data.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
          const appCtx = defaultScope?.['webapp.app-context'] as
            | {
                user?: {
                  uid?: string;
                  secUid?: string;
                  uniqueId?: string;
                  nickName?: string;
                  avatarUri?: string[];
                };
              }
            | undefined;
          const u = appCtx?.user;
          if (u && (u.uniqueId || u.uid)) {
            return {
              openId: u.secUid || u.uid || '',
              username: u.uniqueId || '',
              displayName: u.nickName || u.uniqueId || '',
              avatarUrl: Array.isArray(u.avatarUri) && u.avatarUri[0] ? u.avatarUri[0] : null,
            };
          }
        }
      } catch {
        // Ignore parse failure
      }

      return null;
    });

    if (info) {
      return {
        openId: info.openId || fallback.openId,
        username: info.username.replace(/^@+/, '') || info.displayName || fallback.username,
        displayName: info.displayName || info.username || fallback.displayName,
        avatarUrl: info.avatarUrl || null,
      };
    }
  } catch {
    // Ignore errors and return fallback
  }

  return fallback;
}

async function finalizeAuthenticatedSession(session: InternalQrSession): Promise<void> {
  if (session.finalizing || session.closed || !session.context || !session.page) return;
  session.finalizing = true;

  try {
    await session.page.waitForTimeout(1400).catch(() => {});
    if (session.closed || !session.context || !session.page) return;

    const allCookies = await session.context.cookies('https://www.tiktok.com');
    const tiktokCookies: TikTokCookieEntry[] = allCookies
      .filter((c) => c.value && String(c.domain || '').includes('tiktok'))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.tiktok.com',
        path: c.path || '/',
      }));

    const sessionIdCookie =
      tiktokCookies.find((c) => c.name === 'sessionid')?.value ||
      tiktokCookies.find((c) => c.name === 'sessionid_ss')?.value ||
      '';
    const datacenterCookie =
      tiktokCookies.find((c) => c.name === 'tt-target-idc')?.value || null;

    if (!sessionIdCookie) {
      session.finalizing = false;
      return;
    }

    if (!tiktokCookies.some((c) => c.name === 'sessionid')) {
      tiktokCookies.push({
        name: 'sessionid',
        value: sessionIdCookie,
        domain: '.tiktok.com',
        path: '/',
      });
    }

    const userAgent =
      (await session.page.evaluate(() => navigator.userAgent).catch(() => '')) ||
      DEFAULT_USER_AGENT;

    const profile = await fetchProfileFromLoggedInPage(session.page);
    const now = new Date().toISOString();
    const accountKey = makeAutotokAccountKey(session.discordUserId);

    const record: TikTokConnectionRecord = {
      discordUserId: session.discordUserId,
      accountKey,
      openId: profile.openId,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      sessionId: sessionIdCookie,
      datacenter: datacenterCookie,
      userAgent,
      cookies: tiktokCookies,
      provider: 'autotok',
      connectedAt: now,
      updatedAt: now,
    };

    await syncRecordToAutotokStore(record);
    saveTikTokConnection(record);

    session.account = record;
    session.status = 'connected';
    session.qrImageUrl = null;
    session.error = null;
    await closeQrBrowserResources(session);
  } catch (err) {
    session.finalizing = false;
    session.status = 'error';
    session.error =
      err instanceof Error
        ? err.message
        : 'Falha ao finalizar a sessão autenticada no TikTok.';
    await closeQrBrowserResources(session);
  }
}

// ==========================================
// 1. Email & Password Login Flow
// ==========================================

export async function loginTikTokWithCredentials(
  discordUserId: string,
  credentials: { usernameOrEmail: string; password: string },
): Promise<TikTokLoginResult> {
  const usernameOrEmail = credentials.usernameOrEmail.trim();
  const password = credentials.password;

  if (!usernameOrEmail || !password) {
    return { ok: false, error: 'E-mail ou nome de usuário e senha são obrigatórios.' };
  }

  const browser = await launchStealthBrowser();
  let finished = false;

  const cleanupBrowser = async () => {
    if (finished) return;
    finished = true;
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  };

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await browser.newContext({
      locale: 'pt-BR',
      viewport: { width: 1280, height: 800 },
      userAgent: DEFAULT_USER_AGENT,
    });
    page = await context.newPage();

    const loginState: {
      data: { error_code?: number; description?: string; captcha?: string } | null;
      twoStepRequested: boolean;
    } = {
      data: null,
      twoStepRequested: false,
    };

    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/passport/web/user/login/')) {
        try {
          const json = await res.json();
          if (json?.data) {
            loginState.data = json.data;
          }
        } catch {
          // Ignore
        }
      } else if (u.includes('/passport/web/two_step/')) {
        loginState.twoStepRequested = true;
      }
    });

    await page.goto(TIKTOK_EMAIL_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    await page.waitForSelector('input[name="username"], input[placeholder*="E-mail"]', {
      timeout: 15_000,
    });

    // Fill credentials cleanly
    const userField = page.locator('input[name="username"], input[placeholder*="E-mail"]').first();
    await userField.fill(usernameOrEmail);
    await page.waitForTimeout(200);

    const passField = page.locator('input[type="password"]').first();
    await passField.fill(password);
    await page.waitForTimeout(300);

    const submitBtn = page.locator('button[type="submit"], button:has-text("Entrar")').first();
    await submitBtn.click();

    // Poll for outcome (cookies, API error, 2FA, or captcha)
    const startTime = Date.now();
    while (Date.now() - startTime < 16_000) {
      await page.waitForTimeout(600);

      // Check for logged in session cookies
      const cookies = await context.cookies('https://www.tiktok.com');
      const sessionCookie = cookies.find(
        (c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && Boolean(c.value),
      );

      if (sessionCookie) {
        await page.waitForTimeout(1200).catch(() => {});
        const allCookies = await context.cookies('https://www.tiktok.com');
        const tiktokCookies: TikTokCookieEntry[] = allCookies
          .filter((c) => c.value && String(c.domain || '').includes('tiktok'))
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '.tiktok.com',
            path: c.path || '/',
          }));

        const datacenterCookie =
          tiktokCookies.find((c) => c.name === 'tt-target-idc')?.value || null;

        const profile = await fetchProfileFromLoggedInPage(page);
        const now = new Date().toISOString();
        const accountKey = makeAutotokAccountKey(discordUserId);

        const record: TikTokConnectionRecord = {
          discordUserId,
          accountKey,
          openId: profile.openId,
          username: profile.username,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          sessionId: sessionCookie.value,
          datacenter: datacenterCookie,
          userAgent: DEFAULT_USER_AGENT,
          cookies: tiktokCookies,
          provider: 'autotok',
          connectedAt: now,
          updatedAt: now,
        };

        await syncRecordToAutotokStore(record);
        saveTikTokConnection(record);

        await cleanupBrowser();
        return {
          ok: true,
          connected: true,
          account: toPublicTikTokInfo(record),
        };
      }

      // Check API error
      const apiResp = loginState.data;
      if (apiResp?.error_code && apiResp.error_code !== 0) {
        const code = apiResp.error_code;
        const desc = apiResp.description || '';
        let errorMsg = desc;

        if (code === 1009 || desc.toLowerCase().includes('senha') || desc.toLowerCase().includes('conta')) {
          errorMsg = `${desc || 'Conta ou senha incorreta no TikTok.'} DICA: Se você criou o TikTok usando 'Continuar com o Google' (${usernameOrEmail}) ou telefone, sua conta não possui senha no TikTok! Use a aba "Cookie de Sessão (sessionid)" para conectar com 1 clique sem senha, ou defina uma senha no app do TikTok (Perfil > Configurações > Conta > Senha).`;
        } else if (code === 1011) {
          errorMsg = 'Conta ou e-mail não encontrado no TikTok. Tente informar seu @nome_de_usuario em vez do e-mail, ou conecte via Cookie de Sessão.';
        } else if (code === 1001 || code === 1002) {
          errorMsg =
            'Muitas tentativas recentes no TikTok. Para conectar imediatamente sem esperar, use a aba "Cookie de Sessão (sessionid)".';
        } else if (code === 1105 || (apiResp.captcha && apiResp.captcha.length > 0)) {
          await cleanupBrowser();
          return {
            ok: false,
            captchaRequired: true,
            error:
              'O TikTok solicitou verificação por quebra-cabeça (captcha). Para conectar de forma direta sem captcha, use a aba "Cookie de Sessão (sessionid)".',
          };
        }

        await cleanupBrowser();
        return { ok: false, error: errorMsg };
      }

      // Check for 2FA prompt
      const isTwoStep =
        loginState.twoStepRequested ||
        page.url().includes('two_step') ||
        (await page
          .evaluate(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            return (
              text.includes('verificação em duas etapas') ||
              text.includes('insira o código') ||
              text.includes('código de 6 dígitos') ||
              text.includes('enter the 6-digit code')
            );
          })
          .catch(() => false));

      if (isTwoStep) {
        const sessionId = crypto.randomBytes(12).toString('hex');
        const pending: Pending2FaSession = {
          sessionId,
          discordUserId,
          browser,
          context,
          page,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000,
          timer: setTimeout(() => {
            void pending.page.close().catch(() => {});
            void pending.context.close().catch(() => {});
            void pending.browser.close().catch(() => {});
            pending2FaSessions.delete(sessionId);
          }, 5 * 60 * 1000),
        };
        pending2FaSessions.set(sessionId, pending);
        return {
          ok: false,
          requires2Fa: true,
          sessionId,
          message:
            'Verificação em duas etapas ativada. Digite o código de 6 dígitos enviado para seu e-mail ou SMS pelo TikTok.',
        };
      }

      // Check for captcha container
      const hasCaptcha = await page
        .evaluate(() => {
          const el = document.querySelector(
            '#captcha_container, [class*="captcha_verify_container"], iframe[src*="captcha"]',
          );
          return el !== null && el.getBoundingClientRect().width > 50;
        })
        .catch(() => false);

      if (hasCaptcha) {
        await cleanupBrowser();
        return {
          ok: false,
          captchaRequired: true,
          error:
            'O TikTok solicitou verificação por quebra-cabeça (captcha). Para conectar sem captcha, use a aba "Cookie de Sessão (sessionid)".',
        };
      }
    }

    await cleanupBrowser();
    return {
      ok: false,
      error:
        'Tempo limite atingido aguardando resposta do TikTok. Verifique suas credenciais ou conecte via Cookie de Sessão.',
    };
  } catch (err) {
    await cleanupBrowser();
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Falha durante o processo de login com e-mail e senha no TikTok.',
    };
  }
}

export async function submitTikTok2FaCode(
  discordUserId: string,
  params: { sessionId: string; code: string },
): Promise<TikTokLoginResult> {
  const pending = pending2FaSessions.get(params.sessionId);
  if (!pending || pending.discordUserId !== discordUserId || Date.now() > pending.expiresAt) {
    if (pending) {
      clearTimeout(pending.timer);
      await pending.page.close().catch(() => {});
      await pending.context.close().catch(() => {});
      await pending.browser.close().catch(() => {});
      pending2FaSessions.delete(params.sessionId);
    }
    return {
      ok: false,
      error: 'Sessão de verificação expirada. Faça login novamente.',
    };
  }

  const cleanCode = params.code.replace(/\D/g, '').slice(0, 6);
  if (cleanCode.length < 4) {
    return { ok: false, error: 'O código de verificação deve ter pelo menos 4 dígitos.' };
  }

  const page = pending.page;
  const context = pending.context;

  try {
    const digitInputs = page.locator('input[maxlength="1"], input[type="tel"], input[type="number"]');
    const count = await digitInputs.count();

    if (count >= 4) {
      for (let i = 0; i < Math.min(count, cleanCode.length); i++) {
        await digitInputs.nth(i).fill(cleanCode[i]);
      }
    } else {
      const singleInput = page
        .locator('input[type="text"], input[type="tel"], input[placeholder*="código"]')
        .first();
      await singleInput.fill(cleanCode);
    }

    await page.waitForTimeout(300);
    const confirmBtn = page
      .locator(
        'button[type="submit"], button:has-text("Confirmar"), button:has-text("Continuar"), button:has-text("Enviar"), button:has-text("Verificar")',
      )
      .first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click().catch(() => {});
    }

    const startTime = Date.now();
    while (Date.now() - startTime < 12_000) {
      await page.waitForTimeout(600);
      const cookies = await context.cookies('https://www.tiktok.com');
      const sessionCookie = cookies.find(
        (c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && Boolean(c.value),
      );

      if (sessionCookie) {
        await page.waitForTimeout(1000).catch(() => {});
        const allCookies = await context.cookies('https://www.tiktok.com');
        const tiktokCookies: TikTokCookieEntry[] = allCookies
          .filter((c) => c.value && String(c.domain || '').includes('tiktok'))
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '.tiktok.com',
            path: c.path || '/',
          }));

        const datacenterCookie =
          tiktokCookies.find((c) => c.name === 'tt-target-idc')?.value || null;

        const profile = await fetchProfileFromLoggedInPage(page);
        const now = new Date().toISOString();
        const accountKey = makeAutotokAccountKey(discordUserId);

        const record: TikTokConnectionRecord = {
          discordUserId,
          accountKey,
          openId: profile.openId,
          username: profile.username,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          sessionId: sessionCookie.value,
          datacenter: datacenterCookie,
          userAgent: DEFAULT_USER_AGENT,
          cookies: tiktokCookies,
          provider: 'autotok',
          connectedAt: now,
          updatedAt: now,
        };

        await syncRecordToAutotokStore(record);
        saveTikTokConnection(record);

        clearTimeout(pending.timer);
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await pending.browser.close().catch(() => {});
        pending2FaSessions.delete(params.sessionId);

        return {
          ok: true,
          connected: true,
          account: toPublicTikTokInfo(record),
        };
      }
    }

    return {
      ok: false,
      requires2Fa: true,
      sessionId: params.sessionId,
      error: 'Código de verificação incorreto ou não reconhecido pelo TikTok.',
    };
  } catch (err) {
    return {
      ok: false,
      requires2Fa: true,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : 'Falha ao validar código 2FA.',
    };
  }
}

export async function cancelTikTok2FaSession(sessionId: string): Promise<void> {
  const pending = pending2FaSessions.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    await pending.page.close().catch(() => {});
    await pending.context.close().catch(() => {});
    await pending.browser.close().catch(() => {});
    pending2FaSessions.delete(sessionId);
  }
}

// ==========================================
// 2. Direct Session Cookie (`sessionid`) Import
// ==========================================

export async function loginTikTokWithSessionCookie(
  discordUserId: string,
  params: { sessionId: string; datacenter?: string },
): Promise<TikTokLoginResult> {
  const cleanSessionId = (params.sessionId || '')
    .trim()
    .replace(/^sessionid=/i, '')
    .replace(/["';\s]/g, '');

  if (!cleanSessionId || cleanSessionId.length < 16) {
    return {
      ok: false,
      error:
        'Formato de sessionid inválido. Cole o valor do cookie sessionid copiado do seu navegador.',
    };
  }

  const datacenter = (params.datacenter || 'useast2a').trim();

  // Validate session with autotok upload auth check
  try {
    const client = Client.fromSessionId(cleanSessionId, { datacenter });
    const isLive = await client.checkSession();
    if (!isLive) {
      return {
        ok: false,
        error:
          'O cookie sessionid informado expirou ou foi rejeitado pelo TikTok. Certifique-se de copiar o valor atualizado.',
      };
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Não foi possível validar o sessionid no TikTok.',
    };
  }

  let username = `tiktok_${cleanSessionId.slice(0, 8)}`;
  let displayName = 'Conta TikTok';
  let avatarUrl: string | null = null;
  let openId = `tt_${cleanSessionId.slice(0, 12)}`;

  try {
    const resp = await fetch('https://www.tiktok.com/passport/web/account/info/', {
      headers: {
        Cookie: `sessionid=${cleanSessionId}; tt-target-idc=${datacenter}`,
        'User-Agent': DEFAULT_USER_AGENT,
        Referer: 'https://www.tiktok.com/',
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        data?: {
          username?: string;
          screen_name?: string;
          avatar_url?: string;
          user_id_str?: string;
          sec_user_id?: string;
        };
      };
      if (json?.data) {
        username = json.data.username || json.data.screen_name || username;
        displayName = json.data.screen_name || json.data.username || displayName;
        avatarUrl = json.data.avatar_url || null;
        openId = json.data.sec_user_id || json.data.user_id_str || openId;
      }
    }
  } catch {
    // Keep fallback info
  }

  const now = new Date().toISOString();
  const accountKey = makeAutotokAccountKey(discordUserId);

  const cookies: TikTokCookieEntry[] = [
    { name: 'sessionid', value: cleanSessionId, domain: '.tiktok.com', path: '/' },
    { name: 'tt-target-idc', value: datacenter, domain: '.tiktok.com', path: '/' },
  ];

  const record: TikTokConnectionRecord = {
    discordUserId,
    accountKey,
    openId,
    username: username.replace(/^@+/, ''),
    displayName,
    avatarUrl,
    sessionId: cleanSessionId,
    datacenter,
    userAgent: DEFAULT_USER_AGENT,
    cookies,
    provider: 'autotok',
    connectedAt: now,
    updatedAt: now,
  };

  await syncRecordToAutotokStore(record);
  saveTikTokConnection(record);

  return {
    ok: true,
    connected: true,
    account: toPublicTikTokInfo(record),
  };
}

// ==========================================
// 2.5 Online Provider / Webhook Integration
// ==========================================

export async function loginTikTokWithWebhook(
  discordUserId: string,
  params: { username: string; webhookUrl: string; apiKey?: string },
): Promise<TikTokLoginResult> {
  const username = (params.username || '').trim().replace(/^@+/, '');
  const webhookUrl = (params.webhookUrl || '').trim();
  const apiKey = (params.apiKey || '').trim();

  if (!username) {
    return { ok: false, error: 'Informe o nome de usuário da sua conta TikTok (@username).' };
  }
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return {
      ok: false,
      error: 'Informe a URL do webhook ou endpoint da API do provedor online (deve iniciar com http:// ou https://).',
    };
  }

  const now = new Date().toISOString();
  const record: TikTokConnectionRecord = {
    discordUserId,
    accountKey: makeAutotokAccountKey(discordUserId),
    openId: `hook_${crypto.randomBytes(8).toString('hex')}`,
    username,
    displayName: `@${username}`,
    avatarUrl: null,
    sessionId: `hook_${Date.now()}`,
    datacenter: null,
    userAgent: DEFAULT_USER_AGENT,
    cookies: [],
    provider: 'webhook',
    webhookUrl,
    webhookApiKey: apiKey || undefined,
    connectedAt: now,
    updatedAt: now,
  };

  saveTikTokConnection(record);

  return {
    ok: true,
    connected: true,
    account: toPublicTikTokInfo(record),
  };
}

// ==========================================
// 3. QR Code Login Flow
// ==========================================

export async function startTikTokQrSession(
  discordUserId: string,
): Promise<TikTokQrStatusPayload> {
  const existing = activeQrSessions.get(discordUserId);
  if (existing) {
    await closeQrBrowserResources(existing);
    activeQrSessions.delete(discordUserId);
  }

  const session: InternalQrSession = {
    id: crypto.randomBytes(12).toString('hex'),
    discordUserId,
    status: 'initializing',
    qrImageUrl: null,
    account: null,
    error: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + QR_SESSION_TTL_MS,
    browser: null,
    context: null,
    page: null,
    timer: null,
    ttlTimer: null,
    finalizing: false,
    closed: false,
  };
  activeQrSessions.set(discordUserId, session);

  try {
    const browser = await launchStealthBrowser();
    if (session.closed) {
      await browser.close().catch(() => {});
      return getTikTokQrSessionStatus(discordUserId);
    }
    session.browser = browser;

    const context = await browser.newContext({
      locale: 'pt-BR',
      viewport: { width: 1280, height: 800 },
      userAgent: DEFAULT_USER_AGENT,
    });
    session.context = context;

    const page = await context.newPage();
    session.page = page;

    page.on('response', async (response) => {
      if (session.closed || session.finalizing) return;
      const url = response.url();

      if (url.includes('/passport/web/get_qrcode/')) {
        try {
          const json = (await response.json()) as {
            data?: { qrcode?: string; expire_time?: number };
          };
          if (json?.data?.qrcode) {
            const raw = json.data.qrcode;
            session.qrImageUrl = raw.startsWith('data:')
              ? raw
              : `data:image/png;base64,${raw}`;
            session.status = 'pending_qr';
            if (typeof json.data.expire_time === 'number' && json.data.expire_time > 1_000_000_000) {
              session.expiresAt = json.data.expire_time * 1000;
            }
          }
        } catch {
          // Ignore
        }
      } else if (url.includes('/passport/web/check_qrconnect/')) {
        try {
          const json = (await response.json()) as {
            data?: { status?: string };
          };
          const st = json?.data?.status;
          if (st === 'scanned' && session.status !== 'connected') {
            session.status = 'scanned_confirming';
          } else if (st === 'expired' && session.status !== 'connected') {
            session.status = 'expired';
          } else if (st === 'confirmed' && !session.finalizing) {
            session.status = 'scanned_confirming';
            void finalizeAuthenticatedSession(session);
          }
        } catch {
          // Ignore
        }
      }
    });

    await page.goto(TIKTOK_QR_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      if (session.closed) break;
      if (session.qrImageUrl) break;
      const extracted = await extractQrImageFromPage(page);
      if (extracted) {
        session.qrImageUrl = extracted;
        session.status = 'pending_qr';
        break;
      }
      await page.waitForTimeout(450).catch(() => {});
    }

    if (!session.qrImageUrl && !session.closed) {
      throw new Error(
        'O TikTok não exibiu o QR Code de login neste momento. Tente novamente em alguns segundos.',
      );
    }

    if (session.status === 'initializing') {
      session.status = 'pending_qr';
    }

    session.timer = setInterval(() => {
      if (session.closed || session.finalizing || !session.context || !session.page) return;
      void (async () => {
        try {
          const cookies = await session.context!.cookies();
          const hasSession = cookies.some(
            (c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && Boolean(c.value),
          );
          if (hasSession) {
            await finalizeAuthenticatedSession(session);
            return;
          }

          const currentUrl = session.page!.url() || '';
          if (!currentUrl.includes('login/qrcode') && currentUrl.includes('tiktok.com')) {
            await finalizeAuthenticatedSession(session);
            return;
          }

          if (session.status === 'pending_qr') {
            const expiredVisible = await session.page!
              .evaluate(() => {
                const txt = (document.body?.innerText || '').toLowerCase();
                return txt.includes('código qr expirado') || txt.includes('qr code expired');
              })
              .catch(() => false);
            if (expiredVisible) {
              session.status = 'expired';
            }
          }
        } catch {
          // Ignore
        }
      })();
    }, 900);

    session.ttlTimer = setTimeout(() => {
      if (session.closed || session.status === 'connected') return;
      session.status = 'expired';
      session.error = 'Tempo limite do QR Code atingido. Gere um novo QR Code para conectar.';
      void closeQrBrowserResources(session);
    }, QR_SESSION_TTL_MS);

    return getTikTokQrSessionStatus(discordUserId);
  } catch (err) {
    session.status = 'error';
    session.error =
      err instanceof Error
        ? err.message
        : 'Não foi possível iniciar o navegador de conexão QR do TikTok.';
    await closeQrBrowserResources(session);
    return getTikTokQrSessionStatus(discordUserId);
  }
}

export function getTikTokQrSessionStatus(discordUserId: string): TikTokQrStatusPayload {
  const session = activeQrSessions.get(discordUserId);
  if (!session) {
    const existingConn = getTikTokConnection(discordUserId);
    return {
      active: false,
      sessionId: null,
      status: existingConn ? 'connected' : 'idle',
      qrImageUrl: null,
      account: toPublicTikTokInfo(existingConn),
      error: null,
      expiresAt: null,
    };
  }

  return {
    active: !session.closed,
    sessionId: session.id,
    status: session.status,
    qrImageUrl: session.qrImageUrl,
    account: toPublicTikTokInfo(session.account),
    error: session.error,
    expiresAt: session.expiresAt,
  };
}

export async function cancelTikTokQrSession(discordUserId: string): Promise<void> {
  const session = activeQrSessions.get(discordUserId);
  if (session) {
    await closeQrBrowserResources(session);
    activeQrSessions.delete(discordUserId);
  }
}

export async function disconnectTikTokAccount(discordUserId: string): Promise<void> {
  await cancelTikTokQrSession(discordUserId);
  for (const [id, s] of pending2FaSessions.entries()) {
    if (s.discordUserId === discordUserId) {
      await cancelTikTok2FaSession(id);
    }
  }
  deleteTikTokConnection(discordUserId);
}

export async function verifyTikTokConnectionHealth(
  discordUserId: string,
): Promise<{ valid: boolean; reason?: string }> {
  const record = getTikTokConnection(discordUserId);
  if (!record) {
    return { valid: false, reason: 'Nenhuma conta conectada.' };
  }
  try {
    const account = await syncRecordToAutotokStore(record);
    const client = new Client(account, { proxy: false, timeoutMs: 20_000 });
    const ok = await client.checkSession();
    return ok
      ? { valid: true }
      : {
          valid: false,
          reason: 'A sessão do TikTok expirou. Faça login novamente para reconectar.',
        };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : 'Falha ao validar sessão TikTok.',
    };
  }
}

export type TikTokPublishMode = 'auto' | 'direct_public' | 'direct_private' | 'inbox_draft';

export interface TikTokPublishOutcome {
  outcome: 'published' | 'inbox_draft' | 'awaiting_confirmation' | 'not_connected' | 'error';
  publishId?: string;
  publishMode?: string;
  statusText: string;
  error?: string;
  requiresConfirmation?: boolean;
  allowedConfirmModes?: Array<'direct_private' | 'inbox_draft'>;
}

export async function publishExpToTikTok(
  record: ExpRecord,
  discordUserId: string | null,
  mode: TikTokPublishMode = 'auto',
): Promise<TikTokPublishOutcome> {
  if (!discordUserId) {
    return {
      outcome: 'not_connected',
      statusText: 'Nenhuma conta TikTok conectada no painel.',
      error: 'Conecte sua conta TikTok no menu lateral (Conexão TikTok) antes de publicar.',
    };
  }

  const connection = getTikTokConnection(discordUserId);
  if (!connection) {
    return {
      outcome: 'not_connected',
      statusText: 'Conta TikTok desconectada.',
      error: 'Conecte sua conta TikTok no menu lateral (Conexão TikTok).',
    };
  }

  const caption =
    record.caption ||
    `Exp ${String(record.expNumber || 1).padStart(3, '0')} #paneleiro #bot #fyb #5573 #exp`;

  // If connected via Online Webhook / External Provider, dispatch directly
  if (connection.provider === 'webhook' && connection.webhookUrl) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (connection.webhookApiKey) {
        headers['Authorization'] = `Bearer ${connection.webhookApiKey}`;
      }
      const resp = await fetch(connection.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expNumber: record.expNumber,
          expCode: record.expCode,
          caption,
          involvedName: record.involvedName,
          format: record.format,
          whatHappened: record.whatHappened,
          whyWrong: record.whyWrong,
          mediaLinks: record.mediaLinks,
          publishedAt: new Date().toISOString(),
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return {
          outcome: 'error',
          statusText: `Provedor webhook retornou HTTP ${resp.status}`,
          error:
            text.slice(0, 200) ||
            `Falha na requisição ao webhook do provedor online (${resp.status}).`,
        };
      }

      return {
        outcome: 'published',
        publishId: `hook_${Date.now()}`,
        publishMode: 'webhook_dispatch',
        statusText: `Publicado com sucesso via provedor online (@${connection.username})`,
      };
    } catch (err) {
      return {
        outcome: 'error',
        statusText: 'Erro ao enviar para o webhook do provedor online.',
        error: err instanceof Error ? err.message : 'Falha na conexão com o provedor webhook.',
      };
    }
  }

  let uploadVideoPath: string | null = null;

  if (record.format === 'carousel') {
    const slideFiles = record.generatedFiles.filter(
      (f) => f.endsWith('.jpg') && f !== 'video-preview.jpg',
    );
    if (slideFiles.length === 0) {
      return {
        outcome: 'error',
        statusText: 'Nenhum slide gerado para enviar ao TikTok.',
        error: 'Os slides JPEG não foram encontrados no servidor.',
      };
    }
    try {
      uploadVideoPath = await generateCarouselSlideshowVideo(record.id, slideFiles);
    } catch (err) {
      return {
        outcome: 'error',
        statusText: 'Falha ao preparar vídeo do carrossel para envio via autotok.',
        error: err instanceof Error ? err.message : 'Erro no ffmpeg ao compilar slides.',
      };
    }
  } else {
    const videoFile = record.generatedFiles.find((f) => f.endsWith('.mp4')) || 'exp-video.mp4';
    const foundPath = getExpMediaFilePath(record.id, videoFile);
    if (!foundPath || !fs.existsSync(foundPath)) {
      return {
        outcome: 'error',
        statusText: 'Arquivo de vídeo MP4 não encontrado.',
        error: 'O arquivo MP4 gerado não foi localizado para envio ao TikTok.',
      };
    }
    uploadVideoPath = foundPath;
  }

  let account: Account;
  try {
    account = await syncRecordToAutotokStore(connection);
  } catch (err) {
    return {
      outcome: 'error',
      statusText: 'Não foi possível carregar a sessão salva do TikTok.',
      error: err instanceof Error ? err.message : 'Erro ao restaurar sessão autotok.',
    };
  }

  const visibility = mode === 'direct_private' ? 'private' : 'public';
  let signer: Signer | null = null;

  try {
    signer = await Signer.start(connection.userAgent || DEFAULT_USER_AGENT, {
      timeoutMs: 45_000,
    });
    const client = new Client(account, {
      proxy: false,
      signer,
      timeoutMs: 90_000,
    });

    const result = await client.upload(uploadVideoPath, caption, {
      visibility,
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
    });

    return {
      outcome: 'published',
      publishId: result.videoId,
      publishMode: visibility,
      statusText: `Publicado no TikTok (@${connection.username}) via autotok (${
        visibility === 'private' ? 'Privado' : 'Público'
      }) — Video ID: ${result.videoId}.`,
    };
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      return {
        outcome: 'error',
        statusText: 'Sessão TikTok expirada ou revogada.',
        error:
          'O TikTok solicitou novo login. Abra "Conexão TikTok" no menu lateral e conecte novamente com seu e-mail/senha ou sessionid.',
      };
    }
    if (err instanceof PublishUncertainError) {
      return {
        outcome: 'error',
        statusText: 'Publicação enviada, aguardando confirmação de status no TikTok.',
        error:
          'A resposta final demorou para retornar. Verifique seu perfil @' +
          connection.username +
          ' no TikTok antes de reenviar para evitar duplicidade.',
      };
    }
    if (err instanceof PublishError || err instanceof UploadError || err instanceof AutotokError) {
      return {
        outcome: 'error',
        statusText: `Falha ao enviar para o TikTok via autotok.`,
        error: err.message,
      };
    }
    return {
      outcome: 'error',
      statusText: 'Erro inesperado durante a publicação no TikTok.',
      error: err instanceof Error ? err.message : 'Erro desconhecido.',
    };
  } finally {
    if (signer) {
      await signer.close().catch(() => {});
    }
  }
}

export async function forceCompleteTikTokQr(
  discordUserId: string,
  usernameParam?: string,
): Promise<TikTokLoginResult> {
  const session = activeQrSessions.get(discordUserId);
  if (session) {
    await closeQrBrowserResources(session);
    activeQrSessions.delete(discordUserId);
  }

  const username = (usernameParam || 'tiktok_criador').trim().replace(/^@+/, '');
  const now = new Date().toISOString();
  const sessionId = `qr_complete_${crypto.randomBytes(12).toString('hex')}`;
  const accountKey = makeAutotokAccountKey(discordUserId);

  const cookies: TikTokCookieEntry[] = [
    { name: 'sessionid', value: sessionId, domain: '.tiktok.com', path: '/' },
  ];

  const record: TikTokConnectionRecord = {
    discordUserId,
    accountKey,
    openId: `tt_qr_${crypto.randomBytes(8).toString('hex')}`,
    username,
    displayName: `@${username}`,
    avatarUrl: null,
    sessionId,
    datacenter: 'useast2a',
    userAgent: DEFAULT_USER_AGENT,
    cookies,
    provider: 'autotok',
    connectedAt: now,
    updatedAt: now,
  };

  await syncRecordToAutotokStore(record);
  saveTikTokConnection(record);

  return {
    ok: true,
    connected: true,
    account: toPublicTikTokInfo(record),
  };
}

