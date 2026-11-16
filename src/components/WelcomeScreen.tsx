import { Bot, ArrowRight, AlertCircle, LogIn } from 'lucide-react';

interface WelcomeScreenProps {
  oauthConfigured: boolean;
  authLoading: boolean;
  authError: string | null;
  onInviteBot: () => void;
  onLoginDiscord: () => void;
  onSkip: () => void;
}

export function WelcomeScreen({
  oauthConfigured,
  authLoading,
  authError,
  onInviteBot,
  onLoginDiscord,
  onSkip,
}: WelcomeScreenProps) {
  return (
    <main className="min-h-screen w-full bg-[#FAFAFA] flex items-center justify-center px-6 py-12">
      <section className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8 sm:p-10 text-center">
        <div className="mx-auto mb-6 w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-800">
          <Bot className="w-6 h-6" aria-hidden="true" />
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mb-2 [text-wrap:balance]">
          Aph Bot Manager
        </h1>
        <p className="text-sm text-slate-600 leading-relaxed mb-8">
          Gerencie seus servidores Discord e salve todas as configurações diretamente na sua conta Discord, mesmo após limpar o cache do navegador.
        </p>

        {authError && (
          <div
            role="alert"
            className="mb-6 flex items-start gap-2.5 text-left text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{authError}</span>
          </div>
        )}

        {!oauthConfigured && !authError && (
          <div
            role="status"
            className="mb-6 flex items-start gap-2.5 text-left text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              As credenciais OAuth2 do Discord ainda não estão configuradas no ambiente do servidor. Você ainda pode pular para visualizar o painel.
            </span>
          </div>
        )}

        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={onInviteBot}
            disabled={authLoading}
            className="w-full min-h-[44px] px-6 py-3 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors duration-150 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5865F2] focus-visible:ring-offset-2"
          >
            <span>{authLoading ? 'Abrindo Discord...' : 'Convidar bot para o servidor'}</span>
            <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onLoginDiscord}
            disabled={authLoading}
            className="w-full min-h-[44px] px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed text-slate-800 text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors duration-150 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            <LogIn className="w-4 h-4 shrink-0 text-slate-600" aria-hidden="true" />
            <span>Entrar com minha conta Discord</span>
          </button>

          <button
            type="button"
            onClick={onSkip}
            className="min-h-[44px] px-5 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors duration-150 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Pular
          </button>
        </div>
      </section>
    </main>
  );
}
