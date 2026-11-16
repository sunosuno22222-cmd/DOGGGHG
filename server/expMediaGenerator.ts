import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  EXP_HASHTAGS,
  formatExpCode,
  getExpMediaDir,
  type ExpFormat,
} from './expStore.ts';

const execFileAsync = promisify(execFile);

export interface ExpContentInput {
  expId: string;
  expNumber: number;
  involvedName: string;
  description: string;
  whatHappened: string;
  whyWrong: string;
  mediaLinks: string[];
  otherLinks: string[];
}

export interface GeneratedCarouselResult {
  files: string[];
  filePaths: string[];
  slideCount: number;
  verifiedEvidenceImages: number;
}

export interface GeneratedVideoResult {
  files: string[];
  videoFile: string;
  videoPath: string;
  previewImagePath: string;
  durationSeconds: number;
  verifiedEvidenceImages: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const paragraphs = text.replace(/\r/g, '').split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    const normalized = para.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    const words = normalized.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxCharsPerLine) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
          if (lines.length >= maxLines) break;
        }
        current =
          word.length > maxCharsPerLine ? `${word.slice(0, maxCharsPerLine - 1)}…` : word;
      }
    }

    if (lines.length >= maxLines) break;
    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) break;
    }
  }

  return lines.slice(0, maxLines);
}

interface VerifiedEvidenceImage {
  sourceUrl: string;
  buffer: Buffer;
}

function isSafePublicHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchVerifiedEvidenceImages(urls: string[]): Promise<VerifiedEvidenceImage[]> {
  const results: VerifiedEvidenceImage[] = [];
  for (const url of urls.slice(0, 6)) {
    if (!isSafePublicHttpUrl(url)) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AphExpBot/1.0' },
      });
      clearTimeout(timer);
      if (!resp.ok) continue;

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) continue;

      const arrBuf = await resp.arrayBuffer();
      if (arrBuf.byteLength === 0 || arrBuf.byteLength > 10 * 1024 * 1024) continue;
      const buf = Buffer.from(arrBuf);
      const meta = await sharp(buf).metadata().catch(() => null);
      if (!meta || !meta.width || !meta.height) continue;

      results.push({ sourceUrl: url, buffer: buf });
      if (results.length >= 3) break;
    } catch {
      // Ignore unreachable evidence URLs cleanly
    }
  }
  return results;
}

function renderLinesSvg(
  lines: string[],
  x: number,
  startY: number,
  lineHeight: number,
  fontSize: number,
  color: string,
  fontWeight = '400',
  anchor: 'start' | 'middle' = 'start',
): string {
  return lines
    .map(
      (line, idx) =>
        `<text x="${x}" y="${startY + idx * lineHeight}" text-anchor="${anchor}" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${color}">${escapeXml(line)}</text>`,
    )
    .join('\n');
}

function renderSlideHeaderSvg(width: number, expCode: string, sectionLabel: string, pageTag: string): string {
  return `
    <rect x="72" y="64" width="${width - 144}" height="1" fill="rgba(255,255,255,0.10)"/>
    <text x="72" y="106" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="22" font-weight="700" letter-spacing="3" fill="#A1A1AA">${escapeXml(expCode.toUpperCase())}</text>
    <text x="${width - 72}" y="106" text-anchor="end" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="22" font-weight="600" fill="#71717A">${escapeXml(pageTag)}</text>
    <text x="72" y="180" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="38" font-weight="700" fill="#FAFAFA">${escapeXml(sectionLabel)}</text>
    <rect x="72" y="206" width="64" height="4" rx="2" fill="#E4E4E7"/>
  `;
}

function renderSlideFooterSvg(width: number, height: number, expCode: string): string {
  return `
    <rect x="72" y="${height - 104}" width="${width - 144}" height="1" fill="rgba(255,255,255,0.08)"/>
    <text x="72" y="${height - 60}" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="600" fill="#A1A1AA">${escapeXml(`${expCode} · ${EXP_HASHTAGS}`)}</text>
  `;
}

