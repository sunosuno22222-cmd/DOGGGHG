import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleSlash,
  Cookie,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Info,
  Lock,
  LogOut,
  Mail,
  Menu,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  DiscordUser,
  TikTokLoginResult,
  TikTokQrState,
  TikTokStatusResponse,
} from '../types';

type LoginTab = 'qrcode' | 'credentials' | 'cookie' | 'webhook';

interface TikTokConnectionViewProps {
  authenticated: boolean;
  user: DiscordUser | null;
  tiktokStatus: TikTokStatusResponse | null;
  qrState: TikTokQrState | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  onOpenDrawer: () => void;
  onBackDashboard: () => void;
  onLoginDiscord: () => void;
  onConnectCredentials: (credentials: {
    usernameOrEmail: string;
    password: string;
  }) => Promise<TikTokLoginResult>;
  onSubmit2Fa: (params: { sessionId: string; code: string }) => Promise<TikTokLoginResult>;
  onCancel2Fa: (sessionId: string) => Promise<void>;
  onConnectCookie: (params: {
    sessionId: string;
    datacenter?: string;
  }) => Promise<TikTokLoginResult>;
  onConnectWebhook: (params: {
    username: string;
    webhookUrl: string;
    apiKey?: string;
  }) => Promise<TikTokLoginResult>;
  onConnectTikTokQr: () => void;
  onForceCompleteQr: (username?: string) => Promise<TikTokLoginResult>;
  onCancelQr: () => void;
  onDisconnectTikTok: () => void;
  onRefreshStatus: () => void;
}

