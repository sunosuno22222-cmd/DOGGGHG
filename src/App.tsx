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
  ensureCloudUserProfile,
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
  TikTokStatusResponse,
} from './types';

type AppView = 'welcome' | 'dashboard' | 'panel' | 'tiktok' | 'exp';

export default function App() {
  const [view, setView] = useState<AppView>(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view');
    if (v === 'tiktok' || v === 'exp' || v === 'dashboard') return v;
    return 'welcome';
  });
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

  // TikTok connection state (Zernio OAuth API)
  const [tiktokStatus, setTiktokStatus] = useState<TikTokStatusResponse | null>(null);
  const [tiktokLoading, setTiktokLoading] = useState(false);
  const [tiktokError, setTiktokError] = useState<string | null>(null);
  const [tiktokNotice, setTiktokNotice] = useState<string | null>(null);

  // EXP System state
  const [expRecords, setExpRecords] = useState<ExpRecordView[]>([]);
  const [nextExpCode, setNextExpCode] = useState<string>('Exp 001');
  const [expLoading, setExpLoading] = useState(false);

  const activePollStateRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const lastCloudSyncKeyRef = useRef<string>('');

  const stopOAuthPolling = useCallback(() => {
    activePollStateRef.current = null;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setFirebaseUser(fbUser);
      setFirebaseReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get('view');
    const tiktokOAuthStatus = params.get('tiktok_oauth');
    const tiktokOAuthUser = params.get('username');
    const tiktokOAuthErr = params.get('error');

    if (tiktokOAuthStatus === 'success') {
      setTiktokNotice(
        tiktokOAuthUser
          ? `Conta @${tiktokOAuthUser} conectada com sucesso via Zernio OAuth!`
          : 'Conta TikTok conectada com sucesso via Zernio OAuth!',
      );
      setTiktokError(null);
    } else if (tiktokOAuthStatus === 'error') {
      setTiktokError(tiktokOAuthErr || 'Não foi possível concluir a conexão OAuth com o TikTok.');
    }

    if (requestedView || tiktokOAuthStatus) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    void (async () => {
      const status = await loadConfig();
      if (status?.authenticated) {
        if (requestedView === 'tiktok') {
          setView('tiktok');
        } else if (requestedView === 'exp') {
          setView('exp');
        } else {
          setView('dashboard');
        }
        await Promise.all([loadGuilds(), loadTikTokStatus(), loadExpRecords()]);
      } else {
        await loadTikTokStatus();
      }
    })();

    return () => {
      stopOAuthPolling();
    };
  }, [loadConfig, loadExpRecords, loadGuilds, loadTikTokStatus, stopOAuthPolling]);

  useEffect(() => {
    if (!firebaseReady || !config?.authenticated || !config.user?.id || managedGuilds.length === 0) {
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
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

  const handleDisconnectTikTok = useCallback(async () => {
    setTiktokLoading(true);
    setTiktokError(null);
    try {
      await apiFetch('/api/tiktok/disconnect', { method: 'POST' });
      await loadTikTokStatus();
    } catch {
      setTiktokError('Erro ao desconectar conta TikTok.');
    } finally {
      setTiktokLoading(false);
    }
  }, [loadTikTokStatus]);

  const handleSelectTikTokAccount = useCallback(
    async (accountId: string): Promise<void> => {
      try {
        await apiFetch(`/api/tiktok/accounts/${encodeURIComponent(accountId)}/select`, {
          method: 'POST',
        });
        await loadTikTokStatus();
      } catch {
        // Non-blocking
      }
    },
    [loadTikTokStatus],
  );

  const handleDeleteTikTokAccount = useCallback(
    async (accountId: string): Promise<void> => {
      setTiktokLoading(true);
      setTiktokError(null);
      try {
        const resp = await apiFetch(`/api/tiktok/accounts/${encodeURIComponent(accountId)}`, {
          method: 'DELETE',
        });
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as { error?: string };
          setTiktokError(data.error || 'Não foi possível desconectar a conta no Zernio.');
        }
        await loadTikTokStatus();
      } catch {
        setTiktokError('Erro ao desconectar conta TikTok.');
      } finally {
        setTiktokLoading(false);
      }
    },
    [loadTikTokStatus],
  );

  const handleVerifyTikTokAccount = useCallback(
    async (accountId: string): Promise<{ valid: boolean; reason?: string }> => {
      try {
        const resp = await apiFetch(`/api/tiktok/accounts/${encodeURIComponent(accountId)}/verify`, {
          method: 'POST',
        });
        const data = (await resp.json().catch(() => ({}))) as { valid: boolean; reason?: string };
        await loadTikTokStatus();
        return data;
      } catch (err) {
        return {
          valid: false,
          reason: err instanceof Error ? err.message : 'Erro ao verificar conta no Zernio.',
        };
      }
    },
    [loadTikTokStatus],
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
      } else if (event.data?.type === 'ZERNIO_TIKTOK_AUTH_DONE') {
        if (event.data?.ok) {
          setTiktokNotice(
            event.data?.username
              ? `Conta @${event.data.username} conectada com sucesso via Zernio OAuth!`
              : 'Conta TikTok conectada com sucesso via Zernio OAuth!',
          );
          setTiktokError(null);
          void loadTikTokStatus();
        } else {
          setTiktokError(
            typeof event.data?.error === 'string'
              ? event.data.error
              : 'Falha na autorização do TikTok via Zernio.',
          );
        }
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
  }, [completeOAuthLogin, loadTikTokStatus, pollOnce, stopOAuthPolling]);

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
          tiktokAccounts={tiktokStatus?.accounts ?? []}
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
          accounts={tiktokStatus?.accounts ?? []}
          activeAccountId={tiktokStatus?.activeAccountId ?? null}
          loading={tiktokLoading}
          error={tiktokError}
          notice={tiktokNotice}
          onClearNotice={() => setTiktokNotice(null)}
          onOpenDrawer={() => setDrawerOpen(true)}
          onBackDashboard={() => setView('dashboard')}
          onLoginDiscord={() => void openDiscordOAuthPopup('login')}
          onSelectAccount={handleSelectTikTokAccount}
          onDeleteAccount={handleDeleteTikTokAccount}
          onVerifyAccount={handleVerifyTikTokAccount}
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
          tiktokAccounts={tiktokStatus?.accounts ?? []}
          managedGuilds={managedGuilds}
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
