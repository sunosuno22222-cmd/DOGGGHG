import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ServerDashboard } from './components/ServerDashboard';
import { AvailableServersModal } from './components/AvailableServersModal';
import { ServerPanel } from './components/ServerPanel';
import { AppDrawer, type DrawerSection } from './components/AppDrawer';
import { TikTokConnectionView } from './components/TikTokConnectionView';
import { ExpHistoryView } from './components/ExpHistoryView';
import {
  apiFetch,
  clearStoredSessionToken,
  getStoredSessionToken,
  setStoredSessionToken,
} from './lib/api';
import { auth } from './lib/firebase';
import {
  deleteTikTokBackupFromCloud,
  ensureCloudUserProfile,
  loadTikTokBackupFromCloud,
  saveTikTokBackupToCloud,
  signInCloudBackup,
  signOutCloudBackup,
  syncExpRecordsWithCloud,
  syncManagedGuildsWithCloud,
} from './lib/cloudPersistence';
import type {
  ConfigStatus,
  ExpRecordView,
  ExpRecordsResponse,
  GuildItem,
  GuildsResponse,
  TikTokLoginResult,
  TikTokQrState,
  TikTokStatusResponse,
} from './types';

type AppView = 'welcome' | 'dashboard' | 'panel' | 'tiktok' | 'exp';

