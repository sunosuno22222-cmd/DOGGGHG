import { useState, type FormEvent } from 'react';
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
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  DiscordUser,
  TikTokAccountInfo,
  TikTokLoginResult,
  TikTokQrState,
  TikTokStatusResponse,
} from '../types';

interface TikTokConnectionViewProps {
  authenticated: boolean;
  user: DiscordUser | null;
  tiktokStatus: TikTokStatusResponse | null;
  accounts?: TikTokAccountInfo[];
  activeAccountId?: string | null;
  qrState: TikTokQrState | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  onOpenDrawer: () => void;
  onBackDashboard: () => void;
  onLoginDiscord: () => void;
  onSelectAccount?: (accountId: string) => Promise<void>;
  onDeleteAccount?: (accountId: string) => Promise<void>;
  onVerifyAccount?: (accountId: string) => Promise<{ valid: boolean; reason?: string }>;
  onDisconnectTikTok: () => void;
  onRefreshStatus: () => void;
}

export function TikTokConnectionView({
  authenticated,
  user,
  tiktokStatus,
  accounts = [],
  activeAccountId,
  loading,
  error,
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
    const key = acc.id || acc.accountKey || acc.username;
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
  const [zernioError, setZernioError] = useState<string | null>(null);

  // Account operations state
  const [verifyingAccountId, setVerifyingAccountId] = useState<string | null>(null);
  const [accountValidity, setAccountValidity] = useState<Record<string, boolean>>({});
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);

  // Global test publish
  const [publishingTest, setPublishingTest] = useState(false);
  const [verifyFeedback, setVerifyFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const isConnected = accountsList.length > 0;

  const handleConnectZernio = async () => {
    setConnectingZernio(true);
    setZernioError(null);
    try {
      const resp = await apiFetch('/api/tiktok/accounts/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        account?: TikTokAccountInfo;
      };

      if (!resp.ok || !data.ok) {
        setZernioError(data.error || 'Não foi possível iniciar a conexão OAuth com o Zernio.');
      } else if (data.url) {
        window.location.href = data.url;
      } else {
        // Connected successfully (simulation mode)
        await onRefreshStatus();
        setShowConnectPanel(false);
        setVerifyFeedback({
          type: 'success',
          text: 'Conta TikTok conectada com sucesso via Zernio API!',
        });
      }
    } catch (err) {
      setZernioError(err instanceof Error ? err.message : 'Falha na conexão com Zernio.');
    } finally {
      setConnectingZernio(false);
    }
  };

  const handleSelectDefault = async (account: TikTokAccountInfo) => {
    const id = account.id || account.accountKey || account.username;
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
    const id = account.id || account.accountKey || account.username;
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
            text: `Sessão da conta @${account.username} verificada e ativa no Zernio!`,
          });
        } else {
          setVerifyFeedback({
            type: 'error',
            text: res.reason || `Sessão expirada para @${account.username}. Reconecte via Zernio.`,
          });
        }
      }
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Erro de comunicação ao verificar conta.',
      });
    } finally {
      setVerifyingAccountId(null);
    }
  };

  const handleDeleteAccount = async (account: TikTokAccountInfo) => {
    const id = account.id || account.accountKey || account.username;
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

  const handlePublishTestPost = async () => {
    setPublishingTest(true);
    setVerifyFeedback(null);
    try {
      const resp = await apiFetch('/api/tiktok/test-publish', { method: 'POST' });
      const data = (await resp.json().catch(() => ({}))) as {
        outcome?: string;
        statusText?: string;
        error?: string;
        trackArtist?: string | null;
        trackTitle?: string | null;
      };
      const trackNote =
        data.trackArtist && data.trackTitle
          ? ` Trilha: ${data.trackArtist} — ${data.trackTitle}.`
          : '';
      if (resp.ok && data.outcome === 'published') {
        setVerifyFeedback({
          type: 'success',
          text: `${data.statusText || 'Publicação de teste enviada via Zernio!'}${trackNote}`,
        });
      } else {
        setVerifyFeedback({
          type: 'error',
          text: `${data.error || data.statusText || 'Falha na publicação de teste.'}${trackNote}`,
        });
      }
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Erro de conexão ao tentar publicar o teste.',
      });
    } finally {
      setPublishingTest(false);
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
              Conecte sua conta do TikTok de forma segura via Zernio OAuth. O bot publicará as ocorrências aprovadas automaticamente no canal #exp.
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

            {isConnected && (
              <button
                type="button"
                onClick={() => void handlePublishTestPost()}
                disabled={publishingTest || loading}
                title="Publicar ocorrência de teste com áudio no TikTok via Zernio"
                className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                <span>{publishingTest ? 'Publicando...' : 'Publicar Teste'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onRefreshStatus}
              disabled={loading}
              className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>Atualizar</span>
            </button>
          </div>
        </div>

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

        {/* Verify Feedback Banner */}
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
            {/* ========================================================= */}
            {/* 1. INDICADOR DE CONEXÃO & RESUMO GERAL                    */}
            {/* ========================================================= */}
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
                        {accountsList.length} {accountsList.length === 1 ? 'conta conectada' : 'contas conectadas'} (Zernio Ativo)
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
                      ? 'Autorização OAuth gerenciada pelo Zernio. Vídeos aprovados são publicados na conta padrão selecionada.'
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

            {/* ========================================================= */}
            {/* 2. LISTA DE CONTAS CONECTADAS                            */}
            {/* ========================================================= */}
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
                    Disponíveis no seletor de publicação de ocorrências (EXP)
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
                      Conecte sua conta utilizando o botão abaixo para iniciar o OAuth do Zernio.
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
                    const id = acc.id || acc.accountKey || acc.username;
                    const isDefault = acc.isDefault || id === currentActiveId;
                    const isValid =
                      accountValidity[id] !== undefined
                        ? accountValidity[id]
                        : acc.status !== 'expired';
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
                          {/* Account details */}
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
                                      <span>Conectado (Zernio OAuth)</span>
                                    </>
                                  ) : (
                                    <>
                                      <AlertCircle className="w-3 h-3 text-amber-600" />
                                      <span>Autorização Expirada</span>
                                    </>
                                  )}
                                </span>
                              </div>

                              <div className="text-[11px] text-slate-500 flex items-center gap-2">
                                <span>Plataforma: <strong className="text-slate-700">TikTok (Zernio)</strong></span>
                                {acc.connectedAt && (
                                  <>
                                    <span>•</span>
                                    <span>Conectado em {new Date(acc.connectedAt).toLocaleDateString()}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                            {!isDefault && onSelectAccount && (
                              <button
                                type="button"
                                onClick={() => void handleSelectDefault(acc)}
                                disabled={isSettingDefault || isVerifying || isDeleting}
                                title="Definir esta conta como destino padrão"
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
                              title="Testar a validade da conexão no Zernio"
                              className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                            >
                              <ShieldCheck
                                className={`w-3.5 h-3.5 text-emerald-600 ${isVerifying ? 'animate-spin' : ''}`}
                              />
                              <span>{isVerifying ? 'Testando...' : 'Testar Conexão'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => void handleDeleteAccount(acc)}
                              disabled={isDeleting || isVerifying}
                              title="Desconectar esta conta"
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

            {/* ========================================================= */}
            {/* 3. PAINEL DE CONEXÃO OAUTH ZERNIO                          */}
            {/* ========================================================= */}
            {showConnectPanel && (
              <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-8 space-y-6 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Conectar TikTok via Zernio OAuth
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Clique no botão abaixo para autorizar a conexão com sua conta TikTok através da API oficial do Zernio.
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
                    disabled={connectingZernio}
                    className="w-full min-h-[44px] px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors shadow-sm"
                  >
                    {connectingZernio ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Abrindo autorização Zernio...</span>
                      </>
                    ) : (
                      <>
                        <ExternalLink className="w-4 h-4" />
                        <span>Conectar Conta TikTok com Zernio</span>
                      </>
                    )}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