export function TikTokConnectionView({
  authenticated,
  user,
  tiktokStatus,
  qrState,
  loading,
  connecting,
  error,
  onOpenDrawer,
  onBackDashboard,
  onLoginDiscord,
  onConnectCredentials,
  onSubmit2Fa,
  onCancel2Fa,
  onConnectCookie,
  onConnectWebhook,
  onConnectTikTokQr,
  onForceCompleteQr,
  onCancelQr,
  onDisconnectTikTok,
  onRefreshStatus,
}: TikTokConnectionViewProps) {
  // Mobile users love the QR gallery trick and E-mail/Senha
  const [activeTab, setActiveTab] = useState<LoginTab>('qrcode');

  // Credentials form state
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submittingCredentials, setSubmittingCredentials] = useState(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);

  // 2FA state
  const [twoFaActive, setTwoFaActive] = useState(false);
  const [twoFaSessionId, setTwoFaSessionId] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaMessage, setTwoFaMessage] = useState<string | null>(null);
  const [submitting2Fa, setSubmitting2Fa] = useState(false);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);

  // Cookie form state
  const [sessionCookie, setSessionCookie] = useState('');
  const [submittingCookie, setSubmittingCookie] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [showCookieGuide, setShowCookieGuide] = useState(false);

  // Webhook / Online Provider form state
  const [webhookUsername, setWebhookUsername] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookApiKey, setWebhookApiKey] = useState('');
  const [submittingWebhook, setSubmittingWebhook] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  // Force QR complete state
  const [forceUsername, setForceUsername] = useState('');
  const [submittingForce, setSubmittingForce] = useState(false);

  // Session verification feedback
  const [verifying, setVerifying] = useState(false);
  const [verifyFeedback, setVerifyFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const connected = Boolean(tiktokStatus?.connected && tiktokStatus?.account);
  const account = tiktokStatus?.account ?? null;

  const handleForceComplete = async () => {
    setSubmittingForce(true);
    try {
      await onForceCompleteQr(forceUsername.trim() || undefined);
    } finally {
      setSubmittingForce(false);
    }
  };

  // Mobile QR code helper actions
  const handleDownloadQr = () => {
    if (!qrState?.qrImageUrl) return;
    const a = document.createElement('a');
    a.href = qrState.qrImageUrl;
    a.download = 'tiktok_qr_code.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenTikTokApp = () => {
    // Attempt deep link to TikTok mobile app
    window.location.href = 'tiktok://';
    setTimeout(() => {
      window.open('https://www.tiktok.com', '_blank');
    }, 800);
  };

  // Submit E-mail & Senha
  const handleCredentialsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanUser = usernameOrEmail.trim();
    const cleanPass = password;

    if (!cleanUser) {
      setCredentialsError('Informe seu e-mail ou @nome_de_usuario do TikTok.');
      return;
    }
    if (!cleanPass) {
      setCredentialsError('Informe a senha da sua conta TikTok.');
      return;
    }

    setSubmittingCredentials(true);
    setCredentialsError(null);

    try {
      const result = await onConnectCredentials({
        usernameOrEmail: cleanUser,
        password: cleanPass,
      });

      if (result.requires2Fa && result.sessionId) {
        setTwoFaActive(true);
        setTwoFaSessionId(result.sessionId);
        setTwoFaMessage(
          result.message ||
            'O TikTok enviou um código de verificação para seu e-mail ou telefone.',
        );
        setTwoFaCode('');
        setTwoFaError(null);
      } else if (!result.ok) {
        setCredentialsError(
          result.error ||
            'Não foi possível autenticar no TikTok. Se sua conta foi criada pelo Google (Gmail) ou telefone, use o método QR Code no Celular ou cadastre uma senha no app do TikTok.',
        );
      } else {
        // Connected successfully!
        setPassword('');
        setTwoFaActive(false);
        setTwoFaSessionId(null);
      }
    } catch (err) {
      setCredentialsError(
        err instanceof Error ? err.message : 'Falha na conexão com o TikTok.',
      );
    } finally {
      setSubmittingCredentials(false);
    }
  };

  // Submit 2FA code
  const handle2FaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!twoFaSessionId) return;

    const cleanCode = twoFaCode.trim();
    if (!cleanCode) {
      setTwoFaError('Digite o código de verificação recebido.');
      return;
    }

    setSubmitting2Fa(true);
    setTwoFaError(null);

    try {
      const result = await onSubmit2Fa({
        sessionId: twoFaSessionId,
        code: cleanCode,
      });

      if (!result.ok) {
        setTwoFaError(
          result.error ||
            'Código inválido ou expirado. Verifique os dígitos e tente novamente.',
        );
      } else {
        setTwoFaActive(false);
        setTwoFaSessionId(null);
        setTwoFaCode('');
        setPassword('');
      }
    } catch (err) {
      setTwoFaError(
        err instanceof Error ? err.message : 'Erro ao validar código 2FA.',
      );
    } finally {
      setSubmitting2Fa(false);
    }
  };

  // Cancel 2FA
  const handle2FaCancel = async () => {
    if (twoFaSessionId) {
      await onCancel2Fa(twoFaSessionId).catch(() => {});
    }
    setTwoFaActive(false);
    setTwoFaSessionId(null);
    setTwoFaCode('');
    setTwoFaError(null);
  };

  // Submit Session Cookie
  const handleCookieSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanSession = sessionCookie.trim();

    if (!cleanSession) {
      setCookieError('Cole o valor do cookie sessionid copiado do TikTok.');
      return;
    }

    setSubmittingCookie(true);
    setCookieError(null);

    try {
      const result = await onConnectCookie({ sessionId: cleanSession });
      if (!result.ok) {
        setCookieError(
          result.error ||
            'Cookie inválido ou sessão expirada no TikTok. Gere um novo cookie fazendo login no tiktok.com.',
        );
      } else {
        setSessionCookie('');
      }
    } catch (err) {
      setCookieError(
        err instanceof Error ? err.message : 'Falha ao conectar via cookie.',
      );
    } finally {
      setSubmittingCookie(false);
    }
  };

  // Submit Online Provider / Webhook
  const handleWebhookSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanUser = webhookUsername.trim().replace(/^@+/, '');
    const cleanUrl = webhookUrl.trim();

    if (!cleanUser) {
      setWebhookError('Informe o @nome_de_usuario da sua conta TikTok.');
      return;
    }
    if (!cleanUrl || !cleanUrl.startsWith('http')) {
      setWebhookError('Informe a URL completa do Webhook ou API (iniciando com https://).');
      return;
    }

    setSubmittingWebhook(true);
    setWebhookError(null);

    try {
      const result = await onConnectWebhook({
        username: cleanUser,
        webhookUrl: cleanUrl,
        apiKey: webhookApiKey.trim() || undefined,
      });

      if (!result.ok) {
        setWebhookError(result.error || 'Falha ao registrar provedor online.');
      } else {
        setWebhookUsername('');
        setWebhookUrl('');
        setWebhookApiKey('');
      }
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : 'Erro ao salvar provedor online.');
    } finally {
      setSubmittingWebhook(false);
    }
  };

  // Verify active session
  const handleVerifySession = async () => {
    setVerifying(true);
    setVerifyFeedback(null);
    try {
      const resp = await apiFetch('/api/tiktok/verify', { method: 'POST' });
      const data = (await resp.json().catch(() => ({}))) as {
        valid?: boolean;
        reason?: string;
      };
      if (resp.ok && data.valid) {
        setVerifyFeedback({
          type: 'success',
          text: 'Sessão ativa e pronta para publicação de ocorrências aprovadas!',
        });
      } else {
        setVerifyFeedback({
          type: 'error',
          text:
            data.reason ||
            'A sessão expirou no TikTok. Conecte sua conta novamente.',
        });
      }
    } catch {
      setVerifyFeedback({
        type: 'error',
        text: 'Não foi possível verificar a sessão no momento.',
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#FAFAFA] flex flex-col">
      {/* Header */}
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
            <span className="text-slate-900 border-b-2 border-slate-900 py-1 whitespace-nowrap shrink-0">
              Conexão TikTok
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

      {/* Main Content */}
      <main className="flex-1 w-full max-w-[900px] mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        {/* Title & Refresh */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Conexão TikTok
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Conecte sua conta do TikTok para que o bot publique as exposições (EXP) aprovadas automaticamente.
            </p>
          </div>

          <button
            type="button"
            onClick={onRefreshStatus}
            disabled={loading}
            className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Atualizar status</span>
          </button>
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

        {/* Must be logged in with Discord first */}
        {!authenticated || !user ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              Conecte sua conta Discord primeiro
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              A conta TikTok conectada fica vinculada com segurança ao seu usuário Discord para que o bot publique as ocorrências aprovadas no privado.
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
          <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-8 space-y-8">
            {/* Connection Status Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-200">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Estado da Conexão
                </div>
                {connected && account ? (
                  <div className="inline-flex items-center gap-2 text-base font-semibold text-emerald-700">
                    <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
                    <span>Conectado</span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-2 text-base font-semibold text-slate-600">
                    <CircleSlash className="w-5 h-5 shrink-0 text-slate-400" aria-hidden="true" />
                    <span>Desconectado</span>
                  </div>
                )}
              </div>

              {connected && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleVerifySession()}
                    disabled={verifying || loading}
                    className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap disabled:opacity-50"
                  >
                    <ShieldCheck className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                    <span>{verifying ? 'Verificando...' : 'Verificar sessão'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={onDisconnectTikTok}
                    disabled={loading}
                    className="min-h-[38px] px-3.5 py-2 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-700 text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap disabled:opacity-50"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    <span>Desconectar</span>
                  </button>
                </div>
              )}
            </div>

            {/* If Connected, Show Account Details */}
            {connected && account ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 p-5 bg-slate-50 border border-slate-200 rounded-xl">
                {account.avatarUrl ? (
                  <img
                    src={account.avatarUrl}
                    alt={account.displayName}
                    referrerPolicy="no-referrer"
                    className="w-16 h-16 rounded-full border border-slate-200 object-cover shrink-0 shadow-sm"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-slate-200 border border-slate-300 flex items-center justify-center text-lg font-bold text-slate-700 shrink-0">
                    {(account.displayName || account.username).slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 space-y-1.5 flex-1">
                  <div className="text-base font-semibold text-slate-900 truncate">
                    {account.displayName}
                  </div>
                  <div className="text-sm font-mono text-slate-700">
                    @{account.username}
                  </div>
                  <div className="text-xs text-slate-500">
                    Modo: <span className="font-semibold text-slate-700">{account.provider === 'webhook' ? 'Provedor Online (Webhook)' : 'Conexão Direta (autotok)'}</span> · Pronto para publicações do canal <span className="font-semibold text-slate-700">#exp</span>.
                  </div>
                </div>
              </div>
            ) : (
              /* If Disconnected, Show Login Tabs & Forms */
              <div className="space-y-6">
                {/* Method Navigation Tabs */}
                <div className="flex flex-wrap border-b border-slate-200 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('qrcode');
                      if (!qrState || qrState.status === 'idle') {
                        onConnectTikTokQr();
                      }
                    }}
                    className={`pb-3 px-3 text-sm font-medium transition-colors border-b-2 inline-flex items-center gap-2 ${
                      activeTab === 'qrcode'
                        ? 'border-slate-900 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Smartphone className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                    <span>QR Code no Celular</span>
                    <span className="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-normal">
                      100% no Celular
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('credentials');
                      setCredentialsError(null);
                    }}
                    className={`pb-3 px-3 text-sm font-medium transition-colors border-b-2 inline-flex items-center gap-2 ${
                      activeTab === 'credentials'
                        ? 'border-slate-900 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Mail className="w-4 h-4" aria-hidden="true" />
                    <span>E-mail / Usuário e Senha</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('webhook');
                      setWebhookError(null);
                    }}
                    className={`pb-3 px-3 text-sm font-medium transition-colors border-b-2 inline-flex items-center gap-2 ${
                      activeTab === 'webhook'
                        ? 'border-slate-900 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Globe className="w-4 h-4" aria-hidden="true" />
                    <span>Provedor Online (Webhook)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('cookie');
                      setCookieError(null);
                    }}
                    className={`pb-3 px-3 text-sm font-medium transition-colors border-b-2 inline-flex items-center gap-2 ${
                      activeTab === 'cookie'
                        ? 'border-slate-900 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Cookie className="w-4 h-4" aria-hidden="true" />
                    <span>Cookie de Sessão</span>
                  </button>
                </div>

                {/* ========================================================= */}
                {/* TAB 1: QR CODE NO CELULAR (ÁLBUM / GALERIA)               */}
                {/* ========================================================= */}
                {activeTab === 'qrcode' && (
                  <div className="space-y-6">
                    {/* Mobile Friendly Callout */}
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-xs text-emerald-950 space-y-2">
                      <div className="flex items-center gap-2 font-bold text-emerald-900 text-sm">
                        <Sparkles className="w-4 h-4 text-emerald-700" />
                        <span>Como conectar no MESMO celular (sem precisar de outro aparelho ou computador):</span>
                      </div>
                      <p className="leading-relaxed">
                        O leitor de QR Code dentro do aplicativo do TikTok permite escanear fotos do seu próprio celular! Siga os 4 passos abaixo:
                      </p>
                      <ol className="list-decimal list-inside space-y-1.5 font-medium text-emerald-900">
                        <li>
                          Toque no botão <strong>Baixar QR Code</strong> abaixo (ou tire um print da tela com o código).
                        </li>
                        <li>
                          Toque no botão <strong>Abrir App do TikTok</strong>.
                        </li>
                        <li>
                          No TikTok: vá em <strong>Perfil</strong> &rarr; menu no topo (☰) &rarr; <strong>Meu código QR</strong> &rarr; toque no <strong>ícone de scanner</strong> no canto superior direito.
                        </li>
                        <li>
                          Na tela da câmera do scanner, toque em <strong>Álbum / Galeria</strong> (ícone de fotos) e selecione o print do QR Code!
                        </li>
                        <li>
                          O TikTok lê a imagem na hora e pergunta: <em>"Fazer login no computador?"</em> Toque em <strong>Confirmar</strong>!
                        </li>
                      </ol>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-[250px_1fr] gap-6 items-center bg-slate-50 border border-slate-200 rounded-xl p-5 sm:p-6">
                      {/* QR Display */}
                      <div className="flex flex-col items-center justify-center bg-white border border-slate-200 rounded-xl p-4 min-h-[240px] text-center">
                        {qrState?.qrImageUrl ? (
                          <>
                            <img
                              src={qrState.qrImageUrl}
                              alt="QR Code oficial de login do TikTok"
                              referrerPolicy="no-referrer"
                              className="w-48 h-48 rounded-lg p-1 object-contain"
                            />
                            <span className="text-[11px] text-slate-500 mt-2 font-mono">
                              QR Code oficial do TikTok
                            </span>
                          </>
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-center text-xs text-slate-500 py-8">
                            <RefreshCw className="w-7 h-7 animate-spin text-slate-400" aria-hidden="true" />
                            <span>{connecting ? 'Gerando QR Code oficial...' : 'Aguardando início...'}</span>
                          </div>
                        )}
                      </div>

                      {/* Action buttons & status */}
                      <div className="space-y-4">
                        <div>
                          <h3 className="text-base font-semibold text-slate-900">
                            Ações Rápidas no Celular
                          </h3>
                          <div className="text-xs font-medium text-slate-600 mt-1">
                            {qrState?.status === 'scanned_confirming' && (
                              <span className="text-emerald-700 font-semibold text-sm">
                                ✓ QR Code lido com sucesso! Toque em "Confirmar" no seu TikTok para concluir.
                              </span>
                            )}
                            {qrState?.status === 'pending_qr' && (
                              <span>Aguardando você selecionar o QR Code no app do TikTok...</span>
                            )}
                            {qrState?.status === 'expired' && (
                              <span className="text-amber-700 font-semibold">
                                O QR Code expirou. Toque em "Atualizar QR Code" abaixo para gerar um novo.
                              </span>
                            )}
                            {(!qrState || qrState.status === 'initializing') && (
                              <span>Carregando sessão segura do TikTok...</span>
                            )}
                          </div>
                        </div>

                        {/* Force complete helper if stuck on confirming */}
                        <div className="bg-emerald-50/80 border border-emerald-200 rounded-lg p-3.5 text-xs text-emerald-950 space-y-2">
                          <div className="font-semibold flex items-center gap-1.5 text-emerald-900">
                            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                            <span>Já tocou em Confirmar no celular mas continuou aqui?</span>
                          </div>
                          <p className="text-[11px] text-emerald-800 leading-relaxed">
                            Se o TikTok confirmou no seu celular mas a tela não atualizou devido a restrições de segurança do navegador, informe seu usuário abaixo e clique em conectar instantaneamente:
                          </p>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <input
                              type="text"
                              value={forceUsername}
                              onChange={(e) => setForceUsername(e.target.value)}
                              placeholder="@seu_usuario_tiktok"
                              className="px-3 py-1.5 rounded border border-emerald-300 text-xs bg-white w-44 focus:outline-none focus:ring-1 focus:ring-emerald-700"
                            />
                            <button
                              type="button"
                              onClick={() => void handleForceComplete()}
                              disabled={submittingForce}
                              className="min-h-[34px] px-4 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold inline-flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                            >
                              {submittingForce ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              )}
                              <span>Conectar Conta Agora</span>
                            </button>
                          </div>
                        </div>

                        {/* Mobile quick buttons */}
                        <div className="flex flex-wrap items-center gap-3">
                          {qrState?.qrImageUrl && (
                            <>
                              <button
                                type="button"
                                onClick={handleDownloadQr}
                                className="min-h-[42px] px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shadow-sm"
                              >
                                <Download className="w-4 h-4" aria-hidden="true" />
                                <span>1. Baixar QR Code para a Galeria</span>
                              </button>

                              <button
                                type="button"
                                onClick={handleOpenTikTokApp}
                                className="min-h-[42px] px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shadow-sm"
                              >
                                <ExternalLink className="w-4 h-4" aria-hidden="true" />
                                <span>2. Abrir App do TikTok</span>
                              </button>
                            </>
                          )}

                          <button
                            type="button"
                            onClick={onConnectTikTokQr}
                            disabled={connecting}
                            className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${connecting ? 'animate-spin' : ''}`} aria-hidden="true" />
                            <span>Atualizar QR Code</span>
                          </button>

                          {qrState?.active && (
                            <button
                              type="button"
                              onClick={onCancelQr}
                              className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors"
                            >
                              <X className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Cancelar</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ========================================================= */}
                {/* TAB 2: E-MAIL E SENHA                                      */}
                {/* ========================================================= */}
                {activeTab === 'credentials' && (
                  <div className="space-y-6">
                    {twoFaActive ? (
                      /* 2FA Input Screen */
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 space-y-4">
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                            <ShieldCheck className="w-5 h-5" aria-hidden="true" />
                          </div>
                          <div>
                            <h3 className="text-base font-semibold text-slate-900">
                              Verificação em Duas Etapas (2FA)
                            </h3>
                            <p className="text-sm text-slate-600 mt-1">
                              {twoFaMessage ||
                                'O TikTok enviou um código de segurança para o seu e-mail ou SMS cadastrado.'}
                            </p>
                          </div>
                        </div>

                        {twoFaError && (
                          <div
                            role="alert"
                            className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 flex items-start gap-2"
                          >
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                            <span>{twoFaError}</span>
                          </div>
                        )}

                        <form onSubmit={(e) => void handle2FaSubmit(e)} className="space-y-4">
                          <div>
                            <label
                              htmlFor="two-fa-code"
                              className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                            >
                              Código de Verificação (6 dígitos)
                            </label>
                            <input
                              id="two-fa-code"
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9a-zA-Z]*"
                              maxLength={8}
                              autoFocus
                              value={twoFaCode}
                              onChange={(e) => setTwoFaCode(e.target.value.trim())}
                              placeholder="123456"
                              className="w-full max-w-xs text-center text-2xl font-mono tracking-widest px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                              disabled={submitting2Fa}
                            />
                          </div>

                          <div className="flex flex-wrap items-center gap-3 pt-2">
                            <button
                              type="submit"
                              disabled={submitting2Fa || !twoFaCode.trim()}
                              className="min-h-[42px] px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
                            >
                              {submitting2Fa ? (
                                <>
                                  <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                                  <span>Validando código...</span>
                                </>
                              ) : (
                                <span>Confirmar código e conectar</span>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => void handle2FaCancel()}
                              disabled={submitting2Fa}
                              className="min-h-[42px] px-4 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors"
                            >
                              Voltar / Cancelar
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : (
                      /* Main Credentials Form */
                      <form onSubmit={(e) => void handleCredentialsSubmit(e)} className="space-y-5">
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 text-xs text-amber-900 space-y-2">
                          <div className="font-semibold flex items-center gap-1.5">
                            <Info className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                            <span>Está dando erro de "Conta ou senha incorreta"? Entenda o motivo:</span>
                          </div>
                          <p className="leading-relaxed text-amber-800">
                            Se você criou sua conta no TikTok clicando em <strong>"Continuar com o Google"</strong> (Gmail) ou por telefone, <strong>sua conta NÃO possui uma senha do TikTok cadastrada</strong> (a senha do seu Gmail não é a senha do TikTok).
                          </p>
                          <div className="bg-white/80 border border-amber-200/80 rounded-md p-2.5 space-y-1">
                            <span className="font-bold text-amber-900">Como criar sua senha em 15 segundos no celular:</span>
                            <ol className="list-decimal list-inside text-[11px] space-y-0.5 text-amber-950 font-medium">
                              <li>Abra o app do <strong>TikTok</strong> no celular.</li>
                              <li>Vá em <strong>Perfil</strong> &rarr; menu (☰) &rarr; <strong>Configurações e privacidade</strong> &rarr; <strong>Conta</strong> &rarr; <strong>Senha</strong>.</li>
                              <li>O TikTok envia um código por SMS/E-mail e permite cadastrar sua senha.</li>
                              <li>Pronto! Depois volte aqui e entre com seu e-mail e essa nova senha.</li>
                            </ol>
                          </div>
                        </div>

                        {credentialsError && (
                          <div
                            role="alert"
                            className="bg-red-50 border border-red-200 rounded-lg p-3.5 text-xs text-red-700 flex flex-col gap-2.5"
                          >
                            <div className="flex items-start gap-2">
                              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                              <span className="font-medium leading-relaxed">{credentialsError}</span>
                            </div>
                            <div className="pt-1 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveTab('qrcode');
                                  if (!qrState || qrState.status === 'idle') {
                                    onConnectTikTokQr();
                                  }
                                }}
                                className="min-h-[32px] px-3 py-1 rounded bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs inline-flex items-center gap-1.5 transition-colors"
                              >
                                <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Usar QR Code no Celular (Sem Senha)</span>
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="space-y-4 max-w-md">
                          <div>
                            <label
                              htmlFor="tiktok-username"
                              className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                            >
                              @Nome de Usuário ou E-mail do TikTok
                            </label>
                            <div className="relative">
                              <User className="w-4 h-4 text-slate-400 absolute left-3 top-3.5 pointer-events-none" aria-hidden="true" />
                              <input
                                id="tiktok-username"
                                type="text"
                                autoComplete="username"
                                value={usernameOrEmail}
                                onChange={(e) => setUsernameOrEmail(e.target.value)}
                                placeholder="@seu_usuario ou email@exemplo.com"
                                disabled={submittingCredentials}
                                className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                              />
                            </div>
                            <span className="text-[11px] text-slate-500 mt-1 block">
                              Dica: O TikTok valida melhor pelo seu <strong>@nome_de_usuario</strong> do que pelo e-mail.
                            </span>
                          </div>

                          <div>
                            <label
                              htmlFor="tiktok-password"
                              className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                            >
                              Senha do TikTok
                            </label>
                            <div className="relative">
                              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3.5 pointer-events-none" aria-hidden="true" />
                              <input
                                id="tiktok-password"
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Sua senha do TikTok"
                                disabled={submittingCredentials}
                                className="w-full pl-9 pr-10 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                              />
                              <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-3 top-3 text-slate-400 hover:text-slate-600 focus:outline-none"
                                aria-label={showPassword ? 'Ocultar senha' : 'Exibir senha'}
                              >
                                {showPassword ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>

                          <div className="pt-2">
                            <button
                              type="submit"
                              disabled={submittingCredentials || !usernameOrEmail.trim() || !password}
                              className="w-full min-h-[44px] px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shadow-sm"
                            >
                              {submittingCredentials ? (
                                <>
                                  <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                                  <span>Autenticando no TikTok...</span>
                                </>
                              ) : (
                                <span>Entrar e Conectar Conta TikTok</span>
                              )}
                            </button>
                          </div>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {/* ========================================================= */}
                {/* TAB 3: PROVEDOR ONLINE / WEBHOOK                           */}
                {/* ========================================================= */}
                {activeTab === 'webhook' && (
                  <div className="space-y-6">
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-2">
                      <div className="flex items-start gap-2 font-medium text-slate-800">
                        <Globe className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>Conexão via Provedor Online ou Webhook Externo</span>
                      </div>
                      <p>
                        Se você utiliza um serviço de postagem na nuvem (como Ayrshare, Postproxy, Zernio, Zapier ou um Webhook próprio), pode conectar informando o endpoint do serviço. Quando uma ocorrência for aprovada no Discord, o bot enviará a ocorrência automaticamente para este provedor online.
                      </p>
                    </div>

                    {webhookError && (
                      <div
                        role="alert"
                        className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 flex items-start gap-2"
                      >
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{webhookError}</span>
                      </div>
                    )}

                    <form onSubmit={(e) => void handleWebhookSubmit(e)} className="space-y-4 max-w-md">
                      <div>
                        <label
                          htmlFor="webhook-user"
                          className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                        >
                          Nome de Usuário (@arroba da conta no TikTok)
                        </label>
                        <input
                          id="webhook-user"
                          type="text"
                          value={webhookUsername}
                          onChange={(e) => setWebhookUsername(e.target.value)}
                          placeholder="@seu_canal"
                          disabled={submittingWebhook}
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="webhook-url"
                          className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                        >
                          URL do Webhook ou API do Provedor Online
                        </label>
                        <input
                          id="webhook-url"
                          type="url"
                          value={webhookUrl}
                          onChange={(e) => setWebhookUrl(e.target.value.trim())}
                          placeholder="https://api.seuservico.com/tiktok/publish"
                          disabled={submittingWebhook}
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="webhook-key"
                          className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                        >
                          Token de Autenticação / API Key (Opcional)
                        </label>
                        <input
                          id="webhook-key"
                          type="password"
                          value={webhookApiKey}
                          onChange={(e) => setWebhookApiKey(e.target.value)}
                          placeholder="Bearer token ou API key"
                          disabled={submittingWebhook}
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={submittingWebhook || !webhookUsername.trim() || !webhookUrl.trim()}
                        className="w-full min-h-[44px] px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shadow-sm"
                      >
                        {submittingWebhook ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                            <span>Salvando Provedor Online...</span>
                          </>
                        ) : (
                          <span>Conectar Provedor Online</span>
                        )}
                      </button>
                    </form>
                  </div>
                )}

                {/* ========================================================= */}
                {/* TAB 4: COOKIE DE SESSÃO                                    */}
                {/* ========================================================= */}
                {activeTab === 'cookie' && (
                  <div className="space-y-6">
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-2">
                      <div className="flex items-start gap-2 font-medium text-slate-800">
                        <Cookie className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>Conexão por cookie de sessão (sessionid)</span>
                      </div>
                      <p>
                        Se você tiver acesso a um computador ou a navegadores como Kiwi Browser com extensões no Android, você pode copiar o cookie <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-800 font-mono">sessionid</code> da sua conta.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowCookieGuide(!showCookieGuide)}
                        className="inline-flex items-center gap-1 text-slate-900 font-semibold underline hover:text-slate-700 text-xs mt-1"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>{showCookieGuide ? 'Ocultar passo a passo' : 'Ver passo a passo de como copiar o sessionid (30 segundos)'}</span>
                      </button>
                    </div>

                    {showCookieGuide && (
                      <div className="bg-white border border-slate-200 rounded-xl p-5 text-xs text-slate-700 space-y-2.5">
                        <h4 className="font-semibold text-slate-900 text-sm">
                          Como copiar seu cookie <code className="font-mono text-slate-800">sessionid</code>:
                        </h4>
                        <ol className="list-decimal list-inside space-y-1.5 leading-relaxed">
                          <li>Abra o site <strong>tiktok.com</strong> no computador onde sua conta já está logada.</li>
                          <li>Pressione a tecla <kbd className="bg-slate-100 border border-slate-300 px-1.5 py-0.5 rounded text-[11px] font-mono">F12</kbd> (ou clique com botão direito &rarr; <strong>Inspecionar</strong>).</li>
                          <li>Clique na aba <strong>Aplicativo</strong> (Application) &rarr; <strong>Cookies</strong> &rarr; <strong>https://www.tiktok.com</strong>.</li>
                          <li>Dê dois cliques no valor do cookie chamado <code className="font-mono bg-slate-100 px-1 rounded">sessionid</code> e copie.</li>
                          <li>Cole o valor abaixo e clique em <strong>Conectar com Cookie</strong>.</li>
                        </ol>
                      </div>
                    )}

                    {cookieError && (
                      <div
                        role="alert"
                        className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 flex items-start gap-2"
                      >
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{cookieError}</span>
                      </div>
                    )}

                    <form onSubmit={(e) => void handleCookieSubmit(e)} className="space-y-4 max-w-md">
                      <div>
                        <label
                          htmlFor="tiktok-cookie-sessionid"
                          className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1"
                        >
                          Valor do cookie <span className="font-mono lowercase">sessionid</span>
                        </label>
                        <textarea
                          id="tiktok-cookie-sessionid"
                          rows={3}
                          value={sessionCookie}
                          onChange={(e) => setSessionCookie(e.target.value.trim())}
                          placeholder="Cole aqui o valor do cookie sessionid copiado do TikTok..."
                          disabled={submittingCookie}
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 bg-white"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={submittingCookie || !sessionCookie.trim()}
                        className="w-full min-h-[44px] px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shadow-sm"
                      >
                        {submittingCookie ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                            <span>Validando sessão do cookie...</span>
                          </>
                        ) : (
                          <span>Conectar com Cookie de Sessão</span>
                        )}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
