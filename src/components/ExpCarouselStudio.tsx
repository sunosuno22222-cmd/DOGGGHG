import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import {
  AlertCircle,
  Bookmark,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Film,
  Flame,
  Heart,
  ImagePlus,
  MessageCircle,
  Music,
  Pause,
  Play,
  RefreshCw,
  Save,
  Send,
  Share2,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  CarouselPublishMode,
  ConfigStatus,
  DemonicAiGenerationResult,
  ExpAudioTrackMeta,
  GuildItem,
  RussianMusicTrack,
  TikTokAccountInfo,
} from '../types';

interface ExpCarouselStudioProps {
  nextExpCode: string;
  tiktokConnected: boolean;
  tiktokAccounts?: TikTokAccountInfo[];
  managedGuilds?: GuildItem[];
  fixedGuildId?: string;
  fixedGuildName?: string;
  onCreated: () => void;
  onOpenTikTokSettings?: () => void;
}

interface PreviewSlideItem {
  index: number;
  label: string;
  dataUrl: string;
}

interface UploadedSlot {
  name: string;
  dataUrl: string;
  isVideo?: boolean;
  videoInfo?: string;
}

/**
 * Reads an image file as a high-quality 4:5 JPEG Data URL,
 * downscaling if the source resolution is unnecessarily large (> 1600px).
 */
async function readImageFileAsDataUrl(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Falha ao ler arquivo de imagem'));
    };
    reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
    reader.readAsDataURL(file);
  });

  if (file.size <= 2.5 * 1024 * 1024) {
    return rawDataUrl;
  }

  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1080) * scale));
      const h = Math.max(1, Math.round((img.height || 1080) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(rawDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(rawDataUrl);
    img.src = rawDataUrl;
  });
}

/**
 * Extracts a high-res 1080x1350 4:5 poster frame directly in the browser
 * from any uploaded video file (MP4, WebM, MOV) with zero network latency.
 */
async function extractVideoFrameClient(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;

    let seeked = false;

    video.onloadeddata = () => {
      const targetTime = Math.min(1.0, Math.max(0.1, (video.duration || 1) * 0.25));
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      if (seeked) return;
      seeked = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1080;
        canvas.height = 1350;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Contexto 2D do canvas não disponível'));
          return;
        }

        const vw = video.videoWidth || 1080;
        const vh = video.videoHeight || 1350;
        const targetAspect = 1080 / 1350;
        const videoAspect = vw / vh;

        let sx = 0;
        let sy = 0;
        let sw = vw;
        let sh = vh;

        if (videoAspect > targetAspect) {
          sw = vh * targetAspect;
          sx = (vw - sw) / 2;
        } else {
          sh = vw / targetAspect;
          sy = (vh - sh) / 2;
        }

        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 1080, 1350);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        URL.revokeObjectURL(objectUrl);
        resolve(dataUrl);
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Falha ao decodificar arquivo de vídeo no navegador'));
    };
  });
}

/**
 * Fallback to extract video frame using backend ffmpeg if browser cannot decode the format.
 */
async function extractVideoFrameServer(file: File): Promise<string> {
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Falha ao ler vídeo'));
    };
    reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
    reader.readAsDataURL(file);
  });

  const resp = await apiFetch('/api/exp/media/extract-frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoBase64: base64Data }),
  });

  if (!resp.ok) {
    const errData = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(errData.error || 'Falha ao extrair quadro do vídeo no servidor');
  }

  const data = (await resp.json()) as { ok: boolean; dataUrl: string };
  return data.dataUrl;
}