function buildCarouselBaseSvg(width: number, height: number, innerSvg: string): Buffer {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#18191D"/>
          <stop offset="55%" stop-color="#1E2025"/>
          <stop offset="100%" stop-color="#121317"/>
        </linearGradient>
        <radialGradient id="topGlow" cx="50%" cy="15%" r="65%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.06)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
      <rect width="${width}" height="${height}" fill="url(#topGlow)"/>
      ${innerSvg}
    </svg>`,
  );
}

/**
 * Generates a pre-submission preview image (JPEG) without saving permanent media files.
 */
export async function generateExpDraftPreview(params: {
  nextExpNumber: number;
  involvedName: string;
  description: string;
  whatHappened: string;
  whyWrong: string;
  mediaLinksCount: number;
  otherLinksCount: number;
  format: ExpFormat;
}): Promise<Buffer> {
  const W = 1080;
  const H = 1350;
  const expCode = formatExpCode(params.nextExpNumber);
  const formatLabel =
    params.format === 'carousel'
      ? 'Prévia · Carrossel de Imagens'
      : 'Prévia · Vídeo Vertical (1080×1920)';

  const descLines = wrapLines(params.description, 34, 3);
  const whatLines = wrapLines(params.whatHappened, 38, 4);
  const whyLines = wrapLines(params.whyWrong, 38, 3);
  const involvedLine = params.involvedName.trim()
    ? `Envolvido(a): ${params.involvedName.trim().slice(0, 42)}`
    : 'Envolvido(a): Não especificado';

  const totalLinks = params.mediaLinksCount + params.otherLinksCount;

  const svg = buildCarouselBaseSvg(
    W,
    H,
    `
      <rect x="72" y="72" width="380" height="44" rx="8" fill="#27272A"/>
      <text x="92" y="101" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#E4E4E7">${escapeXml(formatLabel)}</text>

      <text x="72" y="210" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="88" font-weight="700" fill="#FFFFFF">${escapeXml(expCode)}</text>
      <text x="72" y="260" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="25" font-weight="500" fill="#A1A1AA">${escapeXml(EXP_HASHTAGS)}</text>
      <text x="72" y="308" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="26" font-weight="600" fill="#E4E4E7">${escapeXml(involvedLine)}</text>

      <rect x="72" y="348" width="${W - 144}" height="240" rx="18" fill="rgba(255,255,255,0.035)"/>
      <text x="104" y="394" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#A1A1AA">DESCRIÇÃO DO OCORRIDO</text>
      ${renderLinesSvg(descLines, 104, 444, 42, 30, '#FAFAFA', '600')}

      <rect x="72" y="612" width="${W - 144}" height="280" rx="18" fill="rgba(255,255,255,0.03)"/>
      <text x="104" y="658" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#A1A1AA">O QUE ACONTECEU</text>
      ${renderLinesSvg(whatLines, 104, 706, 40, 27, '#E4E4E7', '400')}

      <rect x="72" y="916" width="${W - 144}" height="245" rx="18" fill="rgba(255,255,255,0.03)"/>
      <text x="104" y="962" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#A1A1AA">POR QUE É CONSIDERADO ERRADO</text>
      ${renderLinesSvg(whyLines, 104, 1010, 40, 27, '#E4E4E7', '400')}

      <text x="72" y="1220" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="23" font-weight="500" fill="#A1A1AA">${escapeXml(`Evidências anexadas: ${totalLinks} link(s) verificável(is)`)}</text>
      ${renderSlideFooterSvg(W, H, expCode)}
    `,
  );

  return await sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Generates individual 1080x1350 JPEG carousel slides with cover, structured pages,
 * real verified evidence slides (never fabricated), and closing card.
 */
export async function generateExpCarousel(input: ExpContentInput): Promise<GeneratedCarouselResult> {
  const W = 1080;
  const H = 1350;
  const expCode = formatExpCode(input.expNumber);
  const mediaDir = getExpMediaDir(input.expId);
  const verifiedImages = await fetchVerifiedEvidenceImages(input.mediaLinks);
  const allLinks = [...input.mediaLinks, ...input.otherLinks];

  const totalSlides =
    3 + // Cover + Description/WhatHappened + WhyWrong
    (verifiedImages.length > 0 ? verifiedImages.length : allLinks.length > 0 ? 1 : 0) +
    1; // Closing summary slide

  const slideBuffers: Buffer[] = [];
  let pageNum = 1;

  // Slide 1: Cover
  {
    const coverHeadline = wrapLines(input.description, 24, 4);
    const involvedText = input.involvedName.trim()
      ? `Identificação: ${input.involvedName.trim().slice(0, 44)}`
      : 'Ocorrência Registrada';
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <text x="72" y="112" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="22" font-weight="700" letter-spacing="3" fill="#A1A1AA">${escapeXml(`RELATO OFICIAL · ${pageNum}/${totalSlides}`)}</text>
        <rect x="72" y="210" width="290" height="86" rx="14" fill="#FAFAFA"/>
        <text x="217" y="270" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="52" font-weight="700" fill="#18191D">${escapeXml(expCode.toUpperCase())}</text>

        <text x="72" y="366" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="30" font-weight="600" fill="#D4D4D8">${escapeXml(involvedText)}</text>

        <rect x="72" y="420" width="${W - 144}" height="520" rx="22" fill="rgba(255,255,255,0.04)"/>
        ${renderLinesSvg(coverHeadline, 112, 540, 68, 48, '#FFFFFF', '700')}

        <text x="72" y="1060" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="500" fill="#A1A1AA">Arraste para ler os detalhes e evidências →</text>
        ${renderSlideFooterSvg(W, H, expCode)}
      `,
    );
    slideBuffers.push(await sharp(svg).jpeg({ quality: 92 }).toBuffer());
    pageNum += 1;
  }

  // Slide 2: What Happened
  {
    const descLines = wrapLines(input.description, 34, 4);
    const whatLines = wrapLines(input.whatHappened, 36, 11);
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        ${renderSlideHeaderSvg(W, expCode, '01 · O que aconteceu', `${pageNum}/${totalSlides}`)}
        <rect x="72" y="246" width="${W - 144}" height="245" rx="18" fill="rgba(255,255,255,0.035)"/>
        <text x="104" y="294" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="20" font-weight="700" fill="#A1A1AA">RESUMO DO OCORRIDO</text>
        ${renderLinesSvg(descLines, 104, 346, 42, 30, '#FAFAFA', '600')}

        <rect x="72" y="520" width="${W - 144}" height="650" rx="18" fill="rgba(255,255,255,0.025)"/>
        <text x="104" y="568" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="20" font-weight="700" fill="#A1A1AA">DETALHAMENTO DOS FATOS</text>
        ${renderLinesSvg(whatLines, 104, 622, 46, 30, '#E4E4E7', '400')}
        ${renderSlideFooterSvg(W, H, expCode)}
      `,
    );
    slideBuffers.push(await sharp(svg).jpeg({ quality: 92 }).toBuffer());
    pageNum += 1;
  }

  // Slide 3: Why It Is Wrong
  {
    const whyLines = wrapLines(input.whyWrong, 34, 14);
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        ${renderSlideHeaderSvg(W, expCode, '02 · Por que isso é errado', `${pageNum}/${totalSlides}`)}
        <rect x="72" y="256" width="${W - 144}" height="900" rx="20" fill="rgba(255,255,255,0.035)"/>
        <text x="104" y="308" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#A1A1AA">ANÁLISE DA OCORRÊNCIA</text>
        ${renderLinesSvg(whyLines, 104, 370, 50, 32, '#FAFAFA', '400')}
        ${renderSlideFooterSvg(W, H, expCode)}
      `,
    );
    slideBuffers.push(await sharp(svg).jpeg({ quality: 92 }).toBuffer());
    pageNum += 1;
  }

  // Slide 4..K: Real Verified Evidence Images OR Authentic Links Card
  if (verifiedImages.length > 0) {
    for (let idx = 0; idx < verifiedImages.length; idx++) {
      const ev = verifiedImages[idx];
      const boxW = W - 144;
      const boxH = 820;
      const fittedImg = await sharp(ev.buffer)
        .resize(boxW, boxH, { fit: 'contain', background: { r: 18, g: 19, b: 23, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();

      let sourceHost = ev.sourceUrl;
      try {
        sourceHost = new URL(ev.sourceUrl).hostname;
      } catch {
        // Keep raw URL
      }

      const bgSvg = buildCarouselBaseSvg(
        W,
        H,
        `
          ${renderSlideHeaderSvg(W, expCode, `03 · Evidência Real (${idx + 1}/${verifiedImages.length})`, `${pageNum}/${totalSlides}`)}
          <rect x="72" y="246" width="${boxW}" height="${boxH}" rx="18" fill="#121317"/>
          <text x="72" y="1120" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="22" font-weight="500" fill="#A1A1AA">${escapeXml(`Fonte verificada: ${sourceHost}`)}</text>
          ${renderSlideFooterSvg(W, H, expCode)}
        `,
      );

      const composed = await sharp(bgSvg)
        .composite([{ input: fittedImg, top: 246, left: 72 }])
        .jpeg({ quality: 92 })
        .toBuffer();

      slideBuffers.push(composed);
      pageNum += 1;
    }
  } else if (allLinks.length > 0) {
    const linkLines: string[] = [];
    for (const l of allLinks.slice(0, 6)) {
      linkLines.push(...wrapLines(`• ${l}`, 44, 2));
    }
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        ${renderSlideHeaderSvg(W, expCode, '03 · Links de Evidências', `${pageNum}/${totalSlides}`)}
        <rect x="72" y="256" width="${W - 144}" height="880" rx="20" fill="rgba(255,255,255,0.03)"/>
        <text x="104" y="308" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="700" fill="#A1A1AA">FONTES ENVIADAS NO RELATO</text>
        ${renderLinesSvg(linkLines, 104, 370, 44, 24, '#D4D4D8', '400')}
        ${renderSlideFooterSvg(W, H, expCode)}
      `,
    );
    slideBuffers.push(await sharp(svg).jpeg({ quality: 92 }).toBuffer());
    pageNum += 1;
  }

  // Final Slide: Closing Card
  {
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <text x="${W / 2}" y="420" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="24" font-weight="700" letter-spacing="4" fill="#A1A1AA">REGISTRO DE EXPOSIÇÃO</text>
        <text x="${W / 2}" y="530" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="96" font-weight="700" fill="#FFFFFF">${escapeXml(expCode)}</text>
        <text x="${W / 2}" y="610" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="30" font-weight="600" fill="#D4D4D8">${escapeXml(EXP_HASHTAGS)}</text>
        <rect x="${W / 2 - 120}" y="670" width="240" height="2" fill="rgba(255,255,255,0.16)"/>
        <text x="${W / 2}" y="745" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="26" font-weight="400" fill="#A1A1AA">Conteúdo revisado e aprovado antes da publicação.</text>
        ${renderSlideFooterSvg(W, H, expCode)}
      `,
    );
    slideBuffers.push(await sharp(svg).jpeg({ quality: 92 }).toBuffer());
  }

  const files: string[] = [];
  const filePaths: string[] = [];
  for (let i = 0; i < slideBuffers.length; i++) {
    const filename = `slide-${i + 1}.jpg`;
    const fullPath = path.resolve(mediaDir, filename);
    fs.writeFileSync(fullPath, slideBuffers[i]);
    files.push(filename);
    filePaths.push(fullPath);
  }

  return {
    files,
    filePaths,
    slideCount: files.length,
    verifiedEvidenceImages: verifiedImages.length,
  };
}

function buildSubtitleBarSvg(width: number, height: number, subtitleText: string): string {
  const lines = wrapLines(subtitleText, 34, 2);
  if (lines.length === 0) return '';
  const boxHeight = lines.length === 1 ? 84 : 130;
  const boxTop = height - 290;
  const textStartY = boxTop + 52;
  return `
    <rect x="68" y="${boxTop}" width="${width - 136}" height="${boxHeight}" rx="18" fill="rgba(10,11,15,0.88)"/>
    <rect x="68" y="${boxTop}" width="${width - 136}" height="${boxHeight}" rx="18" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
    ${renderLinesSvg(lines, width / 2, textStartY, 44, 34, '#FFFFFF', '700', 'middle')}
  `;
}

/**
 * Generates a vertical 1080x1920 H.264 MP4 video with crisp scene frames, burned-in captions/subtitles,
 * real verified evidence visuals (if provided), and smooth xfade transitions using sharp + ffmpeg.
 */
export async function generateExpVideo(input: ExpContentInput): Promise<GeneratedVideoResult> {
  const W = 1080;
  const H = 1920;
  const expCode = formatExpCode(input.expNumber);
  const mediaDir = getExpMediaDir(input.expId);
  const verifiedImages = await fetchVerifiedEvidenceImages(input.mediaLinks);

  interface SceneFrame {
    pngBuffer: Buffer;
    durationSec: number;
  }

  const scenes: SceneFrame[] = [];

  // Scene 1: Cover
  {
    const coverTitle = wrapLines(input.description, 22, 4);
    const involvedLabel = input.involvedName.trim()
      ? `Pessoa envolvida: ${input.involvedName.trim().slice(0, 42)}`
      : 'Caso registrado pelo canal EXP';

    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <rect x="84" y="210" width="320" height="88" rx="14" fill="#FAFAFA"/>
        <text x="244" y="272" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="54" font-weight="700" fill="#18191D">${escapeXml(expCode.toUpperCase())}</text>
        <text x="84" y="366" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="32" font-weight="600" fill="#A1A1AA">${escapeXml(EXP_HASHTAGS)}</text>
        <text x="84" y="456" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="34" font-weight="600" fill="#E4E4E7">${escapeXml(involvedLabel)}</text>

        <rect x="84" y="530" width="${W - 168}" height="740" rx="24" fill="rgba(255,255,255,0.04)"/>
        ${renderLinesSvg(coverTitle, 124, 690, 78, 56, '#FFFFFF', '700')}

        ${buildSubtitleBarSvg(W, H, `${expCode}: ${input.description}`)}
      `,
    );
    scenes.push({ pngBuffer: await sharp(svg).png().toBuffer(), durationSec: 3.5 });
  }

  // Scene 2: What happened
  {
    const whatLines = wrapLines(input.whatHappened, 30, 11);
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <text x="84" y="210" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="700" letter-spacing="3" fill="#A1A1AA">${escapeXml(`${expCode.toUpperCase()} · PARTE 01`)}</text>
        <text x="84" y="290" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="54" font-weight="700" fill="#FAFAFA">O que aconteceu</text>
        <rect x="84" y="328" width="84" height="5" rx="2.5" fill="#E4E4E7"/>

        <rect x="84" y="390" width="${W - 168}" height="1080" rx="24" fill="rgba(255,255,255,0.035)"/>
        ${renderLinesSvg(whatLines, 128, 490, 62, 40, '#FAFAFA', '500')}

        ${buildSubtitleBarSvg(W, H, input.whatHappened.slice(0, 120))}
      `,
    );
    scenes.push({ pngBuffer: await sharp(svg).png().toBuffer(), durationSec: 4.5 });
  }

  // Scene 3: Why it is wrong
  {
    const whyLines = wrapLines(input.whyWrong, 30, 11);
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <text x="84" y="210" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="700" letter-spacing="3" fill="#A1A1AA">${escapeXml(`${expCode.toUpperCase()} · PARTE 02`)}</text>
        <text x="84" y="290" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="54" font-weight="700" fill="#FAFAFA">Por que isso é errado</text>
        <rect x="84" y="328" width="84" height="5" rx="2.5" fill="#E4E4E7"/>

        <rect x="84" y="390" width="${W - 168}" height="1080" rx="24" fill="rgba(255,255,255,0.035)"/>
        ${renderLinesSvg(whyLines, 128, 490, 62, 40, '#FAFAFA', '500')}

        ${buildSubtitleBarSvg(W, H, input.whyWrong.slice(0, 120))}
      `,
    );
    scenes.push({ pngBuffer: await sharp(svg).png().toBuffer(), durationSec: 4.5 });
  }

  // Scene 4+: Real Verified Evidence Image(s) if provided
  if (verifiedImages.length > 0) {
    for (let i = 0; i < Math.min(2, verifiedImages.length); i++) {
      const ev = verifiedImages[i];
      const boxW = W - 168;
      const boxH = 1040;
      const fitted = await sharp(ev.buffer)
        .resize(boxW, boxH, { fit: 'contain', background: { r: 16, g: 17, b: 21, alpha: 1 } })
        .png()
        .toBuffer();

      let host = ev.sourceUrl;
      try {
        host = new URL(ev.sourceUrl).hostname;
      } catch {
        // fallback
      }

      const bgSvg = buildCarouselBaseSvg(
        W,
        H,
        `
          <text x="84" y="210" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="700" letter-spacing="3" fill="#A1A1AA">${escapeXml(`${expCode.toUpperCase()} · EVIDÊNCIA ${i + 1}`)}</text>
          <text x="84" y="290" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="52" font-weight="700" fill="#FAFAFA">Comprovante enviado</text>
          <rect x="84" y="360" width="${boxW}" height="${boxH}" rx="22" fill="#101115"/>
          ${buildSubtitleBarSvg(W, H, `Evidência verificável (${host})`)}
        `,
      );
      const composed = await sharp(bgSvg)
        .composite([{ input: fitted, top: 360, left: 84 }])
        .png()
        .toBuffer();
      scenes.push({ pngBuffer: composed, durationSec: 3.8 });
    }
  }

  // Final Scene: Outro
  {
    const svg = buildCarouselBaseSvg(
      W,
      H,
      `
        <text x="${W / 2}" y="700" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="700" letter-spacing="4" fill="#A1A1AA">EXPOSIÇÃO REGISTRADA</text>
        <text x="${W / 2}" y="840" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="112" font-weight="700" fill="#FFFFFF">${escapeXml(expCode)}</text>
        <text x="${W / 2}" y="930" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-size="36" font-weight="600" fill="#D4D4D8">${escapeXml(EXP_HASHTAGS)}</text>
        ${buildSubtitleBarSvg(W, H, `${expCode} · Aprovado pela moderação do servidor.`)}
      `,
    );
    scenes.push({ pngBuffer: await sharp(svg).png().toBuffer(), durationSec: 3.0 });
  }

  // Write temporary scene PNGs and save scene 0 as JPEG preview
  const previewPath = path.resolve(mediaDir, 'video-preview.jpg');
  await sharp(scenes[0].pngBuffer).jpeg({ quality: 90 }).toFile(previewPath);

  const scenePaths: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.resolve(mediaDir, `scene-${i}.png`);
    fs.writeFileSync(p, scenes[i].pngBuffer);
    scenePaths.push(p);
  }

  const videoFile = 'exp-video.mp4';
  const videoPath = path.resolve(mediaDir, videoFile);

  const transitionDuration = 0.4;
  const inputArgs: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    inputArgs.push('-loop', '1', '-t', scenes[i].durationSec.toFixed(2), '-i', scenePaths[i]);
  }
  // Silent audio track so TikTok video processor always receives valid video+audio streams
  inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  const filterParts: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    filterParts.push(`[${i}:v]fps=30,format=yuv420p,setsar=1[v${i}]`);
  }

  let prevLabel = 'v0';
  let cumulativeDuration = scenes[0].durationSec;
  for (let i = 1; i < scenes.length; i++) {
    const offset = Math.max(0.1, cumulativeDuration - transitionDuration);
    const outLabel = i === scenes.length - 1 ? 'vout' : `x${i}`;
    filterParts.push(
      `[${prevLabel}][v${i}]xfade=transition=slideleft:duration=${transitionDuration}:offset=${offset.toFixed(2)}[${outLabel}]`,
    );
    prevLabel = outLabel;
    cumulativeDuration = cumulativeDuration + scenes[i].durationSec - transitionDuration;
  }

  const finalVideoLabel = scenes.length === 1 ? 'v0' : 'vout';
  const audioInputIdx = scenes.length;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      `[${finalVideoLabel}]`,
      '-map',
      `${audioInputIdx}:a`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-shortest',
      '-movflags',
      '+faststart',
      videoPath,
    ],
    { timeout: 60_000 },
  );

  // Cleanup intermediate scene PNGs
  for (const p of scenePaths) {
    fs.unlink(p, () => {});
  }

  return {
    files: [videoFile, 'video-preview.jpg'],
    videoFile,
    videoPath,
    previewImagePath: previewPath,
    durationSeconds: Math.round(cumulativeDuration * 10) / 10,
    verifiedEvidenceImages: verifiedImages.length,
  };
}

/**
 * Compiles already-generated carousel JPEG slides into a smooth MP4 slideshow
 * (with silent AAC track) so autotok can publish carousel EXPs cleanly to TikTok.
 */
export async function generateCarouselSlideshowVideo(
  expId: string,
  slideFiles: string[],
): Promise<string> {
  const mediaDir = getExpMediaDir(expId);
  const existingPaths = slideFiles
    .map((f) => path.resolve(mediaDir, path.basename(f)))
    .filter((p) => fs.existsSync(p));

  if (existingPaths.length === 0) {
    throw new Error('Nenhum slide JPEG encontrado para compilar o envio ao TikTok.');
  }

  const outPath = path.resolve(mediaDir, 'exp-carousel.mp4');
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
    return outPath;
  }

  const slideDur = 3.2;
  const transDur = 0.35;
  const inputArgs: string[] = [];
  for (const slidePath of existingPaths) {
    inputArgs.push('-loop', '1', '-t', slideDur.toFixed(2), '-i', slidePath);
  }
  inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  const filterParts: string[] = [];
  for (let i = 0; i < existingPaths.length; i++) {
    filterParts.push(
      `[${i}:v]scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=#121317,fps=30,format=yuv420p,setsar=1[v${i}]`,
    );
  }

  let prevLabel = 'v0';
  let cumulative = slideDur;
  for (let i = 1; i < existingPaths.length; i++) {
    const offset = Math.max(0.1, cumulative - transDur);
    const outLabel = i === existingPaths.length - 1 ? 'vout' : `x${i}`;
    filterParts.push(
      `[${prevLabel}][v${i}]xfade=transition=slideleft:duration=${transDur}:offset=${offset.toFixed(2)}[${outLabel}]`,
    );
    prevLabel = outLabel;
    cumulative = cumulative + slideDur - transDur;
  }

  const finalVideoLabel = existingPaths.length === 1 ? 'v0' : 'vout';
  const audioIdx = existingPaths.length;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      `[${finalVideoLabel}]`,
      '-map',
      `${audioIdx}:a`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-shortest',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { timeout: 60_000 },
  );

  return outPath;
}

