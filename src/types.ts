export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

export interface ConfigStatus {
  oauthConfigured: boolean;
  botConfigured: boolean;
  botStatus: {
    connected: boolean;
    botTag: string | null;
    guildCount: number;
    error: string | null;
  };
  authenticated: boolean;
  user: DiscordUser | null;
  redirectUri: string;
}

export interface GuildItem {
  id: string;
  name: string;
  iconUrl: string | null;
  owner: boolean;
  isAdmin: boolean;
  botPresent: boolean;
}

export interface GuildsResponse {
  managedGuilds: GuildItem[];
  availableGuilds: GuildItem[];
}

export interface GuildTextChannel {
  id: string;
  name: string;
  categoryName: string | null;
}

export type BannerEventType = 'welcome' | 'leave';

export interface BannerRuleView {
  enabled: boolean;
  channelId: string | null;
  title: string;
  message: string;
  imageUrl: string | null;
}

export interface GuildWelcomeConfigResponse {
  guildId: string;
  updatedAt: string;
  restoredFromAccount?: boolean;
  hasSavedConfig?: boolean;
  welcome: BannerRuleView;
  leave: BannerRuleView;
}

export interface TikTokAccountInfo {
  id: string;
  accountKey: string;
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider?: 'autotok' | 'webhook' | 'online_service';
  isDefault?: boolean;
  connectedAt: string;
  updatedAt?: string;
  status?: 'active' | 'expired' | 'checking';
}

export interface TikTokStatusResponse {
  configured: boolean;
  connected: boolean;
  provider?: 'autotok' | 'webhook' | 'online_service';
  account: TikTokAccountInfo | null;
  accounts?: TikTokAccountInfo[];
  activeAccountId?: string | null;
  encryptedBackup?: string | null;
}

export interface TikTokLoginResult {
  ok: boolean;
  connected?: boolean;
  account?: TikTokAccountInfo | null;
  requires2Fa?: boolean;
  sessionId?: string | null;
  message?: string | null;
  error?: string | null;
  captchaRequired?: boolean;
}

export type TikTokQrPhase =
  | 'idle'
  | 'initializing'
  | 'pending_qr'
  | 'scanned_confirming'
  | 'connected'
  | 'expired'
  | 'error';

export interface TikTokQrState {
  active: boolean;
  sessionId: string | null;
  status: TikTokQrPhase;
  qrImageUrl: string | null;
  account: TikTokAccountInfo | null;
  error: string | null;
  expiresAt: number | null;
}

export type ExpFormat = 'carousel' | 'video';

export type ExpStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'awaiting_tiktok_confirmation'
  | 'published_tiktok'
  | 'tiktok_inbox'
  | 'tiktok_error';

export interface ExpRecordView {
  id: string;
  guildId: string;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  involvedName: string;
  description: string;
  whatHappened: string;
  whyWrong: string;
  mediaLinks: string[];
  otherLinks: string[];
  format: ExpFormat;
  status: ExpStatus;
  expNumber: number | null;
  expCode: string | null;
  caption: string | null;
  generatedFiles: string[];
  handledByTag: string | null;
  handledAt: string | null;
  tiktokPublishId: string | null;
  tiktokPublishMode: string | null;
  tiktokStatusText: string | null;
  tiktokError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpRecordsResponse {
  records: ExpRecordView[];
  nextExpNumber: number;
  nextExpCode: string;
}
