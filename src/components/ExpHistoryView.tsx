import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  ExternalLink,
  Film,
  Images,
  Menu,
  RefreshCw,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  ExpFormat,
  ExpRecordView,
  ExpRecordsResponse,
  ExpStatus,
  TikTokAccountInfo,
} from '../types';

interface ExpHistoryViewProps {
  records: ExpRecordView[];
  nextExpCode: string;
  loading: boolean;
  tiktokConnected: boolean;
  tiktokAccounts?: TikTokAccountInfo[];
  embeddedInServerPanel?: boolean;
  fixedGuildId?: string;
  onRefresh: () => void;
  onOpenDrawer?: () => void;
  onBackDashboard?: () => void;
  onOpenTikTokSettings?: () => void;
}

type StatusFilter = 'all' | 'pending' | 'published' | 'confirmation' | 'rejected';

function getStatusLabel(status: ExpStatus): { text: string; tone: string } {
  switch (status) {
    case 'published_tiktok':
      return { text: 'Publicado no TikTok', tone: 'text-emerald-700' };
    case 'tiktok_inbox':
      return { text: 'Enviado para Inbox TikTok', tone: 'text-emerald-700' };
    case 'awaiting_tiktok_confirmation':
      return { text: 'Aguardando confirmação TikTok', tone: 'text-amber-700' };
    case 'tiktok_error':
      return { text: 'Gerado · Erro no TikTok', tone: 'text-red-700' };
    case 'accepted':
      return { text: 'Aprovado e gerado', tone: 'text-slate-900' };
    case 'rejected':
      return { text: 'Recusado', tone: 'text-slate-500' };
    case 'pending':
    default:
      return { text: 'Aguardando aprovação', tone: 'text-amber-700' };
  }
}

function AuthorizedExpMedia({
  expId,
  filename,
  type,
}: {
  expId: string;
  filename: string;
  type: 'image' | 'video';
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    void (async () => {
      try {
        const resp = await apiFetch(`/api/exp/media/${expId}/${encodeURIComponent(filename)}`);
        if (!resp.ok) return;
        const blob = await resp.blob();
        created = URL.createObjectURL(blob);
        if (active) setBlobUrl(created);
      } catch {
        // Ignore unavailable ephemeral asset after server restart
      }
    })();

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [expId, filename]);

  if (!blobUrl) {
    return (
      <div className="w-full h-36 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-xs text-slate-500">
        {type === 'video' ? 'Carregando vídeo...' : 'Carregando slide...'}
      </div>
    );
  }

  if (type === 'video') {
    return (
      <video
        src={blobUrl}
        controls
        playsInline
        className="w-full max-w-[260px] rounded-lg border border-slate-200 bg-black"
      />
    );
  }

  return (
    <img
      src={blobUrl}
      alt={filename}
      referrerPolicy="no-referrer"
      className="w-full h-44 object-cover rounded-lg border border-slate-200 bg-slate-900"
    />
  );
}

