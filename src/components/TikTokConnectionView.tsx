import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Globe,
  Menu,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  DiscordUser,
  TikTokAccountInfo,
  TikTokStatusResponse,
  ZernioPostHistoryItem,
  ZernioPostStatus,
} from '../types';

interface TikTokConnectionViewProps {
  authenticated: boolean;
  user: DiscordUser | null;
  tiktokStatus: TikTokStatusResponse | null;
  accounts?: TikTokAccountInfo[];
  activeAccountId?: string | null;
  loading: boolean;
  error: string | null;
  notice?: string | null;
  onClearNotice?: () => void;
  onOpenDrawer: () => void;
  onBackDashboard: () => void;
  onLoginDiscord: () => void;
  onSelectAccount?: (accountId: string) => Promise<void>;
  onDeleteAccount?: (accountId: string) => Promise<void>;
  onVerifyAccount?: (accountId: string) => Promise<{ valid: boolean; reason?: string }>;
  onDisconnectTikTok: () => void;
  onRefreshStatus: () => void;
}

function getPostStatusBadge(status: ZernioPostStatus): { label: string; classes: string } {
  switch (status) {
    case 'published':
      return { label: 'Publicado', classes: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
    case 'draft':
      return { label: 'Rascunho', classes: 'bg-slate-100 text-slate-700 border-slate-200' };
    case 'partial':
      return { label: 'Parcial', classes: 'bg-amber-50 text-amber-800 border-amber-200' };
    case 'failed':
      return { label: 'Erro', classes: 'bg-red-50 text-red-700 border-red-200' };
    case 'processing':
    default:
      return { label: 'Processando', classes: 'bg-amber-50 text-amber-800 border-amber-200' };
  }
}

export function TikTokConnectionView({
  authenticated,
  user,
  tiktokStatus,
  accounts = [],
  activeAccountId,
  loading,
  error,
  notice,
  onClearNotice,
  onOpenDrawer,
  onBackDashboard,
  onLoginDiscord,
  onSelectAccount,
  onDeleteAccount,
  onVerifyAccount,
  onDisconnectTikTok,
  onRefreshStatus,
}: TikTokConnectionViewProps) {
  const rawAccountsList =
    accounts.length > 0
      ? accounts
      : tiktokStatus?.accounts && tiktokStatus.accounts.length > 0
        ? tiktokStatus.accounts
        : tiktokStatus?.account
          ? [tiktokStatus.account]
          : [];

  const accountsMap = new Map<string, TikTokAccountInfo>();
  for (const acc of rawAccountsList) {
    const key = acc.id || acc.zernioAccountId || acc.username;
    if (key && !accountsMap.has(key)) {
      accountsMap.set(key, acc);
    }
  }
  const accountsList = Array.from(accountsMap.values());

  const currentActiveId =
    activeAccountId ||
    tiktokStatus?.activeAccountId ||
    accountsList.find((a) => a.isDefault)?.id ||
    accountsList[0]?.id ||
    null;

  const [showConnectPanel, setShowConnectPanel] = useState(accountsList.length === 0);
  const [connectingZernio, setConnectingZernio] = useState(false);
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [zernioError, setZernioError] = useState<string | null>(null);

  // Account operations state
  const [verifyingAccountId, setVerifyingAccountId] = useState<string | null>(null);
  const [accountValidity, setAccountValidity] = useState<Record<string, boolean>>({});
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);

  // Account feedback state
  const [verifyFeedback, setVerifyFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // EXP Post history state
  const [postHistory, setPostHistory] = useState<ZernioPostHistoryItem[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [checkingPostId, setCheckingPostId] = useState<string | null>(null);
  const [retryingPostId, setRetryingPostId] = useState<string | null>(null);

  const oauthPollTimerRef = useRef<number | null>(null);

  const stopOAuthPolling = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearInterval(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopOAuthPolling();
  }, [stopOAuthPolling]);

  const loadPostHistory = useCallback(async () => {
    if (!authenticated) return;
    setLoadingPosts(true);
    try {
      const resp = await apiFetch('/api/tiktok/posts');
      if (resp.ok) {
        const data = (await resp.json()) as { posts?: ZernioPostHistoryItem[] };
        setPostHistory(Array.isArray(data.posts) ? data.posts : []);
      }
    } catch {
      // Non-blocking
    } finally {
      setLoadingPosts(false);
    }
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) {
      void loadPostHistory();
    } else {
      setPostHistory([]);
    }
  }, [authenticated, loadPostHistory]);

  const isConnected = accountsList.length > 0;
  const isZernioConfigured = tiktokStatus?.configured ?? false;

  const handleConnectZernio = async () => {
    stopOAuthPolling();
    onClearNotice?.();
    setConnectingZernio(true);
    setZernioError(null);
    setPendingAuthUrl(null);
    setVerifyFeedback(null);

    try {
      const resp = await apiFetch('/api/tiktok/accounts/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        state?: string;
        error?: string;
      };

      if (!resp.ok || !data.ok || !data.url) {
        setZernioError(data.error || 'Não foi possível iniciar a conexão OAuth com o Zernio.');
        setConnectingZernio(false);
        return;
      }

      setPendingAuthUrl(data.url);
      const popup = window.open(data.url, 'zernio_tiktok_oauth', 'width=600,height=760');
      if (!popup) {
        // Fallback: browser blocked popup inside iframe — keep direct link visible and try _blank
        setZernioError(
          'Pop-up bloqueado pelo navegador. Clique no botão "Abrir página de autorização do TikTok" abaixo.',
        );
      }

      if (data.state) {
        const stateToken = data.state;
        const startedAt = Date.now();
        oauthPollTimerRef.current = window.setInterval(() => {
          if (Date.now() - startedAt > 5 * 60 * 1000) {
            stopOAuthPolling();
            setConnectingZernio(false);
            return;
          }
          void (async () => {
            try {
              const pollResp = await apiFetch(
                `/api/tiktok/oauth/poll?state=${encodeURIComponent(stateToken)}`,
              );
              if (!pollResp.ok) return;
              const pollData = (await pollResp.json()) as {
                completed: boolean;
                status?: 'success' | 'error';
                account?: TikTokAccountInfo | null;
                error?: string | null;
              };
              if (!pollData.completed) return;

              stopOAuthPolling();
              setConnectingZernio(false);
              setPendingAuthUrl(null);

              if (pollData.status === 'success') {
                setShowConnectPanel(false);
                setVerifyFeedback({
                  type: 'success',
                  text: pollData.account?.username
                    ? `Conta @${pollData.account.username} conectada com sucesso via Zernio OAuth!`
                    : 'Conta TikTok conectada com sucesso via Zernio OAuth!',
                });
                onRefreshStatus();
              } else {
                setZernioError(pollData.error || 'Autorização recusada ou expirada.');
              }
            } catch {
              // Retry on next interval
            }
          })();
        }, 1500);
      } else {
        setConnectingZernio(false);
      }
    } catch (err) {
      setZernioError(err instanceof Error ? err.message : 'Falha na conexão com Zernio.');
      setConnectingZernio(false);
    }
  };

  const handleSelectDefault = async (account: TikTokAccountInfo) => {
    const id = account.id || account.zernioAccountId || account.username;
    if (!id || !onSelectAccount) return;
    setSettingDefaultId(id);
    try {
      await onSelectAccount(id);
      setVerifyFeedback({
        type: 'success',
        text: `Conta @${account.username} definida como principal para novas publicações do canal #exp.`,
      });
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Não foi possível alterar a conta padrão.',
      });
    } finally {
      setSettingDefaultId(null);
    }
  };

  const handleVerifyAccount = async (account: TikTokAccountInfo) => {
    const id = account.id || account.zernioAccountId || account.username;
    if (!id) return;
    setVerifyingAccountId(id);
    setVerifyFeedback(null);
    try {
      if (onVerifyAccount) {
        const res = await onVerifyAccount(id);
        setAccountValidity((prev) => ({ ...prev, [id]: res.valid }));
        if (res.valid) {
          setVerifyFeedback({
            type: 'success',
            text: `Autorização da conta @${account.username} ativa e validada no Zernio!`,
          });
        } else {
          setVerifyFeedback({
            type: 'error',
            text: res.reason || `Autorização expirada para @${account.username}. Reconecte via Zernio.`,
          });
        }
      }
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Erro de comunicação ao verificar conta no Zernio.',
      });
    } finally {
      setVerifyingAccountId(null);
    }
  };

  const handleDeleteAccount = async (account: TikTokAccountInfo) => {
    const id = account.id || account.zernioAccountId || account.username;
    if (!id) return;
    const confirmName = account.displayName || `@${account.username}`;
    if (!window.confirm(`Deseja realmente desconectar a conta ${confirmName}?`)) {
      return;
    }
    setDeletingAccountId(id);
    try {
      if (onDeleteAccount) {
        await onDeleteAccount(id);
      } else {
        onDisconnectTikTok();
      }
      setVerifyFeedback({
        type: 'success',
        text: `Conta ${confirmName} desconectada com sucesso.`,
      });
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Falha ao desconectar conta.',
      });
    } finally {
      setDeletingAccountId(null);
    }
  };

  const handleCheckPostStatus = async (postId: string) => {
    setCheckingPostId(postId);
    try {
      const resp = await apiFetch(`/api/tiktok/posts/${encodeURIComponent(postId)}/status`);
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!resp.ok || !data.ok) {
        setVerifyFeedback({
          type: 'error',
          text: data.error || 'Não foi possível consultar o status da publicação.',
        });
      }
      await loadPostHistory();
    } finally {
      setCheckingPostId(null);
    }
  };

  const handleRetryPost = async (postId: string) => {
    setRetryingPostId(postId);
    try {
      const resp = await apiFetch(`/api/tiktok/posts/${encodeURIComponent(postId)}/retry`, {
        method: 'POST',
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!resp.ok || !data.ok) {
        setVerifyFeedback({
          type: 'error',
          text: data.error || 'Não foi possível reenviar a publicação.',
        });
      } else {
        setVerifyFeedback({
          type: 'success',
          text: 'Reenvio solicitado ao Zernio com sucesso.',
        });
      }
      await loadPostHistory();
    } finally {
      setRetryingPostId(null);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#FAFAFA] flex flex-col">
      {/* Top Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[1160px] mx-auto px-6 py-4 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onOpenDrawer}
              aria-label="Abrir menu lateral"
              className="w-10 h-10 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 inline-flex items-center justify-center shrink-0 transition-colors"
            >
              <Menu className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onBackDashboard}
              className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 hover:opacity-80 transition-opacity"
            >
              Aph Bot Manager
            </button>
          </div>

          <nav
            aria-label="Navegação atual"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
          >
            <button
              type="button"
              onClick={onBackDashboard}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Servidores
            </button>
            <span className="text-slate-900 border-b-2 border-slate-900 py-1 whitespace-nowrap shrink-0 font-semibold">
              Contas TikTok (Zernio API)
            </span>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onBackDashboard}
              className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Voltar</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 w-full max-w-[960px] mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        {/* Title & Top Action Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Contas TikTok — Zernio API
              </h1>
              <span className="text-xs bg-emerald-50 text-emerald-800 font-mono px-2 py-0.5 rounded border border-emerald-200">
                OAuth 2.0 / Zernio
              </span>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Conecte contas TikTok via OAuth do Zernio. Todas as publicações são realizadas exclusivamente pelo sistema EXP após aprovação administrativa.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowConnectPanel(!showConnectPanel)}
              className="min-h-[38px] px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Conectar TikTok</span>
            </button>

            <button
              type="button"
              onClick={() => {
                onRefreshStatus();
                void loadPostHistory();
              }}
              disabled={loading || loadingPosts}
              className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading || loadingPosts ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>Atualizar</span>
            </button>
          </div>
        </div>

        {/* ZERNIO_API_KEY configuration notice */}
        {tiktokStatus && !isZernioConfigured && (
          <div
            role="alert"
            className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 text-sm text-amber-900"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <strong>ZERNIO_API_KEY não configurada no servidor.</strong> Defina a variável de ambiente{' '}
              <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">ZERNIO_API_KEY</code>{' '}
              no backend para ativar a conexão OAuth e a publicação de vídeos.
            </div>
          </div>
        )}

        {/* Redirect / OAuth Notice */}
        {notice && (
          <div
            role="status"
            className="flex items-center justify-between gap-2.5 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5 text-sm text-emerald-800"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{notice}</span>
            </div>
            {onClearNotice && (
              <button
                type="button"
                onClick={onClearNotice}
                aria-label="Fechar aviso"
                className="text-emerald-700 hover:text-emerald-900 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Global Error Banner */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-5 py-3.5 text-sm text-red-700"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Verify / Publish Feedback Banner */}
        {verifyFeedback && (
          <div
            role={verifyFeedback.type === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2.5 rounded-xl px-5 py-3.5 text-sm border ${
              verifyFeedback.type === 'error'
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            {verifyFeedback.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            )}
            <span>{verifyFeedback.text}</span>
          </div>
        )}

        {/* Discord login prerequisite */}
        {!authenticated || !user ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              Conecte sua conta Discord primeiro
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              As contas TikTok conectadas via Zernio são vinculadas com segurança ao seu usuário autenticado do Discord.
            </p>
            <button
              type="button"
              onClick={onLoginDiscord}
              className="min-h-[42px] px-5 py-2.5 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <span>Conectar com Discord</span>
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 1. Estado da Conexão */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Estado da Conexão (Zernio API)
                  </div>
                  {isConnected ? (
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                      </span>
                      <span className="text-base font-semibold text-emerald-800">
                        {accountsList.length} {accountsList.length === 1 ? 'conta conectada' : 'contas conectadas'} (Zernio OAuth)
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-slate-500">
                      <CircleSlash className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-medium">Nenhuma conta TikTok conectada</span>
                    </div>
                  )}
                  <p className="text-xs text-slate-500">
                    {isConnected
                      ? 'Autorização OAuth gerenciada pelo Zernio. Vídeos aprovados são encaminhados para a conta selecionada.'
                      : 'Conecte sua conta TikTok através do fluxo OAuth seguro do Zernio.'}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowConnectPanel(!showConnectPanel)}
                    className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{showConnectPanel ? 'Fechar Painel' : 'Conectar TikTok'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 2. Lista de Contas Conectadas */}
            <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900">
                    Lista de Contas Conectadas
                  </h2>
                  <span className="text-xs bg-slate-100 text-slate-700 font-semibold px-2 py-0.5 rounded-full">
                    {accountsList.length}
                  </span>
                </div>
                {accountsList.length > 0 && (
                  <span className="text-xs text-slate-500 hidden sm:inline">
                    Utilizadas automaticamente nas publicações do sistema #exp
                  </span>
                )}
              </div>

              {accountsList.length === 0 ? (
                <div className="text-center py-10 px-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 space-y-3">
                  <div className="w-12 h-12 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center mx-auto">
                    <User className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Nenhuma conta TikTok conectada
                    </h3>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto">
                      Conecte sua conta clicando no botão abaixo para autorizar via OAuth do Zernio.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowConnectPanel(true)}
                    className="min-h-[38px] px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Conectar TikTok com Zernio</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {accountsList.map((acc) => {
                    const id = acc.id || acc.zernioAccountId || acc.username;
                    const isDefault = acc.isDefault || id === currentActiveId;
                    const isValid =
                      accountValidity[id] !== undefined
                        ? accountValidity[id]
                        : acc.status === 'connected';
                    const isVerifying = verifyingAccountId === id;
                    const isSettingDefault = settingDefaultId === id;
                    const isDeleting = deletingAccountId === id;

                    return (
                      <div
                        key={id}
                        className={`p-4 sm:p-5 rounded-xl border transition-all ${
                          isDefault
                            ? 'bg-slate-50/80 border-slate-300 ring-1 ring-slate-900/10'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                            {acc.avatarUrl ? (
                              <img
                                src={acc.avatarUrl}
                                alt={acc.displayName || acc.username}
                                referrerPolicy="no-referrer"
                                className="w-12 h-12 rounded-full border border-slate-200 object-cover shrink-0 shadow-sm"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-full bg-slate-900 text-white font-bold text-sm flex items-center justify-center shrink-0">
                                {(acc.displayName || acc.username || 'TK').slice(0, 2).toUpperCase()}
                              </div>
                            )}

                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-bold text-slate-900 truncate">
                                  {acc.displayName || acc.username}
                                </span>
                                <span className="text-xs font-mono text-slate-500">
                                  @{acc.username}
                                </span>

                                {isDefault && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-slate-900 text-white px-2 py-0.5 rounded-md">
                                    <Star className="w-3 h-3 fill-current" />
                                    <span>Padrão</span>
                                  </span>
                                )}

                                <span
                                  className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border ${
                                    isValid
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                      : 'bg-amber-50 text-amber-800 border-amber-200'
                                  }`}
                                >
                                  {isValid ? (
                                    <>
                                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                      <span>Conectada</span>
                                    </>
                                  ) : (
                                    <>
                                      <AlertCircle className="w-3 h-3 text-amber-600" />
                                      <span>
                                        {acc.status === 'revoked' ? 'Revogada' : 'Autorização Expirada'}
                                      </span>
                                    </>
                                  )}
                                </span>
                              </div>

                              <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                                <span>
                                  Plataforma: <strong className="text-slate-700">TikTok (Zernio)</strong>
                                </span>
                                {acc.connectedAt && (
                                  <>
                                    <span>•</span>
                                    <span>
                                      Conectada em {new Date(acc.connectedAt).toLocaleDateString('pt-BR')}
                                    </span>
                                  </>
                                )}
                              </div>
                              {acc.healthIssues && acc.healthIssues.length > 0 && (
                                <div className="text-[11px] text-amber-700">
                                  {acc.healthIssues.join(' · ')}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 shrink-0 self-end sm:self-center">
                            {!isValid && (
                              <button
                                type="button"
                                onClick={() => void handleConnectZernio()}
                                className="min-h-[34px] px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Reconectar</span>
                              </button>
                            )}

                            {!isDefault && onSelectAccount && (
                              <button
                                type="button"
                                onClick={() => void handleSelectDefault(acc)}
                                disabled={isSettingDefault || isVerifying || isDeleting}
                                className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                              >
                                <Star className="w-3.5 h-3.5 text-slate-400" />
                                <span>{isSettingDefault ? 'Definindo...' : 'Definir como Padrão'}</span>
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => void handleVerifyAccount(acc)}
                              disabled={isVerifying || isDeleting}
                              className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <ShieldCheck
                                className={`w-3.5 h-3.5 text-emerald-600 ${isVerifying ? 'animate-spin' : ''}`}
                              />
                              <span>{isVerifying ? 'Verificando...' : 'Verificar Status'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => void handleDeleteAccount(acc)}
                              disabled={isDeleting || isVerifying}
                              className="min-h-[34px] px-3 py-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-xs font-medium text-red-700 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>{isDeleting ? 'Removendo...' : 'Desconectar'}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 3. Painel OAuth Zernio */}
            {showConnectPanel && (
              <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-8 space-y-6 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Conectar TikTok via Zernio OAuth
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Clique abaixo para iniciar a autorização oficial no TikTok através do Zernio.
                    </p>
                  </div>
                  {accountsList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowConnectPanel(false)}
                      className="text-slate-400 hover:text-slate-600 p-1"
                      aria-label="Fechar painel"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  )}
                </div>

                {zernioError && (
                  <div
                    role="alert"
                    className="bg-red-50 border border-red-200 rounded-xl p-3.5 text-xs text-red-700 flex items-start gap-2.5"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="font-medium leading-relaxed">{zernioError}</span>
                  </div>
                )}

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center space-y-4 max-w-lg mx-auto">
                  <div className="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center mx-auto shadow-sm">
                    <Globe className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-slate-900">
                      Autorização Segura Zernio
                    </h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      O Zernio gerencia a autenticação OAuth do TikTok de forma segura. Nenhuma senha ou cookie é solicitado ou armazenado em nossos servidores.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleConnectZernio()}
                    disabled={connectingZernio || !isZernioConfigured}
                    className="w-full min-h-[44px] px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors shadow-sm"
                  >
                    {connectingZernio ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Aguardando autorização no TikTok...</span>
                      </>
                    ) : (
                      <>
                        <ExternalLink className="w-4 h-4" />
                        <span>Conectar TikTok</span>
                      </>
                    )}
                  </button>

                  {pendingAuthUrl && (
                    <div className="pt-2">
                      <a
                        href={pendingAuthUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-[#5865F2] hover:underline inline-flex items-center gap-1"
                      >
                        <span>Abrir página de autorização do TikTok em nova aba</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* 4. Histórico de Publicações EXP no TikTok */}
            <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900">
                    Histórico de Publicações EXP (TikTok)
                  </h2>
                  <span className="text-xs bg-slate-100 text-slate-700 font-semibold px-2 py-0.5 rounded-full">
                    {postHistory.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void loadPostHistory()}
                  disabled={loadingPosts}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingPosts ? 'animate-spin' : ''}`} />
                  <span>Atualizar lista</span>
                </button>
              </div>

              {postHistory.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">
                  Nenhuma publicação do sistema EXP registrada via Zernio até o momento.
                </p>
              ) : (
                <div className="space-y-3">
                  {postHistory.map((post) => {
                    const badge = getPostStatusBadge(post.status);
                    return (
                      <div
                        key={post.id}
                        className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-semibold text-slate-900">
                              @{post.accountUsername}
                            </span>
                            {post.expCode && (
                              <span className="font-mono text-slate-600 bg-white border border-slate-200 px-2 py-0.5 rounded">
                                {post.expCode}
                              </span>
                            )}
                            <span
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${badge.classes}`}
                            >
                              {badge.label}
                            </span>
                          </div>

                          <span className="text-[11px] text-slate-500 tabular-nums">
                            {new Date(post.createdAt).toLocaleString('pt-BR')}
                          </span>
                        </div>

                        <p className="text-xs text-slate-700 whitespace-pre-line line-clamp-2">
                          {post.caption || '(Sem legenda)'}
                        </p>

                        {post.error && (
                          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                            {post.error}
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <span className="text-[11px] font-mono text-slate-500">
                            ID: {post.zernioPostId}
                          </span>

                          <div className="flex flex-wrap items-center gap-2">
                            {post.platformPostUrl && (
                              <a
                                href={post.platformPostUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-h-[30px] px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1"
                              >
                                <Send className="w-3 h-3" />
                                <span>Ver no TikTok</span>
                              </a>
                            )}

                            {!post.zernioPostId.startsWith('fail_') && (
                              <button
                                type="button"
                                onClick={() => void handleCheckPostStatus(post.zernioPostId)}
                                disabled={checkingPostId === post.zernioPostId}
                                className="min-h-[30px] px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1 disabled:opacity-50"
                              >
                                <RefreshCw
                                  className={`w-3 h-3 ${checkingPostId === post.zernioPostId ? 'animate-spin' : ''}`}
                                />
                                <span>Consultar status</span>
                              </button>
                            )}

                            {(post.status === 'failed' || post.status === 'partial') &&
                              !post.zernioPostId.startsWith('fail_') && (
                                <button
                                  type="button"
                                  onClick={() => void handleRetryPost(post.zernioPostId)}
                                  disabled={retryingPostId === post.zernioPostId}
                                  className="min-h-[30px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1 disabled:opacity-50"
                                >
                                  <RotateCcw
                                    className={`w-3 h-3 ${retryingPostId === post.zernioPostId ? 'animate-spin' : ''}`}
                                  />
                                  <span>Tentar novamente</span>
                                </button>
                              )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