export default function App() {
  const [view, setView] = useState<AppView>('welcome');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [managedGuilds, setManagedGuilds] = useState<GuildItem[]>([]);
  const [availableGuilds, setAvailableGuilds] = useState<GuildItem[]>([]);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [guildsError, setGuildsError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedGuild, setSelectedGuild] = useState<GuildItem | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [cloudRestoredNotice, setCloudRestoredNotice] = useState<string | null>(null);

  // TikTok connection state (autotok QR login)
  const [tiktokStatus, setTiktokStatus] = useState<TikTokStatusResponse | null>(null);
  const [tiktokQrState, setTiktokQrState] = useState<TikTokQrState | null>(null);
  const [tiktokLoading, setTiktokLoading] = useState(false);
  const [tiktokConnecting, setTiktokConnecting] = useState(false);
  const [tiktokError, setTiktokError] = useState<string | null>(null);

  // EXP System state
  const [expRecords, setExpRecords] = useState<ExpRecordView[]>([]);
  const [nextExpCode, setNextExpCode] = useState<string>('Exp 001');
  const [expLoading, setExpLoading] = useState(false);

  const activePollStateRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const tiktokQrPollingRef = useRef<boolean>(false);
  const tiktokPollTimerRef = useRef<number | null>(null);
  const lastCloudSyncKeyRef = useRef<string>('');
  const lastTikTokCloudSyncKeyRef = useRef<string>('');

  const stopOAuthPolling = useCallback(() => {
    activePollStateRef.current = null;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const stopTikTokPolling = useCallback(() => {
    tiktokQrPollingRef.current = false;
    if (tiktokPollTimerRef.current !== null) {
      window.clearInterval(tiktokPollTimerRef.current);
      tiktokPollTimerRef.current = null;
    }
  }, []);

  const loadConfig = useCallback(async (): Promise<ConfigStatus | null> => {
    try {
      const resp = await apiFetch('/api/config/status');
      if (!resp.ok) return null;
      const data = (await resp.json()) as ConfigStatus;
      setConfig(data);
      if (!data.authenticated && getStoredSessionToken()) {
        clearStoredSessionToken();
      }
      return data;
    } catch {
      return null;
    }
  }, []);

  const loadTikTokStatus = useCallback(async (): Promise<TikTokStatusResponse | null> => {
    setTiktokLoading(true);
    try {
      const resp = await apiFetch('/api/tiktok/status');
      if (!resp.ok) return null;
      const data = (await resp.json()) as TikTokStatusResponse;
      setTiktokStatus(data);
      return data;
    } catch {
      return null;
    } finally {
      setTiktokLoading(false);
    }
  }, []);

  const loadExpRecords = useCallback(async (): Promise<ExpRecordsResponse | null> => {
    setExpLoading(true);
    try {
      const resp = await apiFetch('/api/exp/records');
      if (!resp.ok) return null;
      const data = (await resp.json()) as ExpRecordsResponse;
      setExpRecords(data.records);
      setNextExpCode(data.nextExpCode || 'Exp 001');
      return data;
    } catch {
      return null;
    } finally {
      setExpLoading(false);
    }
  }, []);

  const loadGuilds = useCallback(async () => {
    setGuildsLoading(true);
    setGuildsError(null);
    try {
      const resp = await apiFetch('/api/guilds');
      if (resp.status === 401) {
        clearStoredSessionToken();
        setManagedGuilds([]);
        setAvailableGuilds([]);
        setConfig((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
        return;
      }
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        setGuildsError(body.error || 'Erro ao carregar servidores do Discord.');
        return;
      }
      const data = (await resp.json()) as GuildsResponse;
      setManagedGuilds(data.managedGuilds);
      setAvailableGuilds(data.availableGuilds);
    } catch {
      setGuildsError('Não foi possível conectar ao backend.');
    } finally {
      setGuildsLoading(false);
    }
  }, []);

  const completeOAuthLogin = useCallback(
    async (sessionToken?: string | null) => {
      stopOAuthPolling();
      setAuthLoading(false);
      setAuthError(null);
      if (sessionToken) {
        setStoredSessionToken(sessionToken);
      }
      await loadConfig();
      setView('dashboard');
      await Promise.all([loadGuilds(), loadTikTokStatus(), loadExpRecords()]);
    },
    [loadConfig, loadExpRecords, loadGuilds, loadTikTokStatus, stopOAuthPolling],
  );

  const completeTikTokLogin = useCallback(async () => {
    stopTikTokPolling();
    setTiktokConnecting(false);
    setTiktokQrState(null);
    setTiktokError(null);
    const updated = await loadTikTokStatus();
    if (
      updated?.connected &&
      updated.account &&
      updated.encryptedBackup &&
      firebaseUser &&
      config?.user?.id
    ) {
      await saveTikTokBackupToCloud(
        firebaseUser,
        config.user.id,
        updated.account.username,
        updated.account.displayName,
        updated.encryptedBackup,
      ).catch(() => {});
    }
  }, [config?.user?.id, firebaseUser, loadTikTokStatus, stopTikTokPolling]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setFirebaseUser(fbUser);
      setFirebaseReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    void (async () => {
      const status = await loadConfig();
      if (status?.authenticated) {
        setView('dashboard');
        await Promise.all([loadGuilds(), loadTikTokStatus(), loadExpRecords()]);
      } else {
        await loadTikTokStatus();
      }
    })();
    return () => {
      stopOAuthPolling();
      stopTikTokPolling();
    };
  }, [loadConfig, loadExpRecords, loadGuilds, loadTikTokStatus, stopOAuthPolling, stopTikTokPolling]);

  useEffect(() => {
    if (!firebaseReady || !config?.authenticated || !config.user?.id || managedGuilds.length === 0) {
      return;
    }

    const syncKey = `${config.user.id}:${firebaseUser?.uid ?? 'local'}:${managedGuilds.map((g) => g.id).join(',')}`;
    if (lastCloudSyncKeyRef.current === syncKey) return;
    lastCloudSyncKeyRef.current = syncKey;

    void (async () => {
      try {
        if (firebaseUser) {
          await ensureCloudUserProfile(firebaseUser, config.user!.id);
        }
        const restoredCount = await syncManagedGuildsWithCloud(
          managedGuilds,
          config.user!.id,
          firebaseUser,
        );
        if (restoredCount > 0) {
          setCloudRestoredNotice(
            `${restoredCount} ${restoredCount === 1 ? 'servidor restaurado' : 'servidores restaurados'} automaticamente com suas configurações salvas.`,
          );
        }

        if (firebaseUser) {
          const expChanged = await syncExpRecordsWithCloud(
            firebaseUser,
            config.user!.id,
            expRecords,
          ).catch(() => false);
          if (expChanged) {
            await loadExpRecords();
          }
        }
      } catch {
        // Non-blocking background sync
      }
    })();
  }, [
    config?.authenticated,
    config?.user,
    expRecords,
    firebaseReady,
    firebaseUser,
    loadExpRecords,
    managedGuilds,
  ]);

  useEffect(() => {
    if (!firebaseReady || !firebaseUser || !config?.authenticated || !config.user?.id || !tiktokStatus) {
      return;
    }

    const syncKey = `${config.user.id}:${firebaseUser.uid}:${tiktokStatus.connected ? tiktokStatus.account?.openId ?? '1' : '0'}`;
    if (lastTikTokCloudSyncKeyRef.current === syncKey) return;
    lastTikTokCloudSyncKeyRef.current = syncKey;

    void (async () => {
      try {
        if (tiktokStatus.connected && tiktokStatus.account && tiktokStatus.encryptedBackup) {
          await saveTikTokBackupToCloud(
            firebaseUser,
            config.user!.id,
            tiktokStatus.account.username,
            tiktokStatus.account.displayName,
            tiktokStatus.encryptedBackup,
          );
        } else if (!tiktokStatus.connected) {
          const cloudBackup = await loadTikTokBackupFromCloud(firebaseUser);
          if (cloudBackup?.encryptedBackup) {
            const resp = await apiFetch('/api/tiktok/restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ encryptedBackup: cloudBackup.encryptedBackup }),
            });
            if (resp.ok) {
              await loadTikTokStatus();
            }
          }
        }
      } catch {
        // Non-blocking background sync
      }
    })();
  }, [
    config?.authenticated,
    config?.user,
    firebaseReady,
    firebaseUser,
    loadTikTokStatus,
    tiktokStatus,
  ]);

  const pollOnce = useCallback(
    async (state: string) => {
      try {
        const resp = await apiFetch(`/api/auth/poll?state=${encodeURIComponent(state)}`);
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          completed: boolean;
          status?: 'success' | 'cancelled' | 'error';
          sessionToken?: string | null;
          error?: string | null;
        };

        if (!data.completed) return;

        if (data.status === 'success') {
          await completeOAuthLogin(data.sessionToken);
        } else {
          stopOAuthPolling();
          setAuthLoading(false);
          if (data.status === 'error') {
            setAuthError(data.error || 'Falha durante a autenticação com o Discord.');
          }
        }
      } catch {
        // Ignore transient network errors while polling
      }
    },
    [completeOAuthLogin, stopOAuthPolling],
  );

  const pollTikTokQrOnce = useCallback(async () => {
    if (!tiktokQrPollingRef.current) return;
    try {
      const resp = await apiFetch('/api/tiktok/qr/status');
      if (!resp.ok) return;
      const data = (await resp.json()) as TikTokQrState;
      setTiktokQrState(data);

      if (data.status === 'connected') {
        await completeTikTokLogin();
      } else if (data.status === 'error') {
        stopTikTokPolling();
        setTiktokConnecting(false);
        setTiktokError(data.error || 'Falha ao conectar conta TikTok via QR Code.');
      } else if (data.status === 'expired') {
        stopTikTokPolling();
        setTiktokConnecting(false);
      }
    } catch {
      // Ignore transient errors while polling QR status
    }
  }, [completeTikTokLogin, stopTikTokPolling]);

  const openDiscordOAuthPopup = useCallback(
    async (mode: 'invite' | 'login', guildId?: string) => {
      stopOAuthPolling();
      setAuthLoading(true);
      setAuthError(null);
      try {
        const params = new URLSearchParams({
          mode,
          origin: window.location.origin,
        });
        if (guildId) params.set('guild_id', guildId);

        const resp = await apiFetch(`/api/auth/url?${params.toString()}`);

        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          setAuthError(
            body.error || 'Não foi possível iniciar a autenticação OAuth2 com o Discord.',
          );
          setAuthLoading(false);
          return;
        }

        const { url, state } = (await resp.json()) as { url: string; state: string };
        const popup = window.open(url, 'discord_oauth_popup', 'width=540,height=740');

        if (!popup) {
          setAuthError(
            'O navegador bloqueou a janela pop-up do Discord. Permita pop-ups para este site e tente novamente.',
          );
          setAuthLoading(false);
          return;
        }

        // Start polling state so even if browser opens a new tab without window.opener or blocks 3P cookies,
        // returning to this tab syncs the session automatically.
        activePollStateRef.current = state;
        const startedAt = Date.now();
        pollTimerRef.current = window.setInterval(() => {
          if (Date.now() - startedAt > 3 * 60 * 1000) {
            stopOAuthPolling();
            setAuthLoading(false);
            return;
          }
          if (activePollStateRef.current === state) {
            void pollOnce(state);
          }
        }, 1500);
      } catch {
        setAuthError('Erro de conexão ao iniciar o fluxo OAuth2.');
        setAuthLoading(false);
      }
    },
    [pollOnce, stopOAuthPolling],
  );

  const handleConnectTikTok = useCallback(async () => {
    stopTikTokPolling();
    setTiktokConnecting(true);
    setTiktokError(null);
    setTiktokQrState({
      active: true,
      sessionId: null,
      status: 'initializing',
      qrImageUrl: null,
      account: null,
      error: null,
      expiresAt: null,
    });

    try {
      const resp = await apiFetch('/api/tiktok/qr/start', { method: 'POST' });
      const data = (await resp.json().catch(() => ({}))) as TikTokQrState & { error?: string };

      if (!resp.ok) {
        setTiktokError(data.error || 'Não foi possível gerar o QR Code de login do TikTok.');
        setTiktokConnecting(false);
        setTiktokQrState(null);
        return;
      }

      setTiktokQrState(data);

      if (data.status === 'connected') {
        await completeTikTokLogin();
        return;
      }

      if (data.status === 'error') {
        setTiktokError(data.error || 'Não foi possível carregar o QR Code do TikTok.');
        setTiktokConnecting(false);
        return;
      }

      tiktokQrPollingRef.current = true;
      const startedAt = Date.now();
      tiktokPollTimerRef.current = window.setInterval(() => {
        if (Date.now() - startedAt > 4 * 60 * 1000) {
          stopTikTokPolling();
          setTiktokConnecting(false);
          return;
        }
        void pollTikTokQrOnce();
      }, 1300);
    } catch {
      setTiktokError('Erro de comunicação ao gerar QR Code do TikTok.');
      setTiktokConnecting(false);
      setTiktokQrState(null);
    }
  }, [completeTikTokLogin, pollTikTokQrOnce, stopTikTokPolling]);

  const handleCancelTikTokQr = useCallback(async () => {
    stopTikTokPolling();
    setTiktokConnecting(false);
    setTiktokQrState(null);
    setTiktokError(null);
    await apiFetch('/api/tiktok/qr/cancel', { method: 'POST' }).catch(() => {});
  }, [stopTikTokPolling]);

  const handleDisconnectTikTok = useCallback(async () => {
    stopTikTokPolling();
    setTiktokQrState(null);
    setTiktokLoading(true);
    setTiktokError(null);
    try {
      await apiFetch('/api/tiktok/disconnect', { method: 'POST' });
      if (firebaseUser) {
        await deleteTikTokBackupFromCloud(firebaseUser).catch(() => {});
      }
      lastTikTokCloudSyncKeyRef.current = '';
      await loadTikTokStatus();
    } catch {
      setTiktokError('Erro ao desconectar conta TikTok.');
    } finally {
      setTiktokLoading(false);
    }
  }, [firebaseUser, loadTikTokStatus, stopTikTokPolling]);

  const handleLoginTikTokCredentials = useCallback(
    async (credentials: { usernameOrEmail: string; password: string }): Promise<TikTokLoginResult> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch('/api/tiktok/login/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials),
        });
        const data = (await resp.json().catch(() => ({}))) as TikTokLoginResult;
        if (!resp.ok || !data.ok) {
          const errMsg =
            data.error ||
            (resp.status === 401
              ? 'Conecte sua conta Discord primeiro.'
              : 'Não foi possível autenticar no TikTok. Se sua conta foi criada pelo Google, use a aba Cookie de Sessão.');
          if (!data.requires2Fa) {
            setTiktokError(errMsg);
          }
          return { ...data, ok: false, error: errMsg };
        }

        if (data.connected && data.account) {
          await completeTikTokLogin();
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro de comunicação ao entrar no TikTok.';
        setTiktokError(msg);
        return { ok: false, error: msg };
      } finally {
        setTiktokLoading(false);
      }
    },
    [completeTikTokLogin],
  );

  const handleSubmitTikTok2Fa = useCallback(
    async (params: { sessionId: string; code: string }): Promise<TikTokLoginResult> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch('/api/tiktok/login/2fa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        const data = (await resp.json().catch(() => ({}))) as TikTokLoginResult;
        if (!resp.ok || !data.ok) {
          setTiktokError(data.error || 'Código de verificação incorreto ou expirado.');
          return data;
        }

        if (data.connected && data.account) {
          await completeTikTokLogin();
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao enviar código de verificação.';
        setTiktokError(msg);
        return { ok: false, error: msg };
      } finally {
        setTiktokLoading(false);
      }
    },
    [completeTikTokLogin],
  );

  const handleCancelTikTok2Fa = useCallback(async (sessionId: string): Promise<void> => {
    await apiFetch('/api/tiktok/login/2fa/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }, []);

  const handleLoginTikTokCookie = useCallback(
    async (params: { sessionId: string; datacenter?: string }): Promise<TikTokLoginResult> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch('/api/tiktok/login/cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        const data = (await resp.json().catch(() => ({}))) as TikTokLoginResult;
        if (!resp.ok || !data.ok) {
          setTiktokError(data.error || 'Não foi possível validar o cookie de sessão informado.');
          return data;
        }

        if (data.connected && data.account) {
          await completeTikTokLogin();
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao conectar via cookie do TikTok.';
        setTiktokError(msg);
        return { ok: false, error: msg };
      } finally {
        setTiktokLoading(false);
      }
    },
    [completeTikTokLogin],
  );

  const handleLoginTikTokWebhook = useCallback(
    async (params: { username: string; webhookUrl: string; apiKey?: string }): Promise<TikTokLoginResult> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch('/api/tiktok/login/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        const data = (await resp.json().catch(() => ({}))) as TikTokLoginResult;
        if (!resp.ok || !data.ok) {
          setTiktokError(data.error || 'Não foi possível configurar o provedor webhook.');
          return data;
        }

        if (data.connected && data.account) {
          await completeTikTokLogin();
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao conectar via provedor webhook.';
        setTiktokError(msg);
        return { ok: false, error: msg };
      } finally {
        setTiktokLoading(false);
      }
    },
    [completeTikTokLogin],
  );

  const handleForceCompleteQr = useCallback(
    async (username?: string): Promise<TikTokLoginResult> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch('/api/tiktok/qr/force-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        });
        const data = (await resp.json().catch(() => ({}))) as TikTokLoginResult;
        if (!resp.ok || !data.ok) {
          setTiktokError(data.error || 'Não foi possível concluir a conexão QR.');
          return data;
        }

        if (data.connected && data.account) {
          await completeTikTokLogin();
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao concluir conexão QR.';
        setTiktokError(msg);
        return { ok: false, error: msg };
      } finally {
        setTiktokLoading(false);
      }
    },
    [completeTikTokLogin],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        void completeOAuthLogin(event.data?.sessionToken ?? null);
      } else if (event.data?.type === 'OAUTH_AUTH_CANCELLED') {
        stopOAuthPolling();
        setAuthLoading(false);
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        stopOAuthPolling();
        setAuthLoading(false);
        setAuthError(
          typeof event.data?.error === 'string'
            ? event.data.error
            : 'Falha durante a autenticação com o Discord.',
        );
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'aph_session_token' && event.newValue) {
        void completeOAuthLogin(event.newValue);
      }
    };

    const handleFocusSync = () => {
      if (document.visibilityState === 'hidden') return;
      const pendingState = activePollStateRef.current;
      if (pendingState) {
        void pollOnce(pendingState);
      }
      if (tiktokQrPollingRef.current) {
        void pollTikTokQrOnce();
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleFocusSync);
    document.addEventListener('visibilitychange', handleFocusSync);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocusSync);
      document.removeEventListener('visibilitychange', handleFocusSync);
    };
  }, [
    completeOAuthLogin,
    pollOnce,
    pollTikTokQrOnce,
    stopOAuthPolling,
  ]);

  const handleLogout = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearStoredSessionToken();
    setManagedGuilds([]);
    setAvailableGuilds([]);
    setSelectedGuild(null);
    setExpRecords([]);
    setTiktokStatus(null);
    await loadConfig();
  }, [loadConfig]);

  const handleSelectGuild = useCallback((guild: GuildItem) => {
    setSelectedGuild(guild);
    setView('panel');
  }, []);

  const handleReconnectBot = useCallback(async () => {
    const resp = await apiFetch('/api/bot/reconnect', { method: 'POST' });
    if (resp.ok) {
      await loadConfig();
    }
  }, [loadConfig]);

  const handleLinkCloudBackup = useCallback(async () => {
    try {
      setAuthError(null);
      const fbUser = await signInCloudBackup();
      if (config?.user?.id) {
        await ensureCloudUserProfile(fbUser, config.user.id);
        lastCloudSyncKeyRef.current = '';
        lastTikTokCloudSyncKeyRef.current = '';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('popup-closed-by-user')) {
        setAuthError('Não foi possível conectar o backup na nuvem do Google.');
      }
    }
  }, [config?.user?.id]);

  const handleUnlinkCloudBackup = useCallback(async () => {
    await signOutCloudBackup().catch(() => {});
    lastCloudSyncKeyRef.current = '';
    lastTikTokCloudSyncKeyRef.current = '';
  }, []);

  const handleDrawerNavigate = useCallback(
    (section: DrawerSection) => {
      if (section === 'dashboard') {
        setSelectedGuild(null);
        setView('dashboard');
      } else if (section === 'tiktok') {
        setSelectedGuild(null);
        setView('tiktok');
        void loadTikTokStatus();
      } else if (section === 'exp') {
        setSelectedGuild(null);
        setView('exp');
        void loadExpRecords();
      }
    },
    [loadExpRecords, loadTikTokStatus],
  );

  const activeDrawerSection: DrawerSection =
    view === 'tiktok' ? 'tiktok' : view === 'exp' ? 'exp' : 'dashboard';

  const tiktokConnected = Boolean(tiktokStatus?.connected && tiktokStatus?.account);
  const tiktokUsername = tiktokStatus?.account?.username ?? null;

  const drawerNode = (
    <AppDrawer
      open={drawerOpen}
      activeSection={activeDrawerSection}
      tiktokConnected={tiktokConnected}
      tiktokUsername={tiktokUsername}
      onClose={() => setDrawerOpen(false)}
      onNavigate={handleDrawerNavigate}
    />
  );

  if (view === 'panel' && selectedGuild) {
    return (
      <>
        <ServerPanel
          guild={selectedGuild}
          user={config?.user ?? null}
          firebaseUser={firebaseUser}
          botError={config?.botStatus.error ?? null}
          expRecords={expRecords}
          nextExpCode={nextExpCode}
          expLoading={expLoading}
          tiktokConnected={tiktokConnected}
          onRefreshExp={() => void loadExpRecords()}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenTikTokSettings={() => handleDrawerNavigate('tiktok')}
          onReconnectBot={handleReconnectBot}
          onLinkCloudBackup={handleLinkCloudBackup}
          onBack={() => {
            setSelectedGuild(null);
            setView('dashboard');
          }}
        />
        {drawerNode}
      </>
    );
  }

  if (view === 'tiktok') {
    return (
      <>
        <TikTokConnectionView
          authenticated={Boolean(config?.authenticated)}
          user={config?.user ?? null}
          tiktokStatus={tiktokStatus}
          qrState={tiktokQrState}
          loading={tiktokLoading}
          connecting={tiktokConnecting}
          error={tiktokError}
          onOpenDrawer={() => setDrawerOpen(true)}
          onBackDashboard={() => setView('dashboard')}
          onLoginDiscord={() => void openDiscordOAuthPopup('login')}
          onConnectCredentials={handleLoginTikTokCredentials}
          onSubmit2Fa={handleSubmitTikTok2Fa}
          onCancel2Fa={handleCancelTikTok2Fa}
          onConnectCookie={handleLoginTikTokCookie}
          onConnectWebhook={handleLoginTikTokWebhook}
          onConnectTikTokQr={() => void handleConnectTikTok()}
          onForceCompleteQr={handleForceCompleteQr}
          onCancelQr={() => void handleCancelTikTokQr()}
          onDisconnectTikTok={() => void handleDisconnectTikTok()}
          onRefreshStatus={() => void loadTikTokStatus()}
        />
        {drawerNode}
      </>
    );
  }

  if (view === 'exp') {
    return (
      <>
        <ExpHistoryView
          records={expRecords}
          nextExpCode={nextExpCode}
          loading={expLoading}
          tiktokConnected={tiktokConnected}
          onRefresh={() => void loadExpRecords()}
          onOpenDrawer={() => setDrawerOpen(true)}
          onBackDashboard={() => setView('dashboard')}
          onOpenTikTokSettings={() => handleDrawerNavigate('tiktok')}
        />
        {drawerNode}
      </>
    );
  }

  if (view === 'welcome') {
    return (
      <WelcomeScreen
        oauthConfigured={config?.oauthConfigured ?? true}
        authLoading={authLoading}
        authError={authError}
        onInviteBot={() => void openDiscordOAuthPopup('invite')}
        onLoginDiscord={() => void openDiscordOAuthPopup('login')}
        onSkip={() => {
          stopOAuthPolling();
          setAuthLoading(false);
          setAuthError(null);
          setView('dashboard');
          if (config?.authenticated) {
            void Promise.all([loadGuilds(), loadTikTokStatus(), loadExpRecords()]);
          }
        }}
      />
    );
  }

  return (
    <>
      <ServerDashboard
        authenticated={Boolean(config?.authenticated)}
        user={config?.user ?? null}
        firebaseUser={firebaseUser}
        cloudRestoredNotice={cloudRestoredNotice}
        managedGuilds={managedGuilds}
        loading={guildsLoading}
        error={guildsError || authError}
        oauthConfigured={config?.oauthConfigured ?? true}
        onOpenDrawer={() => setDrawerOpen(true)}
        onOpenAvailableModal={() => {
          setModalOpen(true);
          if (config?.authenticated && availableGuilds.length === 0) {
            void loadGuilds();
          }
        }}
        onSelectGuild={handleSelectGuild}
        onLoginDiscord={() => void openDiscordOAuthPopup('login')}
        onInviteBot={() => void openDiscordOAuthPopup('invite')}
        onLogout={() => void handleLogout()}
        onRefresh={() => void loadGuilds()}
        onGoWelcome={() => setView('welcome')}
        onLinkCloudBackup={() => void handleLinkCloudBackup()}
        onUnlinkCloudBackup={() => void handleUnlinkCloudBackup()}
      />

      <AvailableServersModal
        open={modalOpen}
        authenticated={Boolean(config?.authenticated)}
        loading={guildsLoading}
        availableGuilds={availableGuilds}
        onClose={() => setModalOpen(false)}
        onSelectGuild={handleSelectGuild}
        onInviteToGuild={(guildId) => void openDiscordOAuthPopup('invite', guildId)}
        onLoginDiscord={() => void openDiscordOAuthPopup('login')}
      />

      {drawerNode}
    </>
  );
}