export function ExpHistoryView({
  records,
  nextExpCode,
  loading,
  tiktokConnected,
  tiktokAccounts,
  embeddedInServerPanel = false,
  fixedGuildId,
  onRefresh,
  onOpenDrawer,
  onBackDashboard,
  onOpenTikTokSettings,
}: ExpHistoryViewProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (tiktokAccounts && tiktokAccounts.length > 0 && !selectedAccountId) {
      const def = tiktokAccounts.find((a) => a.isDefault) || tiktokAccounts[0];
      if (def?.id) {
        setSelectedAccountId(def.id);
      }
    }
  }, [tiktokAccounts, selectedAccountId]);

  // Interactive preview workbench state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [formInvolved, setFormInvolved] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formWhat, setFormWhat] = useState('');
  const [formWhy, setFormWhy] = useState('');
  const [formMediaLinks, setFormMediaLinks] = useState('');
  const [formOtherLinks, setFormOtherLinks] = useState('');
  const [formFormat, setFormFormat] = useState<ExpFormat>('carousel');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [generatingPreview, setGeneratingPreview] = useState(false);

  const visibleRecords = useMemo(() => {
    return records
      .filter((r) => (!fixedGuildId ? true : r.guildId === fixedGuildId))
      .filter((r) => {
        if (filter === 'all') return true;
        if (filter === 'pending') return r.status === 'pending';
        if (filter === 'published')
          return r.status === 'published_tiktok' || r.status === 'tiktok_inbox' || r.status === 'accepted';
        if (filter === 'confirmation')
          return r.status === 'awaiting_tiktok_confirmation' || r.status === 'tiktok_error';
        if (filter === 'rejected') return r.status === 'rejected';
        return true;
      });
  }, [records, fixedGuildId, filter]);

  const handlePublishTikTok = useCallback(
    async (record: ExpRecordView, mode: 'auto' | 'inbox_draft' | 'direct_private') => {
      setBusyId(record.id);
      setActionFeedback(null);
      try {
        const resp = await apiFetch(
          `/api/guilds/${record.guildId}/exp/${record.id}/publish-tiktok`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, accountId: selectedAccountId || undefined }),
          },
        );
        const data = (await resp.json().catch(() => ({}))) as {
          outcome?: string;
          statusText?: string;
          error?: string;
        };
        if (!resp.ok) {
          setActionFeedback({
            type: 'error',
            text: data.error || 'Não foi possível enviar para o TikTok.',
          });
        } else {
          setActionFeedback({
            type: data.outcome === 'error' ? 'error' : 'success',
            text: data.statusText || 'Status atualizado.',
          });
        }
        onRefresh();
      } catch {
        setActionFeedback({
          type: 'error',
          text: 'Erro de comunicação ao tentar publicar no TikTok.',
        });
      } finally {
        setBusyId(null);
      }
    },
    [onRefresh],
  );

  const handleGeneratePreview = async () => {
    setGeneratingPreview(true);
    setPreviewError(null);
    try {
      const resp = await apiFetch('/api/exp/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          involvedName: formInvolved,
          description: formDesc,
          whatHappened: formWhat,
          whyWrong: formWhy,
          mediaLinks: formMediaLinks,
          otherLinks: formOtherLinks,
          format: formFormat,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        previewDataUrl?: string;
        error?: string;
      };
      if (!resp.ok || !data.previewDataUrl) {
        setPreviewError(data.error || 'Não foi possível gerar a prévia.');
        setPreviewUrl(null);
      } else {
        setPreviewUrl(data.previewDataUrl);
      }
    } catch {
      setPreviewError('Erro de conexão ao gerar a prévia.');
    } finally {
      setGeneratingPreview(false);
    }
  };

  const content = (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Histórico de Exposições (EXP)
          </h2>
          <p className="text-sm text-slate-500 mt-1 tabular-nums">
            Próxima numeração automática: <span className="font-mono font-semibold text-slate-900">{nextExpCode}</span> · Padrão:{' '}
            <span className="font-mono text-slate-700">{nextExpCode} #paneleiro #bot #fyb #5573 #exp</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-2 whitespace-nowrap transition-colors"
          >
            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{previewOpen ? 'Ocultar testador de prévia' : 'Testar prévia EXP'}</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-2 whitespace-nowrap transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {!tiktokConnected && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 text-sm text-amber-900">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Nenhuma conta TikTok conectada. Conecte sua conta para publicar automaticamente após clicar em ACEITAR no Discord.
            </span>
          </div>
          {onOpenTikTokSettings && (
            <button
              type="button"
              onClick={onOpenTikTokSettings}
              className="min-h-[34px] px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              Abrir Conexão TikTok
            </button>
          )}
        </div>
      )}

      {actionFeedback && (
        <div
          role={actionFeedback.type === 'error' ? 'alert' : 'status'}
          className={`flex items-center gap-2.5 rounded-xl px-5 py-3 text-sm border ${
            actionFeedback.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {actionFeedback.type === 'error' ? (
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span>{actionFeedback.text}</span>
        </div>
      )}

      {previewOpen && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Prévia e Validação Anti-Dados Privados
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Simule o formulário do canal #exp para visualizar como a imagem de capa ficará antes do envio e validar bloqueios de privacidade.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nome ou identificação pública (opcional)
                </label>
                <input
                  type="text"
                  value={formInvolved}
                  onChange={(e) => setFormInvolved(e.target.value)}
                  maxLength={80}
                  placeholder="Ex.: @usuario_publico"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Descrição do ocorrido
                </label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  maxLength={160}
                  placeholder="Resumo objetivo do caso"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  O que aconteceu?
                </label>
                <textarea
                  rows={3}
                  value={formWhat}
                  onChange={(e) => setFormWhat(e.target.value)}
                  maxLength={1000}
                  placeholder="Descreva os fatos sem dados pessoais privados..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Por que isso é considerado errado?
                </label>
                <textarea
                  rows={2}
                  value={formWhy}
                  onChange={(e) => setFormWhy(e.target.value)}
                  maxLength={600}
                  placeholder="Explique o motivo..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Links de imagens/vídeos (opcional)
                  </label>
                  <input
                    type="text"
                    value={formMediaLinks}
                    onChange={(e) => setFormMediaLinks(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Links de outras evidências (opcional)
                  </label>
                  <input
                    type="text"
                    value={formOtherLinks}
                    onChange={(e) => setFormOtherLinks(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#5865F2]"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setFormFormat('carousel')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      formFormat === 'carousel'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Carrossel de imagens
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormFormat('video')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      formFormat === 'video'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Vídeo
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => void handleGeneratePreview()}
                  disabled={generatingPreview}
                  className="min-h-[38px] px-4 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors disabled:opacity-50"
                >
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{generatingPreview ? 'Gerando...' : 'Gerar prévia'}</span>
                </button>
              </div>

              {previewError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
                  {previewError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-4 min-h-[320px]">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Prévia EXP"
                  referrerPolicy="no-referrer"
                  className="max-h-[420px] rounded-lg border border-slate-200 object-contain"
                />
              ) : (
                <div className="text-center text-xs text-slate-500 max-w-xs">
                  Preencha os campos ao lado e clique em <strong>Gerar prévia</strong> para visualizar o card editorial antes do envio.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {(
          [
            { id: 'all', label: 'Todas' },
            { id: 'pending', label: 'Pendentes' },
            { id: 'published', label: 'Aprovadas / Publicadas' },
            { id: 'confirmation', label: 'Ação TikTok' },
            { id: 'rejected', label: 'Recusadas' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Records List */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : visibleRecords.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <div className="mx-auto mb-3 w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600">
            <ShieldAlert className="w-5 h-5" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            Nenhuma exposição registrada neste filtro
          </h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Quando um membro clicar em <strong>EXPONHA UMA OCORRÊNCIA</strong> no canal #exp do Discord e enviar o formulário, o recurso e o histórico aparecerão aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleRecords.map((rec) => {
            const st = getStatusLabel(rec.status);
            const slides = rec.generatedFiles.filter((f) => f.endsWith('.jpg') && f !== 'video-preview.jpg');
            const videoFile = rec.generatedFiles.find((f) => f.endsWith('.mp4')) ?? null;

            return (
              <article
                key={rec.id}
                className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {rec.expCode || rec.id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.guildName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1">
                        {rec.format === 'carousel' ? (
                          <Images className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <Film className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        {rec.format === 'carousel' ? 'Carrossel de imagens' : 'Vídeo'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className={`font-medium ${st.tone}`}>{st.text}</span>
                    </div>

                    <h3 className="text-base font-semibold text-slate-900">
                      {rec.description}
                    </h3>
                    {rec.caption && (
                      <div className="text-xs font-mono text-slate-600">
                        {rec.caption}
                      </div>
                    )}
                  </div>

                  <div className="text-xs text-slate-500 tabular-nums shrink-0">
                    {new Date(rec.createdAt).toLocaleString('pt-BR')}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100 text-sm text-slate-700">
                  <div>
                    <div className="text-xs font-medium text-slate-500 mb-1">O que aconteceu</div>
                    <p className="text-sm text-slate-800 whitespace-pre-line">{rec.whatHappened}</p>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-500 mb-1">
                      Por que é considerado errado
                    </div>
                    <p className="text-sm text-slate-800 whitespace-pre-line">{rec.whyWrong}</p>
                  </div>
                </div>

                {(rec.involvedName || rec.mediaLinks.length > 0 || rec.otherLinks.length > 0) && (
                  <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
                    {rec.involvedName && (
                      <span>
                        <strong className="text-slate-800">Envolvido(a):</strong> {rec.involvedName}
                      </span>
                    )}
                    {[...rec.mediaLinks, ...rec.otherLinks].map((link, idx) => (
                      <a
                        key={`${rec.id}-link-${idx}`}
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[#5865F2] hover:underline"
                      >
                        <span>Evidência {idx + 1}</span>
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                )}

                {/* Generated Media Preview */}
                {rec.generatedFiles.length > 0 && (
                  <div className="pt-3 border-t border-slate-100 space-y-2">
                    <div className="text-xs font-medium text-slate-500">
                      Conteúdo gerado
                    </div>
                    {videoFile ? (
                      <AuthorizedExpMedia expId={rec.id} filename={videoFile} type="video" />
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                        {slides.map((slide) => (
                          <AuthorizedExpMedia
                            key={`${rec.id}-${slide}`}
                            expId={rec.id}
                            filename={slide}
                            type="image"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* TikTok Outcome & Action Buttons */}
                {(rec.tiktokStatusText || rec.tiktokError || rec.generatedFiles.length > 0) && (
                  <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="text-xs text-slate-600 space-y-0.5">
                      {rec.tiktokStatusText && <div>{rec.tiktokStatusText}</div>}
                      {rec.tiktokError && <div className="text-red-600">{rec.tiktokError}</div>}
                      {rec.tiktokPublishId && (
                        <div className="font-mono text-slate-500">
                          Publish ID: {rec.tiktokPublishId}
                        </div>
                      )}
                    </div>

                    {rec.generatedFiles.length > 0 &&
                      rec.status !== 'published_tiktok' &&
                      rec.status !== 'tiktok_inbox' && (
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {tiktokAccounts && tiktokAccounts.length > 1 && (
                            <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1">
                              <span className="font-semibold text-slate-700">Conta:</span>
                              <select
                                value={selectedAccountId}
                                onChange={(e) => setSelectedAccountId(e.target.value)}
                                className="bg-transparent text-xs font-medium text-slate-900 focus:outline-none cursor-pointer"
                              >
                                {tiktokAccounts.map((acc) => (
                                  <option key={acc.id} value={acc.id}>
                                    @{acc.username} {acc.isDefault ? '(Padrão)' : ''}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          {rec.status === 'awaiting_tiktok_confirmation' ? (
                            <>
                              <button
                                type="button"
                                disabled={busyId === rec.id}
                                onClick={() => void handlePublishTikTok(rec, 'inbox_draft')}
                                className="min-h-[34px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                              >
                                <Send className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Confirmar: Inbox TikTok</span>
                              </button>
                              <button
                                type="button"
                                disabled={busyId === rec.id}
                                onClick={() => void handlePublishTikTok(rec, 'direct_private')}
                                className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium whitespace-nowrap disabled:opacity-50"
                              >
                                Confirmar: Privado
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === rec.id}
                              onClick={() => void handlePublishTikTok(rec, 'auto')}
                              className="min-h-[34px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                            >
                              <Send className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>
                                {busyId === rec.id ? 'Enviando...' : 'Enviar para TikTok'}
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );

  if (embeddedInServerPanel) {
    return content;
  }

  return (
    <div className="min-h-screen w-full bg-[#FAFAFA] flex flex-col">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[1160px] mx-auto px-6 py-4 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            {onOpenDrawer && (
              <button
                type="button"
                onClick={onOpenDrawer}
                aria-label="Abrir menu lateral"
                className="w-10 h-10 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 inline-flex items-center justify-center shrink-0 transition-colors"
              >
                <Menu className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onBackDashboard}
              className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 hover:opacity-80 transition-opacity"
            >
              Aph Bot Manager
            </button>
          </div>

          <nav aria-label="Navegação atual" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={onBackDashboard}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Servidores
            </button>
            <span className="text-slate-900 border-b-2 border-slate-900 py-1 whitespace-nowrap shrink-0">
              Histórico EXP
            </span>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            {onBackDashboard && (
              <button
                type="button"
                onClick={onBackDashboard}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Voltar</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-[1160px] mx-auto px-6 py-10">{content}</main>
    </div>
  );
}