export function ExpCarouselStudio({
  nextExpCode,
  tiktokConnected,
  tiktokAccounts = [],
  managedGuilds = [],
  fixedGuildId,
  fixedGuildName,
  onCreated,
  onOpenTikTokSettings,
}: ExpCarouselStudioProps) {
  // Ordered 8-step fields
  const [title, setTitle] = useState('');
  const [information, setInformation] = useState('');
  const [imageSlots, setImageSlots] = useState<[UploadedSlot | null, UploadedSlot | null, UploadedSlot | null]>([
    null,
    null,
    null,
  ]);
  const [additionalText, setAdditionalText] = useState('');
  const [insultText, setInsultText] = useState('');
  const [closingText, setClosingText] = useState('');
  const [watermarkText, setWatermarkText] = useState('@5573satan');

  // Quick Exp input for instant AI generation ("Envio Rápido de Dados")
  const [quickExpData, setQuickExpData] = useState('');

  // Theme & publishing settings
  const [theme, setTheme] = useState<'demonic' | 'gallery'>('demonic');
  const [targetGuildId, setTargetGuildId] = useState<string>(fixedGuildId || 'web-studio');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [carouselMode, setCarouselMode] = useState<CarouselPublishMode>('video_slideshow');
  const [customCaption, setCustomCaption] = useState('');
  const [customHashtags, setCustomHashtags] = useState('#5573 #satan #exp #demoniaco #exposed #fyb');

  // Russian audio catalog & playback (prioritizing migas, shluzov, 7leaf, xishqa)
  const [audioMode, setAudioMode] = useState<'auto' | 'custom'>('auto');
  const [tracks, setTracks] = useState<RussianMusicTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<RussianMusicTrack | null>(null);
  const [activeAudioTrack, setActiveAudioTrack] = useState<ExpAudioTrackMeta | null>(null);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Live framed preview viewer
  const [slides, setSlides] = useState<PreviewSlideItem[]>([]);
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [previewExpCode, setPreviewExpCode] = useState(nextExpCode);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [submitting, setSubmitting] = useState<'save' | 'publish' | 'draft' | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Groq AI invocation modal & status
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiTargetName, setAiTargetName] = useState('');
  const [aiTopicContext, setAiTopicContext] = useState('');
  const [aiGenerateArtworks, setAiGenerateArtworks] = useState(true);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [groqConfigured, setGroqConfigured] = useState(false);

  // TikTok Video Slideshow Player state
  const [playerViewMode, setPlayerViewMode] = useState<'tiktok' | 'clean'>('tiktok');
  const [isVideoPlaying, setIsVideoPlaying] = useState(true);
  const [slideProgress, setSlideProgress] = useState(0); // 0 to 100%
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filteringSlotIdx, setFilteringSlotIdx] = useState<number | null>(null);

  // Interactive Drag & Swipe sideways state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragCurrentX, setDragCurrentX] = useState(0);
  const carouselContainerRef = useRef<HTMLDivElement | null>(null);

  const fileInputRefs = useRef<Array<HTMLInputElement | null>>([null, null, null]);
  const multiVideoInputRef = useRef<HTMLInputElement | null>(null);

  // Load config status to inspect Groq configuration
  useEffect(() => {
    let isMounted = true;
    void apiFetch('/api/config/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((status: ConfigStatus | null) => {
        if (isMounted && status) {
          setGroqConfigured(Boolean(status.groqConfigured));
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (fixedGuildId) {
      setTargetGuildId(fixedGuildId);
    }
  }, [fixedGuildId]);

  useEffect(() => {
    setPreviewExpCode(nextExpCode);
  }, [nextExpCode]);

  useEffect(() => {
    if (tiktokAccounts.length > 0 && !selectedAccountId) {
      const def = tiktokAccounts.find((a) => a.isDefault) || tiktokAccounts[0];
      if (def?.id) setSelectedAccountId(def.id);
    }
  }, [tiktokAccounts, selectedAccountId]);

  const loadRussianTracks = useCallback(async (forceRefresh = false) => {
    setTracksLoading(true);
    try {
      const resp = await apiFetch(`/api/exp/music/russian${forceRefresh ? '?refresh=1' : ''}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { tracks?: RussianMusicTrack[] };
      if (Array.isArray(data.tracks)) {
        setTracks(data.tracks);
        if (data.tracks.length > 0 && !selectedTrack) {
          setSelectedTrack(data.tracks[0]);
        }
      }
    } catch {
      // Non-blocking
    } finally {
      setTracksLoading(false);
    }
  }, [selectedTrack]);

  useEffect(() => {
    void loadRussianTracks(false);
  }, [loadRussianTracks]);

  const stopAudioPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingTrackId(null);
  }, []);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  // TikTok auto-advancing video progress ticker
  useEffect(() => {
    if (!isVideoPlaying || slides.length === 0 || isDragging) return;

    const SLIDE_DURATION_MS = 3800; // 3.8s per slide like TikTok photo mode
    const TICK_INTERVAL_MS = 30;
    const progressStep = (TICK_INTERVAL_MS / SLIDE_DURATION_MS) * 100;

    const timer = setInterval(() => {
      setSlideProgress((prev) => {
        if (prev + progressStep >= 100) {
          setActiveSlideIdx((curr) => (curr + 1) % slides.length);
          return 0;
        }
        return prev + progressStep;
      });
    }, TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isVideoPlaying, slides.length, isDragging]);

  // Audio synchronization with TikTok slideshow player
  useEffect(() => {
    const trackUrl = activeAudioTrack?.previewUrl || selectedTrack?.previewUrl;
    if (!trackUrl) return;

    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.loop = true;
    }

    if (audioRef.current.src !== trackUrl) {
      audioRef.current.src = trackUrl;
    }

    audioRef.current.muted = audioMuted;
    audioRef.current.volume = 0.65;

    if (isVideoPlaying && playerViewMode === 'tiktok' && slides.length > 0) {
      void audioRef.current.play().catch(() => {});
    } else {
      audioRef.current.pause();
    }
  }, [isVideoPlaying, playerViewMode, slides.length, activeAudioTrack, selectedTrack, audioMuted]);

  const handleTogglePlayTrack = (track: { id?: string; previewUrl?: string }) => {
    if (!track.previewUrl) return;
    const trackKey = track.id || track.previewUrl;
    if (playingTrackId === trackKey) {
      stopAudioPlayback();
      return;
    }

    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.onended = () => setPlayingTrackId(null);
    }
    audioRef.current.src = track.previewUrl;
    audioRef.current.volume = 0.65;
    void audioRef.current
      .play()
      .then(() => setPlayingTrackId(trackKey))
      .catch(() => setPlayingTrackId(null));
  };

  /**
   * Process an uploaded file (image or video) and place into a slot.
   */
  const processAndSetSlot = async (slotIndex: 0 | 1 | 2, file: File) => {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);

    if (!isVideo && !isImage) {
      setFeedback({
        type: 'error',
        text: 'Formato não suportado. Envie vídeo (MP4, WebM, MOV) ou imagem (PNG, JPG, WEBP).',
      });
      return;
    }

    try {
      let dataUrl: string;
      let videoInfo: string | undefined;

      if (isVideo) {
        try {
          dataUrl = await extractVideoFrameClient(file);
          videoInfo = 'Vídeo convertido em slide 4:5';
        } catch {
          dataUrl = await extractVideoFrameServer(file);
          videoInfo = 'Vídeo processado no servidor';
        }
      } else {
        dataUrl = await readImageFileAsDataUrl(file);
      }

      setImageSlots((prev) => {
        const next: [UploadedSlot | null, UploadedSlot | null, UploadedSlot | null] = [...prev];
        next[slotIndex] = {
          name: file.name,
          dataUrl,
          isVideo,
          videoInfo,
        };
        return next;
      });
      setFeedback(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível processar o arquivo selecionado.',
      });
    }
  };

  const handleSlotFileChange = async (slotIndex: 0 | 1 | 2, e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processAndSetSlot(slotIndex, file);
  };

  /**
   * Batch video uploader: transforms multiple videos or photos into carousel slides.
   */
  const handleMultiVideoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    setFeedback({
      type: 'success',
      text: `Processando ${files.length} arquivo(s)... extraindo quadros em alta resolução para os slides.`,
    });

    const targetSlots: Array<0 | 1 | 2> = [0, 1, 2];
    let convertedCount = 0;

    for (let i = 0; i < Math.min(files.length, 3); i++) {
      const file = files[i];
      const slotIdx = targetSlots[i];
      try {
        await processAndSetSlot(slotIdx, file);
        convertedCount++;
      } catch (err) {
        console.error('Falha ao processar arquivo batch:', err);
      }
    }

    setFeedback({
      type: 'success',
      text: `${convertedCount} mídia(s) transformada(s) em slides do carrossel com sucesso!`,
    });
  };

  const handleRemoveSlot = (slotIndex: 0 | 1 | 2) => {
    setImageSlots((prev) => {
      const next: [UploadedSlot | null, UploadedSlot | null, UploadedSlot | null] = [...prev];
      next[slotIndex] = null;
      return next;
    });
  };

  /**
   * Applies the demonic blood-red & runic contrast filter to a specific uploaded image slot.
   */
  const handleApplyDemonicFilter = async (slotIndex: 0 | 1 | 2) => {
    const slot = imageSlots[slotIndex];
    if (!slot) return;

    setFilteringSlotIdx(slotIndex);
    try {
      const resp = await apiFetch('/api/exp/media/demonic-filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: slot.dataUrl }),
      });

      if (!resp.ok) {
        throw new Error('Falha ao aplicar filtro demoníaco');
      }

      const data = (await resp.json()) as { ok: boolean; dataUrl: string };
      setImageSlots((prev) => {
        const next: [UploadedSlot | null, UploadedSlot | null, UploadedSlot | null] = [...prev];
        next[slotIndex] = {
          ...slot,
          dataUrl: data.dataUrl,
          videoInfo: 'Filtro Demoníaco 5573 Aplicado',
        };
        return next;
      });

      setFeedback({
        type: 'success',
        text: `Filtro demoníaco infernal aplicado com sucesso na Imagem ${slotIndex + 1}!`,
      });
    } catch {
      setFeedback({
        type: 'error',
        text: 'Não foi possível aplicar o filtro demoníaco na imagem.',
      });
    } finally {
      setFilteringSlotIdx(null);
    }
  };

  const collectedImagesBase64 = imageSlots
    .filter((s): s is UploadedSlot => Boolean(s?.dataUrl))
    .map((s) => s.dataUrl);

  /**
   * Generates live framed 4:5 slides.
   */
  const handleGeneratePreview = async (overrideData?: {
    title?: string;
    information?: string;
    images?: string[];
    additionalText?: string;
    insultText?: string;
    closingText?: string;
    watermarkText?: string;
  }) => {
    const effectiveTitle = (overrideData?.title ?? title).trim();
    const effectiveInfo = (overrideData?.information ?? information).trim();
    const effectiveImages = overrideData?.images ?? collectedImagesBase64;
    const effectiveAdd = (overrideData?.additionalText ?? additionalText).trim();
    const effectiveInsult = (overrideData?.insultText ?? insultText).trim();
    const effectiveClosing = (overrideData?.closingText ?? closingText).trim();
    const effectiveWatermark = (overrideData?.watermarkText ?? watermarkText).trim();

    if (effectiveTitle.length < 2) {
      setFeedback({ type: 'error', text: 'Preencha o passo 1 (Título) antes de gerar a prévia.' });
      return;
    }
    if (effectiveInfo.length < 3) {
      setFeedback({ type: 'error', text: 'Preencha o passo 2 (Informações) antes de gerar a prévia.' });
      return;
    }

    setGeneratingPreview(true);
    setFeedback(null);

    try {
      const resp = await apiFetch('/api/exp/studio/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: effectiveTitle,
          information: effectiveInfo,
          imagesBase64: effectiveImages,
          additionalText: effectiveAdd,
          insultText: effectiveInsult,
          closingText: effectiveClosing,
          watermarkText: effectiveWatermark,
          theme,
          audioMode,
          selectedAudioTrack: audioMode === 'custom' ? selectedTrack : null,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        slides?: PreviewSlideItem[];
        nextExpCode?: string;
        suggestedAudioTrack?: ExpAudioTrackMeta | null;
        error?: string;
      };

      if (!resp.ok || !data.slides || data.slides.length === 0) {
        setFeedback({
          type: 'error',
          text: data.error || 'Não foi possível gerar as molduras do carrossel.',
        });
        return;
      }

      setSlides(data.slides);
      setActiveSlideIdx(0);
      setSlideProgress(0);
      setIsVideoPlaying(true);
      if (data.nextExpCode) setPreviewExpCode(data.nextExpCode);
      if (data.suggestedAudioTrack) {
        setActiveAudioTrack(data.suggestedAudioTrack);
      }
    } catch {
      setFeedback({ type: 'error', text: 'Erro de comunicação ao gerar a prévia.' });
    } finally {
      setGeneratingPreview(false);
    }
  };

  /**
   * Invokes Groq Llama 3.3 70B (with Gemini fallback) to formulate structured demonic content
   * and synthesize 3 bespoke AI demonic artworks for image slots 3, 4, 5.
   */
  const handleInvokeDemonicAi = async (overrideTopic?: string) => {
    setAiGenerating(true);
    setFeedback(null);

    const topicText = overrideTopic || aiTopicContext.trim() || quickExpData.trim() || 'Dados da ocorrência';
    const targetNameText = aiTargetName.trim() || topicText.slice(0, 36);

    try {
      const resp = await apiFetch('/api/exp/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          involvedName: targetNameText,
          promptTopic: topicText,
          currentTitle: title.trim() || undefined,
          currentInfo: information.trim() || undefined,
          currentAdditional: additionalText.trim() || undefined,
          currentInsult: insultText.trim() || undefined,
          generateImages: aiGenerateArtworks,
          expCode: previewExpCode,
        }),
      });

      if (!resp.ok) {
        const errData = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || 'Falha ao invocar IA demoníaca');
      }

      const { result } = (await resp.json()) as { ok: boolean; result: DemonicAiGenerationResult };

      setTitle(result.title);
      setInformation(result.information);
      setAdditionalText(result.additionalText);
      setInsultText(result.insultText);
      setClosingText(result.closingText);
      setWatermarkText(result.watermarkText || '@5573satan');
      setCustomCaption(result.caption);
      setCustomHashtags(result.hashtags);

      let newImagesBase64 = collectedImagesBase64;

      if (result.aiImagesBase64 && result.aiImagesBase64.length > 0) {
        setImageSlots([
          result.aiImagesBase64[0]
            ? { name: '⛧ Selo de Baphomet AI', dataUrl: result.aiImagesBase64[0] }
            : null,
          result.aiImagesBase64[1]
            ? { name: '⛧ Laços do Purgatório AI', dataUrl: result.aiImagesBase64[1] }
            : null,
          result.aiImagesBase64[2]
            ? { name: '⛧ Decreto Tartárico AI', dataUrl: result.aiImagesBase64[2] }
            : null,
        ]);
        newImagesBase64 = result.aiImagesBase64;
      }

      setAiModalOpen(false);

      const providerLabel = result.provider === 'groq' ? `Groq (${result.model})` : `Gemini (${result.model})`;
      setFeedback({
        type: 'success',
        text: `⛧ Dados processados via ${providerLabel} com trilha russa (migas, shluzov, 7leaf, xishqa)! Vídeo gerado com sucesso.`,
      });

      // Auto-trigger preview generation with the freshly formulated demonic data
      void handleGeneratePreview({
        title: result.title,
        information: result.information,
        images: newImagesBase64,
        additionalText: result.additionalText,
        insultText: result.insultText,
        closingText: result.closingText,
        watermarkText: result.watermarkText || '@5573satan',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao comunicar com o oráculo de IA.',
      });
    } finally {
      setAiGenerating(false);
    }
  };

  /**
   * Quick Submit handler ("Envio Rápido de Dados")
   */
  const handleQuickSubmit = async () => {
    if (!quickExpData.trim()) {
      setFeedback({ type: 'error', text: 'Digite os dados ou informações para gerar o vídeo.' });
      return;
    }
    await handleInvokeDemonicAi(quickExpData.trim());
  };

  /**
   * Interactive Drag & Swipe handlers ("arrastar para o lado")
   */
  const handleDragStart = (clientX: number) => {
    if (slides.length <= 1) return;
    setIsDragging(true);
    setDragStartX(clientX);
    setDragCurrentX(clientX);
  };

  const handleDragMove = (clientX: number) => {
    if (!isDragging) return;
    setDragCurrentX(clientX);
  };

  const handleDragEnd = () => {
    if (!isDragging) return;
    const deltaX = dragCurrentX - dragStartX;
    const threshold = 45; // drag threshold in pixels

    if (deltaX < -threshold) {
      // Swiped left -> Next slide
      setActiveSlideIdx((prev) => (prev + 1) % slides.length);
      setSlideProgress(0);
    } else if (deltaX > threshold) {
      // Swiped right -> Previous slide
      setActiveSlideIdx((prev) => (prev - 1 + slides.length) % slides.length);
      setSlideProgress(0);
    }

    setIsDragging(false);
    setDragStartX(0);
    setDragCurrentX(0);
  };

  // Mouse drag events
  const onMouseDown = (e: ReactMouseEvent) => {
    handleDragStart(e.clientX);
  };
  const onMouseMove = (e: ReactMouseEvent) => {
    handleDragMove(e.clientX);
  };
  const onMouseUp = () => {
    handleDragEnd();
  };
  const onMouseLeave = () => {
    if (isDragging) handleDragEnd();
  };

  // Touch swipe events
  const onTouchStart = (e: ReactTouchEvent) => {
    if (e.touches.length === 1) {
      handleDragStart(e.touches[0].clientX);
    }
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    if (isDragging && e.touches.length === 1) {
      handleDragMove(e.touches[0].clientX);
    }
  };
  const onTouchEnd = () => {
    handleDragEnd();
  };

  const handleCreateAndOptionallyPublish = async (mode: 'save' | 'publish' | 'draft') => {
    if (title.trim().length < 2) {
      setFeedback({ type: 'error', text: 'Preencha o passo 1 (Título) para continuar.' });
      return;
    }
    if (information.trim().length < 3) {
      setFeedback({ type: 'error', text: 'Preencha o passo 2 (Informações) para continuar.' });
      return;
    }

    setSubmitting(mode);
    setFeedback(null);

    try {
      const resp = await apiFetch('/api/exp/studio/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId: targetGuildId,
          title,
          information,
          imagesBase64: collectedImagesBase64,
          additionalText,
          insultText,
          closingText,
          watermarkText,
          theme,
          audioMode,
          selectedAudioTrack: audioMode === 'custom' ? selectedTrack : activeAudioTrack,
          carouselMode,
          publishNow: mode !== 'save',
          draftOnly: mode === 'draft',
          accountId: selectedAccountId || undefined,
          caption: customCaption.trim() || undefined,
          hashtags: customHashtags.trim() || undefined,
        }),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        record?: { expCode?: string | null; audioTrack?: ExpAudioTrackMeta | null };
        tiktokOutcome?: { outcome?: string; statusText?: string; error?: string } | null;
        error?: string;
      };

      if (!resp.ok || !data.ok) {
        setFeedback({
          type: 'error',
          text: data.error || 'Não foi possível concluir a criação do carrossel.',
        });
        return;
      }

      const audioInfo = data.record?.audioTrack
        ? ` · Música russa: ${data.record.audioTrack.artist} — ${data.record.audioTrack.title}`
        : '';

      if (mode === 'save') {
        setFeedback({
          type: 'success',
          text: `${data.record?.expCode || 'Carrossel EXP'} gerado com molduras demoníacas e salvo no histórico${audioInfo}.`,
        });
      } else if (
        data.tiktokOutcome?.outcome === 'published' ||
        data.tiktokOutcome?.outcome === 'inbox_draft'
      ) {
        setFeedback({
          type: 'success',
          text: `${data.record?.expCode || 'EXP'}: ${data.tiktokOutcome.statusText}${audioInfo}`,
        });
      } else {
        setFeedback({
          type: 'error',
          text: `${data.record?.expCode || 'EXP'} gerado e salvo, mas houve erro ao enviar ao TikTok: ${
            data.tiktokOutcome?.error || data.tiktokOutcome?.statusText || 'verifique sua conta TikTok.'
          }`,
        });
      }

      onCreated();
    } catch {
      setFeedback({ type: 'error', text: 'Erro de comunicação ao salvar/publicar o carrossel.' });
    } finally {
      setSubmitting(null);
    }
  };

  const currentSlide = slides[activeSlideIdx] ?? null;
  const dragDeltaX = isDragging ? dragCurrentX - dragStartX : 0;

  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6 shadow-sm">
      {/* Studio Header + Groq AI Trigger */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-200">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold tracking-tight text-slate-900">
              Estúdio Web de Carrossel EXP (1 a 8) · TikTok Video Player
            </h3>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-950 text-red-400 border border-red-800/80">
              <Flame className="w-3 h-3 text-red-500" />
              <span>5573 SATAN</span>
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 max-w-2xl">
            Crie carrosséis de fotos oficiais do TikTok com envio rápido de dados, áudios russos exclusivos (migas, shluzov, 7leaf, xishqa) e IA Groq Llama 3.3.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setAiModalOpen(true)}
            className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-red-950 via-red-900 to-black hover:from-red-900 hover:to-zinc-900 text-red-100 border border-red-700/80 text-xs font-semibold inline-flex items-center gap-2 shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Sparkles className="w-3.5 h-3.5 text-red-400 animate-pulse" />
            <span>⛧ Invocar IA Demoníaca (Groq)</span>
          </button>

          <div className="text-right shrink-0 pl-3 border-l border-slate-200">
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">EXP Previsto</div>
            <div className="text-sm font-mono font-bold text-red-700 tabular-nums">
              {previewExpCode}
            </div>
          </div>
        </div>
      </div>

      {/* Groq AI Invocation Modal */}
      {aiModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-lg rounded-2xl bg-[#0A0204] border border-red-900/80 p-6 space-y-5 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />

            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg">⛧</span>
                  <h4 className="text-base font-bold text-red-100 tracking-wide font-mono">
                    ORÁCULO DEMONÍACO 5573
                  </h4>
                </div>
                <p className="text-xs text-red-300/80 mt-1">
                  Gere acusações, fatores agravantes, insultos irrevogáveis e imagens artísticas de condenação com Groq Llama 3.3.
                </p>
              </div>

              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded-md border ${
                  groqConfigured
                    ? 'bg-emerald-950/80 border-emerald-600 text-emerald-300'
                    : 'bg-red-950/80 border-red-700 text-red-300'
                }`}
              >
                {groqConfigured ? '⚡ Groq Llama 3.3 70B' : '🤖 Gemini 2.5 Flash'}
              </span>
            </div>

            <div className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-red-200 block">
                  Nome do Alvo / @acusado
                </label>
                <input
                  type="text"
                  value={aiTargetName}
                  onChange={(e) => setAiTargetName(e.target.value)}
                  placeholder="Ex.: @usuario_infrator"
                  className="w-full h-9 px-3 rounded-lg bg-black/60 border border-red-900/60 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-red-500 font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-red-200 block">
                  Infrações & Pecados Cometidos (contexto breve)
                </label>
                <textarea
                  rows={3}
                  value={aiTopicContext}
                  onChange={(e) => setAiTopicContext(e.target.value)}
                  placeholder="Descreva as transgressões, golpes, mentiras, dossing, quebra de regras ou traições para a IA formular a condenação..."
                  className="w-full p-3 rounded-lg bg-black/60 border border-red-900/60 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-red-500"
                />
              </div>

              <label className="flex items-center gap-2.5 p-2.5 rounded-lg bg-red-950/40 border border-red-900/40 cursor-pointer text-xs text-red-200 select-none">
                <input
                  type="checkbox"
                  checked={aiGenerateArtworks}
                  onChange={(e) => setAiGenerateArtworks(e.target.checked)}
                  className="rounded border-red-700 text-red-600 focus:ring-red-500"
                />
                <span>
                  Gerar 3 Artes Visuais Demoníacas com IA (Selo de Baphomet, Correntes do Purgatório e Decreto Tartárico) para os slots de imagem
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-red-950">
              <button
                type="button"
                onClick={() => setAiModalOpen(false)}
                disabled={aiGenerating}
                className="px-3.5 py-1.5 rounded-lg border border-zinc-800 text-xs text-zinc-400 hover:text-white transition-colors"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={() => void handleInvokeDemonicAi()}
                disabled={aiGenerating}
                className="min-h-[36px] px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                {aiGenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Invocando Oráculo...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>⛧ Gerar Exposição Completa</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Feedback Banner */}
      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-xs sm:text-sm border transition-all ${
            feedback.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          {feedback.type === 'error' ? (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" aria-hidden="true" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Quick Input Bar + 8 Steps Form + Media Converter + Audio + Publishing Config */}
        <div className="lg:col-span-7 space-y-5">
          {/* Quick Submission Bar ("Envio Rápido de Dados") */}
          <div className="border border-red-900/50 rounded-2xl p-4 bg-gradient-to-r from-red-950/25 via-black/10 to-red-950/25 space-y-3 shadow-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-red-500 animate-pulse" />
              <span className="text-xs font-bold text-slate-900 font-mono tracking-wide">
                ENVIO RÁPIDO DE DADOS (IA AUTOMÁTICA)
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Escreva apenas os dados ou informações (ex: <code className="text-red-700 font-mono font-semibold">dados pessoais de @usuario...</code>). A inteligência artificial preenche e gera o vídeo do carrossel instantaneamente.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={quickExpData}
                onChange={(e) => setQuickExpData(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleQuickSubmit();
                }}
                placeholder="Ex.: dados pessoais de @usuario — conversas vazadas..."
                className="flex-1 h-11 px-4 rounded-xl border border-red-300 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600 shadow-sm"
              />
              <button
                type="button"
                onClick={() => void handleQuickSubmit()}
                disabled={aiGenerating}
                className="min-h-[44px] px-5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold inline-flex items-center gap-2 shrink-0 shadow-md transition-all active:scale-95 disabled:opacity-50 whitespace-nowrap"
              >
                {aiGenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processando...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Enviar e Gerar Vídeo</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Aesthetic Theme Selector */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
            <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
              <Flame className="w-3.5 h-3.5 text-red-600" />
              Estilo Visual das Molduras
            </span>
            <div className="inline-flex items-center gap-1 p-0.5 bg-slate-200/80 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setTheme('demonic')}
                className={`px-3 py-1 rounded-md font-semibold transition-all ${
                  theme === 'demonic'
                    ? 'bg-red-950 text-red-200 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                ⛧ Demoníaco Infernal
              </button>
              <button
                type="button"
                onClick={() => setTheme('gallery')}
                className={`px-3 py-1 rounded-md font-semibold transition-all ${
                  theme === 'gallery'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Clássico Noturno
              </button>
            </div>
          </div>

          {/* 1. Título */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="studio-title" className="text-xs font-semibold text-slate-900">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">01.</span>
                Título da Exposição
              </label>
              <span className="text-[11px] text-slate-400 tabular-nums">{title.length}/160</span>
            </div>
            <input
              id="studio-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
              placeholder="Ex.: ⛧ EXP 001: CONDENAÇÃO INFERNAL DE @usuario ⛧"
              className="w-full h-10 px-3.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600 font-medium"
            />
          </div>

          {/* 2. Informações */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="studio-info" className="text-xs font-semibold text-slate-900">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">02.</span>
                Informações Principais & Fatos
              </label>
              <span className="text-[11px] text-slate-400 tabular-nums">
                {information.length}/1200
              </span>
            </div>
            <textarea
              id="studio-info"
              rows={4}
              value={information}
              onChange={(e) => setInformation(e.target.value)}
              maxLength={1200}
              placeholder="Relato cronológico e detalhado das ocorrências. A tipografia e o enquadramento se ajustam automaticamente ao volume do texto..."
              className="w-full p-3.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600"
            />
          </div>

          {/* 3, 4, 5. Imagens ou Vídeos Convertidos */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-900">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">03 · 04 · 05.</span>
                Imagens & Vídeos (Extração Automática de Slides)
              </div>

              {/* Multi-video converter button */}
              <div>
                <input
                  ref={multiVideoInputRef}
                  type="file"
                  multiple
                  accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp"
                  onChange={(e) => void handleMultiVideoUpload(e)}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => multiVideoInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors"
                >
                  <Film className="w-3.5 h-3.5 text-red-600" />
                  <span>Enviar Vários Vídeos / Fotos</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {([0, 1, 2] as const).map((slotIndex) => {
                const slot = imageSlots[slotIndex];
                const stepNum = String(slotIndex + 3).padStart(2, '0');
                const isFiltering = filteringSlotIdx === slotIndex;

                return (
                  <div
                    key={slotIndex}
                    className="border border-slate-200 rounded-xl p-3 bg-slate-50/80 flex flex-col justify-between gap-2.5"
                  >
                    <input
                      ref={(el) => {
                        fileInputRefs.current[slotIndex] = el;
                      }}
                      type="file"
                      accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp"
                      onChange={(e) => void handleSlotFileChange(slotIndex, e)}
                      className="hidden"
                    />

                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-semibold text-slate-700 tabular-nums">
                        {stepNum}. Evidência {slotIndex + 1}
                      </span>
                      {slot && (
                        <button
                          type="button"
                          onClick={() => handleRemoveSlot(slotIndex)}
                          className="text-slate-400 hover:text-red-600 p-0.5 transition-colors"
                          aria-label={`Remover mídia ${slotIndex + 1}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {slot ? (
                      <div className="space-y-2">
                        <div className="relative group rounded-lg overflow-hidden border border-slate-300 bg-black">
                          <img
                            src={slot.dataUrl}
                            alt={`Slide ${slotIndex + 1}`}
                            className="w-full h-28 object-cover"
                          />
                          {slot.videoInfo && (
                            <span className="absolute bottom-1 left-1 bg-black/80 backdrop-blur-sm text-red-400 text-[9px] px-1.5 py-0.5 rounded font-mono font-medium">
                              {slot.videoInfo}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => fileInputRefs.current[slotIndex]?.click()}
                            className="flex-1 py-1 px-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-[10px] font-medium text-slate-700 truncate"
                          >
                            Trocar
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleApplyDemonicFilter(slotIndex)}
                            disabled={isFiltering}
                            title="Aplica filtro demoníaco de alto contraste vermelho e runas infernais"
                            className="py-1 px-2 rounded-lg bg-red-950 border border-red-800 text-red-200 hover:bg-red-900 text-[10px] font-semibold inline-flex items-center gap-1 shrink-0"
                          >
                            <Flame className={`w-3 h-3 text-red-400 ${isFiltering ? 'animate-spin' : ''}`} />
                            <span>Filtro</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRefs.current[slotIndex]?.click()}
                        className="h-28 w-full rounded-lg border border-dashed border-slate-300 bg-white hover:bg-slate-50 text-slate-600 flex flex-col items-center justify-center gap-1.5 text-xs font-medium transition-colors"
                      >
                        <ImagePlus className="w-4 h-4 text-slate-500" aria-hidden="true" />
                        <span>Enviar Vídeo ou Imagem</span>
                        <span className="text-[10px] text-slate-400 font-normal">MP4, WebM ou JPG</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 6. Texto Adicional */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="studio-additional" className="text-xs font-semibold text-slate-900">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">06.</span>
                Texto Adicional / Fatores Agravantes (opcional)
              </label>
              <span className="text-[11px] text-slate-400 tabular-nums">
                {additionalText.length}/1000
              </span>
            </div>
            <textarea
              id="studio-additional"
              rows={3}
              value={additionalText}
              onChange={(e) => setAdditionalText(e.target.value)}
              maxLength={1000}
              placeholder="Histórico de mentiras, cumplicidade, reincidência ou notas extras do purgatório..."
              className="w-full p-3.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600"
            />
          </div>

          {/* 7. Insulto */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="studio-insult" className="text-xs font-semibold text-slate-900">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">07.</span>
                Insulto / Maldição Demoníaca (opcional)
              </label>
              <span className="text-[11px] text-slate-400 tabular-nums">
                {insultText.length}/600
              </span>
            </div>
            <textarea
              id="studio-insult"
              rows={2}
              value={insultText}
              onChange={(e) => setInsultText(e.target.value)}
              maxLength={600}
              placeholder="Frase de desprezo ou condenação em moldura destacada..."
              className="w-full p-3.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600"
            />
          </div>

          {/* 8. Finalização + Marca d'água */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="studio-closing" className="text-xs font-semibold text-slate-900 block">
                <span className="font-mono text-red-600 mr-1.5 tabular-nums">08.</span>
                Finalização / Decreto
              </label>
              <input
                id="studio-closing"
                type="text"
                value={closingText}
                onChange={(e) => setClosingText(e.target.value)}
                maxLength={240}
                placeholder="Ex.: ⛧ SENTENÇA DEFINITIVA SELADA · EXPILATIO INFERNALIS ⛧"
                className="w-full h-10 px-3.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-red-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="studio-watermark" className="text-xs font-semibold text-slate-900 block">
                Marca d’água (em todas as molduras)
              </label>
              <input
                id="studio-watermark"
                type="text"
                value={watermarkText}
                onChange={(e) => setWatermarkText(e.target.value)}
                maxLength={48}
                placeholder="@5573satan"
                className="w-full h-10 px-3.5 rounded-lg border border-slate-200 bg-white text-sm font-mono text-red-700 placeholder:text-slate-400 focus:outline-none focus:border-red-600"
              />
            </div>
          </div>

          {/* Russian Audio Section (Featuring migas, shluzov, 7leaf, xishqa) */}
          <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Music className="w-4 h-4 text-red-600" aria-hidden="true" />
                <span className="text-xs font-semibold text-slate-900">
                  Trilha Sonora Russa (migas, shluzov, 7leaf, xishqa)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="inline-flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setAudioMode('auto')}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                      audioMode === 'auto'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Automático diferente
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudioMode('custom')}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                      audioMode === 'custom'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Escolher faixa
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => void loadRussianTracks(true)}
                  disabled={tracksLoading}
                  className="min-h-[30px] px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[11px] font-medium text-slate-700 inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${tracksLoading ? 'animate-spin' : ''}`} />
                  <span>Trocar lista</span>
                </button>
              </div>
            </div>

            {audioMode === 'auto' ? (
              <p className="text-xs text-slate-600">
                Cada publicação sorteia uma música russa diferente priorizando <span className="font-semibold text-red-700">migas, shluzov, 7leaf, xishqa</span>, DVRST, Molchat Doma e outros.
              </p>
            ) : (
              <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
                {tracks.length === 0 ? (
                  <div className="text-xs text-slate-500 py-3 text-center">
                    {tracksLoading ? 'Buscando catálogo russo...' : 'Nenhuma faixa carregada.'}
                  </div>
                ) : (
                  tracks.map((track) => {
                    const isSelected = selectedTrack?.id === track.id;
                    const isPlaying = playingTrackId === track.id;
                    return (
                      <div
                        key={track.id}
                        className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs transition-colors ${
                          isSelected
                            ? 'bg-red-50/60 border-red-500 text-slate-900'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-white'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTrack(track);
                            setActiveAudioTrack({
                              id: track.id,
                              artist: track.artist,
                              title: track.title,
                              previewUrl: track.previewUrl,
                            });
                          }}
                          className="flex-1 text-left min-w-0 truncate"
                        >
                          <span className="font-semibold text-slate-900">{track.artist}</span>
                          <span className="text-slate-400 mx-1.5">—</span>
                          <span className="text-slate-700">{track.title}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleTogglePlayTrack(track)}
                          className="w-7 h-7 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 inline-flex items-center justify-center shrink-0"
                          aria-label={isPlaying ? 'Pausar música' : 'Ouvir música'}
                        >
                          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* TikTok Publishing Settings */}
          <div className="border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Modo de divulgação TikTok
                </label>
                <select
                  value={carouselMode}
                  onChange={(e) => setCarouselMode(e.target.value as CarouselPublishMode)}
                  className="w-full h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900"
                >
                  <option value="video_slideshow">
                    Carrossel em Vídeo + Áudio Russo (MP4 sincronizado)
                  </option>
                  <option value="photo_carousel">
                    Carrossel Oficial de Fotos (Swipe Nativo TikTok)
                  </option>
                </select>
              </div>

              {!fixedGuildId ? (
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Destino do registro
                  </label>
                  <select
                    value={targetGuildId}
                    onChange={(e) => setTargetGuildId(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900"
                  >
                    <option value="web-studio">Direto do Site (Estúdio Web)</option>
                    {managedGuilds.map((g) => (
                      <option key={g.id} value={g.id}>
                        Servidor: {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Servidor vinculado
                  </label>
                  <div className="h-9 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-700 flex items-center truncate">
                    {fixedGuildName || fixedGuildId}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Legenda TikTok
                </label>
                <input
                  type="text"
                  value={customCaption}
                  onChange={(e) => setCustomCaption(e.target.value)}
                  placeholder={`${previewExpCode} — Condenação infernal`}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Hashtags
                </label>
                <input
                  type="text"
                  value={customHashtags}
                  onChange={(e) => setCustomHashtags(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-mono text-slate-900"
                />
              </div>
            </div>

            {tiktokAccounts.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="text-xs text-slate-600">Conta TikTok conectada (Zernio):</span>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-900"
                >
                  {tiktokAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      @{acc.username} {acc.isDefault ? '(Padrão)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => void handleGeneratePreview()}
              disabled={generatingPreview || submitting !== null}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-red-200 bg-red-50/60 hover:bg-red-100/80 text-xs font-semibold text-red-900 inline-flex items-center gap-2 whitespace-nowrap disabled:opacity-50 transition-colors"
            >
              <Eye className="w-4 h-4 text-red-600" aria-hidden="true" />
              <span>{generatingPreview ? 'Gerando molduras...' : 'Gerar Prévia no Player'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleCreateAndOptionallyPublish('save')}
              disabled={submitting !== null || generatingPreview}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-2 whitespace-nowrap disabled:opacity-50"
            >
              <Save className="w-4 h-4 text-slate-600" aria-hidden="true" />
              <span>{submitting === 'save' ? 'Salvando...' : 'Salvar no Histórico'}</span>
            </button>

            {tiktokConnected ? (
              <button
                type="button"
                onClick={() => void handleCreateAndOptionallyPublish('publish')}
                disabled={submitting !== null || generatingPreview}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-black hover:bg-zinc-900 text-white text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap disabled:opacity-50 shadow-sm"
              >
                <Send className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
                <span>{submitting === 'publish' ? 'Publicando...' : 'Publicar no TikTok Agora'}</span>
              </button>
            ) : (
              onOpenTikTokSettings && (
                <button
                  type="button"
                  onClick={onOpenTikTokSettings}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap"
                >
                  <span>Conectar TikTok para Publicar</span>
                </button>
              )
            )}
          </div>
        </div>

        {/* Right Column: Live TikTok Video Carousel Player with Drag & Swipe */}
        <div className="lg:col-span-5 lg:sticky lg:top-20 space-y-4">
          <div className="border border-slate-200 rounded-2xl bg-slate-900 p-4 text-white space-y-4 shadow-xl">
            {/* Player Controls Bar */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800 text-xs">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPlayerViewMode('tiktok')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                    playerViewMode === 'tiktok'
                      ? 'bg-red-900 text-red-100'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  📱 Player TikTok
                </button>
                <button
                  type="button"
                  onClick={() => setPlayerViewMode('clean')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                    playerViewMode === 'clean'
                      ? 'bg-slate-700 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  🖼️ Moldura Pura
                </button>
              </div>

              {slides.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAudioMuted(!audioMuted)}
                    className="p-1 rounded-md hover:bg-slate-800 text-slate-300"
                    title={audioMuted ? 'Desmutar áudio russo' : 'Mutar áudio russo'}
                  >
                    {audioMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                  </button>

                  <span className="font-mono text-slate-400 text-[11px] tabular-nums">
                    {String(activeSlideIdx + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                  </span>
                </div>
              )}
            </div>

            {currentSlide ? (
              <div className="space-y-3">
                {/* Smartphone / TikTok Canvas Wrapper */}
                <div
                  ref={carouselContainerRef}
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseLeave}
                  onTouchStart={onTouchStart}
                  onTouchMove={onTouchMove}
                  onTouchEnd={onTouchEnd}
                  className="relative rounded-2xl overflow-hidden border border-slate-800 bg-[#080204] aspect-[4/5] shadow-2xl select-none cursor-grab active:cursor-grabbing group"
                >
                  {/* Top Segmented Story/Slideshow Progress Bars (TikTok style) */}
                  {slides.length > 1 && (
                    <div className="absolute top-2.5 inset-x-3 z-30 flex items-center gap-1.5 pointer-events-auto">
                      {slides.map((_, idx) => {
                        let fillPct = 0;
                        if (idx < activeSlideIdx) fillPct = 100;
                        else if (idx === activeSlideIdx) fillPct = slideProgress;

                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveSlideIdx(idx);
                              setSlideProgress(0);
                            }}
                            aria-label={`Ir para o slide ${idx + 1}`}
                            className="flex-1 h-1 rounded-full bg-white/25 overflow-hidden transition-all hover:h-1.5 focus:outline-none"
                          >
                            <div
                              className="h-full bg-white transition-all duration-75"
                              style={{ width: `${fillPct}%` }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Main Slide Image with Smooth Horizontal Drag Transform */}
                  <div
                    className="w-full h-full flex items-center justify-center transition-transform duration-150 ease-out"
                    style={{
                      transform: isDragging ? `translateX(${dragDeltaX * 0.75}px) scale(0.98)` : 'none',
                    }}
                  >
                    <img
                      src={currentSlide.dataUrl}
                      alt={currentSlide.label}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-contain pointer-events-none"
                    />
                  </div>

                  {/* TikTok Interactive Overlay */}
                  {playerViewMode === 'tiktok' && (
                    <>
                      {/* Top gradient shadow */}
                      <div className="absolute top-0 inset-x-0 h-16 bg-gradient-to-b from-black/70 via-black/30 to-transparent pointer-events-none z-10" />

                      {/* Bottom gradient shadow for readable text */}
                      <div className="absolute bottom-0 inset-x-0 h-36 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none z-10" />

                      {/* Right Action Bar (Heart, Comments, Bookmark, Share, Vinyl Disc) */}
                      <div className="absolute right-2.5 bottom-12 z-20 flex flex-col items-center gap-3.5 pointer-events-auto">
                        {/* Avatar */}
                        <div className="relative">
                          <div className="w-9 h-9 rounded-full bg-red-950 border-2 border-white flex items-center justify-center text-xs font-mono font-bold text-red-200 shadow-md">
                            5573
                          </div>
                          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center text-[10px] font-bold">
                            +
                          </span>
                        </div>

                        {/* Heart */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLiked(!liked);
                          }}
                          className="flex flex-col items-center gap-0.5 group/btn"
                        >
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-125 ${
                              liked ? 'text-red-500 fill-red-500' : 'text-white'
                            }`}
                          >
                            <Heart className={`w-6 h-6 ${liked ? 'fill-current' : ''}`} />
                          </div>
                          <span className="text-[10px] font-semibold text-white/90">66.6K</span>
                        </button>

                        {/* Comments */}
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center text-white">
                            <MessageCircle className="w-6 h-6" />
                          </div>
                          <span className="text-[10px] font-semibold text-white/90">5.5K</span>
                        </div>

                        {/* Bookmark */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSaved(!saved);
                          }}
                          className="flex flex-col items-center gap-0.5"
                        >
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-125 ${
                              saved ? 'text-yellow-400 fill-yellow-400' : 'text-white'
                            }`}
                          >
                            <Bookmark className={`w-6 h-6 ${saved ? 'fill-current' : ''}`} />
                          </div>
                          <span className="text-[10px] font-semibold text-white/90">6.6K</span>
                        </button>

                        {/* Share */}
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center text-white">
                            <Share2 className="w-5 h-5" />
                          </div>
                          <span className="text-[10px] font-semibold text-white/90">666</span>
                        </div>

                        {/* Rotating Vinyl Sound Disc */}
                        <div className="relative pt-1">
                          <div
                            className={`w-9 h-9 rounded-full bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center shadow-lg ${
                              isVideoPlaying ? 'animate-spin' : ''
                            }`}
                            style={{ animationDuration: '4s' }}
                          >
                            <div className="w-4 h-4 rounded-full bg-red-700 border border-zinc-900 flex items-center justify-center">
                              <span className="text-[7px]">⛧</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Bottom-left Information Overlay */}
                      <div className="absolute left-3.5 bottom-3.5 right-16 z-20 pointer-events-none text-left space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-white tracking-wide">@5573satan</span>
                          <span className="w-3.5 h-3.5 rounded-full bg-red-600 text-white flex items-center justify-center text-[9px] font-bold">
                            ✓
                          </span>
                        </div>

                        <div className="text-[11px] text-zinc-200 line-clamp-2 leading-tight">
                          <span className="text-red-400 font-semibold mr-1 font-mono">
                            [{currentSlide.label}]
                          </span>
                          {title || 'Exposição Oficial 5573'}
                        </div>

                        <div className="text-[10px] font-mono text-zinc-400 truncate">
                          #5573 #satan #exp #demoniaco #exposed #russia
                        </div>

                        {/* Russian Audio Ticker */}
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-300 font-mono pt-0.5">
                          <Music className="w-3 h-3 text-red-400 shrink-0" />
                          <span className="truncate">
                            {activeAudioTrack
                              ? `${activeAudioTrack.artist} — ${activeAudioTrack.title}`
                              : selectedTrack
                              ? `${selectedTrack.artist} — ${selectedTrack.title}`
                              : 'migas — Russian Phonk'}
                          </span>
                        </div>
                      </div>

                      {/* Center Play/Pause button on hover / tap */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsVideoPlaying(!isVideoPlaying);
                        }}
                        aria-label={isVideoPlaying ? 'Pausar vídeo' : 'Reproduzir vídeo'}
                        className="absolute inset-0 z-10 flex items-center justify-center bg-black/15 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-md text-white flex items-center justify-center shadow-lg border border-white/20">
                          {isVideoPlaying ? (
                            <Pause className="w-5 h-5" />
                          ) : (
                            <Play className="w-5 h-5 ml-0.5" />
                          )}
                        </div>
                      </button>
                    </>
                  )}

                  {/* Manual Arrow Navigators */}
                  {slides.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveSlideIdx((prev) => (prev - 1 + slides.length) % slides.length);
                          setSlideProgress(0);
                        }}
                        aria-label="Slide anterior"
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/60 hover:bg-black/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity border border-white/10"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveSlideIdx((prev) => (prev + 1) % slides.length);
                          setSlideProgress(0);
                        }}
                        aria-label="Próximo slide"
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/60 hover:bg-black/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity border border-white/10"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>

                {/* Helpful drag prompt */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
                  <span className="flex items-center gap-1">
                    <span className="text-red-400 font-bold">↔</span> Arraste para o lado para avançar os slides
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsVideoPlaying(!isVideoPlaying)}
                    className="text-red-400 hover:text-red-300 font-semibold inline-flex items-center gap-1"
                  >
                    {isVideoPlaying ? (
                      <>
                        <Pause className="w-3 h-3" /> Pausar Vídeo
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3" /> Tocar Vídeo
                      </>
                    )}
                  </button>
                </div>

                {/* Clickable thumbnail strip */}
                <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-4 gap-2 pt-1">
                  {slides.map((s, idx) => (
                    <button
                      key={s.index}
                      type="button"
                      onClick={() => {
                        setActiveSlideIdx(idx);
                        setSlideProgress(0);
                      }}
                      className={`rounded-lg overflow-hidden border text-left transition-all ${
                        idx === activeSlideIdx
                          ? 'border-red-500 ring-2 ring-red-500/50 scale-[1.03]'
                          : 'border-slate-800 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img
                        src={s.dataUrl}
                        alt={s.label}
                        className="w-full aspect-[4/5] object-cover bg-black"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="aspect-[4/5] rounded-xl border border-dashed border-slate-700 bg-slate-950/60 flex flex-col items-center justify-center text-center p-6 space-y-3">
                <div className="w-12 h-12 rounded-full bg-red-950/70 border border-red-800 flex items-center justify-center text-red-400 text-lg">
                  ⛧
                </div>
                <div className="text-sm font-semibold text-slate-200">
                  Carrossel Demoníaco TikTok (1 a 8)
                </div>
                <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
                  Digite os dados à esquerda ou clique em Enviar e Gerar Vídeo para que a IA estruture todo o carrossel.
                </p>
                <div className="pt-2 flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAiModalOpen(true)}
                    className="px-3.5 py-1.5 rounded-lg bg-red-900/70 hover:bg-red-800 text-red-100 text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Abrir Oráculo Groq</span>
                  </button>
                </div>
              </div>
            )}

            {/* Active Audio Indicator */}
            {activeAudioTrack && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/80 p-3 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-zinc-300">
                  <span className="text-slate-400 text-[11px]">Trilha Sonora Russa:</span>
                  <span className="font-semibold text-white truncate ml-2">
                    {activeAudioTrack.artist} — {activeAudioTrack.title}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
