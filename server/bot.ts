import fs from 'node:fs';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import {
  getGuildConfig,
  hasSavedGuildConfig,
  saveGuildConfig,
  type BannerEventType,
} from './configStore.ts';
import {
  buildAdditionalSlashCommands,
  dispatchAdditionalSlashCommand,
  ensureMuralPanelsForGuild,
  handleMuralButtonInteraction,
  handleMuralModalInteraction,
  handleMuralSelectInteraction,
} from './commands.ts';
import {
  ensureExpPanelForGuild,
  handleExpButtonInteraction,
  handleExpModalInteraction,
} from './expCommands.ts';
import { loadServerTemplate } from './templateLoader.ts';
import { renderWelcomeBanner } from './welcomeRenderer.ts';
import { normalizeDiscordName } from './channelUtils.ts';
import {
  assignMemberRoleOnJoin,
  handleRegistrationButtonInteraction,
  runFullGuildSync,
} from './guildSync.ts';

export interface BotStatus {
  configured: boolean;
  connected: boolean;
  botTag: string | null;
  botId: string | null;
  guildCount: number;
  error: string | null;
}

const activeGuildOperations = new Set<string>();

let discordClient: Client | null = null;
let botConnectionError: string | null = null;
let botReady = false;
let reconnectPromise: Promise<BotStatus> | null = null;

function buildSlashCommands() {
  const pingCommand = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica a latência atual do bot com o Discord.');

  const aphCommand = new SlashCommandBuilder()
    .setName('aph')
    .setDescription('Executa a organização estrutural padronizada do servidor.')
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('Identificador do template: dog (principal) ou dogs1 (completo com extras).')
        .setRequired(true),
    );

  return [pingCommand.toJSON(), aphCommand.toJSON(), ...buildAdditionalSlashCommands()];
}

async function registerSlashCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), {
    body: buildSlashCommands(),
  });
}

async function handlePingCommand(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const wsPing = client.ws.ping;
  const latency =
    typeof wsPing === 'number' && wsPing >= 0
      ? Math.round(wsPing)
      : Math.max(1, Math.abs(Date.now() - interaction.createdTimestamp));

  await interaction.reply({
    content: `Pong! 🏓\nLatência: ${latency} ms`,
  });
}

function formatApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const maybeErr = err as { code?: number | string; message?: string };
    if (maybeErr.code === 50013) {
      return 'Permissões insuficientes na API do Discord (Missing Permissions). Verifique se o cargo do bot está acima dos canais/restrições ou possui permissão de Administrador.';
    }
    if (maybeErr.code === 50074) {
      return 'O Discord bloqueou a exclusão de um canal obrigatório de Servidor da Comunidade (ex.: canal de regras ou atualizações).';
    }
    if (maybeErr.message) {
      return maybeErr.message;
    }
  }
  return 'Erro inesperado ao comunicar com a API do Discord.';
}

async function executeStructureReplacement(
  guild: Guild,
  templateId: 'dog' | 'dogs1',
): Promise<{
  deletedCount: number;
  createdCategories: number;
  createdChannels: number;
  firstTextChannelId: string | null;
}> {
  // Load requested template dynamically from backend file
  const template = loadServerTemplate(templateId);
  const auditReason = `Reorganização estrutural autorizada via /aph ${templateId}`;

  // Fetch all current channels in the guild
  const channelsCollection = await guild.channels.fetch();
  const existingChannels: GuildBasedChannel[] = [];
  for (const ch of channelsCollection.values()) {
    if (ch) existingChannels.push(ch);
  }

  // Delete non-category channels first, then categories
  const nonCategories = existingChannels.filter((ch) => ch.type !== ChannelType.GuildCategory);
  const categories = existingChannels.filter((ch) => ch.type === ChannelType.GuildCategory);

  let deletedCount = 0;

  for (const channel of nonCategories) {
    await channel.delete(auditReason);
    deletedCount += 1;
  }

  for (const category of categories) {
    await category.delete(auditReason);
    deletedCount += 1;
  }

  // Create new categories and channels from template
  const botMemberId = guild.members.me?.id ?? guild.client.user?.id ?? null;
  let createdCategories = 0;
  let createdChannels = 0;
  let firstTextChannelId: string | null = null;
  const createdChannelIds = new Set<string>();
  let firstEntradaChannelId: string | null = null;
  let firstSaidaChannelId: string | null = null;

  for (const catDef of template.categories) {
    const categoryOverwrites = catDef.adminOnly
      ? [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          ...(botMemberId
            ? [
                {
                  id: botMemberId,
                  allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.Connect,
                  ],
                },
              ]
            : []),
        ]
      : undefined;

    const createdCategory = await guild.channels.create({
      name: catDef.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: categoryOverwrites,
      reason: auditReason,
    });
    createdCategories += 1;

    for (const chDef of catDef.channels) {
      const channelType =
        chDef.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

      const isAdminOnly = Boolean(chDef.adminOnly);
      const isReadOnly = Boolean(chDef.readOnly);

      const channelOverwrites =
        isAdminOnly || isReadOnly
          ? [
              {
                id: guild.roles.everyone.id,
                deny: [
                  ...(isAdminOnly ? [PermissionsBitField.Flags.ViewChannel] : []),
                  ...(isReadOnly
                    ? [
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.SendMessagesInThreads,
                      ]
                    : []),
                ],
              },
              ...(botMemberId
                ? [
                    {
                      id: botMemberId,
                      allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.EmbedLinks,
                        PermissionsBitField.Flags.AttachFiles,
                      ],
                    },
                  ]
                : []),
            ]
          : undefined;

      const createdChannel = await guild.channels.create({
        name: chDef.name,
        type: channelType,
        parent: createdCategory.id,
        topic: channelType === ChannelType.GuildText && chDef.topic ? chDef.topic : undefined,
        userLimit:
          channelType === ChannelType.GuildVoice && typeof chDef.userLimit === 'number'
            ? chDef.userLimit
            : undefined,
        permissionOverwrites: channelOverwrites,
        reason: auditReason,
      });
      createdChannels += 1;
      createdChannelIds.add(createdChannel.id);

      if (channelType === ChannelType.GuildText) {
        if (!firstTextChannelId) {
          firstTextChannelId = createdChannel.id;
        }
        const normName = normalizeDiscordName(chDef.name);
        if (
          !firstEntradaChannelId &&
          (normName.includes('entrada') ||
            normName.includes('entrd') ||
            normName.includes('boas-vindas') ||
            normName.includes('welcome'))
        ) {
          firstEntradaChannelId = createdChannel.id;
        }
        if (
          !firstSaidaChannelId &&
          (normName.includes('saida') ||
            normName.includes('despedida') ||
            normName.includes('leave'))
        ) {
          firstSaidaChannelId = createdChannel.id;
        }
      }
    }
  }

  if (hasSavedGuildConfig(guild.id)) {
    const existingCfg = getGuildConfig(guild.id);
    let remapped = false;
    if (
      existingCfg.welcome.channelId &&
      !createdChannelIds.has(existingCfg.welcome.channelId) &&
      firstEntradaChannelId
    ) {
      existingCfg.welcome.channelId = firstEntradaChannelId;
      remapped = true;
    }
    if (
      existingCfg.leave.channelId &&
      !createdChannelIds.has(existingCfg.leave.channelId) &&
      firstSaidaChannelId
    ) {
      existingCfg.leave.channelId = firstSaidaChannelId;
      remapped = true;
    }
    if (remapped) {
      saveGuildConfig(existingCfg);
    }
  }

  await ensureMuralPanelsForGuild(guild).catch(() => {});
  await ensureExpPanelForGuild(guild).catch(() => {});

  return {
    deletedCount,
    createdCategories,
    createdChannels,
    firstTextChannelId,
  };
}

async function handleAphCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const rawId = interaction.options.getString('id', true);
  const templateId = rawId.trim().toLowerCase();

  if (templateId !== 'dog' && templateId !== 'dogs1') {
    await interaction.reply({
      content: `Identificador inválido: \`${rawId}\`.\nOs identificadores aceitos são \`dog\` (estrutura principal profissional) e \`dogs1\` (estrutura completa com canais extras).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: 'Este comando só pode ser executado dentro de um servidor Discord.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;

  // 1. Verify caller administrative permission
  const isOwner = guild.ownerId === interaction.user.id;
  const hasAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;

  if (!isOwner && !hasAdmin) {
    await interaction.reply({
      content: `Permissão negada. Apenas administradores ou o dono do servidor podem executar \`/aph ${templateId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 2. Verify bot permissions
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const missingBotPerms: string[] = [];

  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    missingBotPerms.push('Gerenciar Canais (Manage Channels)');
  }
  if (!botMember.permissions.has(PermissionsBitField.Flags.ViewChannel)) {
    missingBotPerms.push('Ver Canais (View Channels)');
  }

  if (missingBotPerms.length > 0) {
    await interaction.reply({
      content: `O bot não possui as permissões necessárias para reorganizar o servidor.\nPermissões ausentes: ${missingBotPerms.join(', ')}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Prevent concurrent operations on the same guild
  if (activeGuildOperations.has(guild.id)) {
    await interaction.reply({
      content: 'Já existe uma reorganização em andamento neste servidor. Aguarde a conclusão antes de iniciar outra.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 3. Request explicit ephemeral confirmation
  const confirmCustomId = `aph_confirm_${interaction.id}`;
  const cancelCustomId = `aph_cancel_${interaction.id}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmCustomId)
      .setLabel('Confirmar reorganização')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cancelCustomId)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );

  const templateLabel =
    templateId === 'dog'
      ? 'Template principal profissional (`dog`)'
      : 'Template completo com canais extras (`dogs1`)';

  const replyMessage = await interaction.reply({
    content: [
      `**Confirmação necessária — Reorganização Estrutural (\`/aph ${templateId}\`)**`,
      templateLabel,
      '',
      'Esta ação irá:',
      '• Remover todas as categorias e canais existentes neste servidor.',
      '• Criar as categorias e canais padronizados definidos no template selecionado.',
      '• Preservar integralmente cargos, membros, permissões gerais e configurações do servidor.',
      '',
      'Deseja prosseguir?',
    ].join('\n'),
    components: [row],
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  const message = replyMessage.resource?.message;
  if (!message) {
    return;
  }

  try {
    const buttonInteraction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) =>
        i.user.id === interaction.user.id &&
        (i.customId === confirmCustomId || i.customId === cancelCustomId),
      time: 60_000,
    });

    if (buttonInteraction.customId === cancelCustomId) {
      await buttonInteraction.update({
        content: 'Operação cancelada. Nenhuma alteração foi realizada no servidor.',
        components: [],
      });
      return;
    }

    // Re-check lock before executing
    if (activeGuildOperations.has(guild.id)) {
      await buttonInteraction.update({
        content: 'Já existe uma reorganização em andamento neste servidor.',
        components: [],
      });
      return;
    }

    activeGuildOperations.add(guild.id);

    await buttonInteraction.update({
      content: 'Reorganização iniciada. Removendo canais antigos e aplicando o template...',
      components: [],
    });

    try {
      const result = await executeStructureReplacement(guild, templateId);
      const summary = [
        `Reorganização (\`/aph ${templateId}\`) concluída com sucesso.`,
        `• Canais/categorias removidos: ${result.deletedCount}`,
        `• Categorias criadas: ${result.createdCategories}`,
        `• Canais criados: ${result.createdChannels}`,
      ].join('\n');

      try {
        await buttonInteraction.editReply({ content: summary });
      } catch {
        // If original channel was deleted and Discord invalidates ephemeral edit, notify once in first created text channel
        if (result.firstTextChannelId) {
          const ch = await guild.channels.fetch(result.firstTextChannelId).catch(() => null);
          if (ch && ch.isTextBased()) {
            await ch.send(`<@${interaction.user.id}> ${summary}`).catch(() => {});
          }
        }
      }
    } catch (apiError) {
      const formattedError = formatApiError(apiError);
      const failureMsg = `Operação interrompida com segurança devido a um erro da API do Discord:\n${formattedError}`;

      try {
        await buttonInteraction.editReply({ content: failureMsg });
      } catch {
        // Fallback: try sending to an existing text channel in the guild if the origin channel was deleted
        const remaining = await guild.channels.fetch().catch(() => null);
        const fallbackText = remaining?.find((c) => c && c.isTextBased() && c.type === ChannelType.GuildText);
        if (fallbackText && fallbackText.isTextBased()) {
          await fallbackText.send(`<@${interaction.user.id}> ${failureMsg}`).catch(() => {});
        }
      }
    } finally {
      activeGuildOperations.delete(guild.id);
    }
  } catch {
    // Timeout reached without clicking
    await interaction
      .editReply({
        content: 'Tempo de confirmação expirado (60s). Nenhuma alteração foi realizada no servidor.',
        components: [],
      })
      .catch(() => {});
  }
}

function attachBotListeners(client: Client): void {
  client.once('clientReady', async () => {
    botReady = true;
    console.log(`[Discord Bot] Conectado como ${client.user?.tag ?? 'Bot'}`);
    for (const guild of client.guilds.cache.values()) {
      await runFullGuildSync(guild).catch((err) => {
        console.error('[Discord Bot] Falha no sync inicial da guild:', err);
      });
      void ensureMuralPanelsForGuild(guild).catch(() => {});
      void ensureExpPanelForGuild(guild).catch(() => {});
    }
    const snapshot: unknown[] = [];
    for (const guild of client.guilds.cache.values()) {
      try {
        const channels = await guild.channels.fetch();
        const roles = await guild.roles.fetch();
        const emojis = await guild.emojis.fetch();
        const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        snapshot.push({
          id: guild.id,
          name: guild.name,
          ownerId: guild.ownerId,
          premiumTier: guild.premiumTier,
          botId: client.user?.id ?? null,
          botHighestRolePos: botMember?.roles.highest.position ?? null,
          botIsAdmin: botMember?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false,
          roles: Array.from(roles.values())
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
              id: r.id,
              name: r.name,
              position: r.position,
              managed: r.managed,
              permissions: r.permissions.bitfield.toString(),
            })),
          channels: Array.from(channels.values())
            .filter((c): c is NonNullable<typeof c> => Boolean(c))
            .sort((a, b) => ('rawPosition' in a ? a.rawPosition : 0) - ('rawPosition' in b ? b.rawPosition : 0))
            .map((c) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              parentId: c.parentId,
              position: 'rawPosition' in c ? c.rawPosition : 0,
              overwrites:
                'permissionOverwrites' in c
                  ? Array.from(c.permissionOverwrites.cache.values()).map((o) => ({
                      id: o.id,
                      type: o.type,
                      allow: o.allow.bitfield.toString(),
                      deny: o.deny.bitfield.toString(),
                    }))
                  : [],
            })),
          emojis: Array.from(emojis.values()).map((e) => ({
            id: e.id,
            name: e.name,
            animated: Boolean(e.animated),
          })),
        });
      } catch (snapErr) {
        console.error('[Discord Bot] Snapshot error:', snapErr);
      }
    }
    try {
      fs.writeFileSync('/tmp/discord_guild_snapshot.json', JSON.stringify(snapshot, null, 2));
    } catch {
      // Ignore temp snapshot error
    }
  });

  client.on('error', (err) => {
    console.error('[Discord Bot] Client error:', err);
    botConnectionError = err.message;
  });

  client.on('guildMemberAdd', async (member) => {
    await assignMemberRoleOnJoin(member);
    await handleMemberBannerEvent(member, 'welcome');
  });

  client.on('guildMemberRemove', async (member) => {
    await handleMemberBannerEvent(member, 'leave');
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
      try {
        if (interaction.customId.startsWith('exp_')) {
          await handleExpButtonInteraction(interaction, client);
          return;
        }
        const handledByReg = await handleRegistrationButtonInteraction(interaction);
        if (handledByReg) return;
        const handledByExp = await handleExpButtonInteraction(interaction, client);
        if (!handledByExp) {
          await handleMuralButtonInteraction(interaction, client);
        }
      } catch (err) {
        console.error('[Discord Bot] Erro no botão:', err);
        const errPayload = {
          content: 'Não foi possível processar esta ação no momento. Tente novamente.',
          flags: MessageFlags.Ephemeral,
        } as const;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(errPayload).catch(() => {});
        } else {
          await interaction.reply(errPayload).catch(() => {});
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      try {
        await handleMuralSelectInteraction(interaction);
      } catch (err) {
        console.error('[Discord Bot] Erro na seleção de mural:', err);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      try {
        const handledByExp = await handleExpModalInteraction(interaction);
        if (!handledByExp) {
          await handleMuralModalInteraction(interaction);
        }
      } catch (err) {
        console.error('[Discord Bot] Erro no modal:', err);
        const errPayload = {
          content: 'Ocorreu um erro ao processar o formulário enviado. Tente novamente.',
          flags: MessageFlags.Ephemeral,
        } as const;
        if (interaction.deferred) {
          await interaction.editReply({ content: errPayload.content }).catch(() => {});
        } else if (interaction.replied) {
          await interaction.followUp(errPayload).catch(() => {});
        } else {
          await interaction.reply(errPayload).catch(() => {});
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'ping') {
        await handlePingCommand(interaction, client);
      } else if (interaction.commandName === 'aph') {
        await handleAphCommand(interaction);
      } else {
        await dispatchAdditionalSlashCommand(interaction);
      }
    } catch (err) {
      console.error(`[Discord Bot] Erro no comando /${interaction.commandName}:`, err);
      const errorReply = {
        content: 'Ocorreu um erro interno ao processar este comando.',
        flags: MessageFlags.Ephemeral,
      } as const;

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply).catch(() => {});
      } else {
        await interaction.reply(errorReply).catch(() => {});
      }
    }
  });
}

export async function initializeDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();

  if (!token || !applicationId) {
    botConnectionError = 'DISCORD_BOT_TOKEN ou DISCORD_APPLICATION_ID não configurados.';
    botReady = false;
    return;
  }

  try {
    await registerSlashCommands(applicationId, token);
  } catch (err) {
    console.error('[Discord Bot] Falha ao registrar comandos slash:', err);
  }

  const primaryClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember, Partials.User],
  });
  attachBotListeners(primaryClient);
  discordClient = primaryClient;

  try {
    await primaryClient.login(token);
    botConnectionError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao autenticar o bot no Discord.';
    if (message.toLowerCase().includes('disallowed intents')) {
      console.warn(
        '[Discord Bot] SERVER MEMBERS INTENT desativado no Portal do Discord. Conectando com intents básicas (habilite Server Members Intent para eventos automáticos de entrada/saída).',
      );
      await primaryClient.destroy().catch(() => {});

      const fallbackClient = new Client({
        intents: [GatewayIntentBits.Guilds],
        partials: [Partials.GuildMember, Partials.User],
      });
      attachBotListeners(fallbackClient);
      discordClient = fallbackClient;

      try {
        await fallbackClient.login(token);
        botConnectionError =
          'Ative "Server Members Intent" no Discord Developer Portal para disparos automáticos de entrada e saída.';
      } catch (fallbackErr) {
        botReady = false;
        botConnectionError =
          fallbackErr instanceof Error
            ? fallbackErr.message
            : 'Falha ao autenticar o bot no Discord.';
        console.error('[Discord Bot] Falha no login fallback:', botConnectionError);
      }
    } else {
      botReady = false;
      botConnectionError = message;
      console.error('[Discord Bot] Falha no login:', botConnectionError);
    }
  }
}

export function getBotStatus(): BotStatus {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
  const configured = Boolean(token && applicationId);

  return {
    configured,
    connected: botReady && Boolean(discordClient?.isReady()),
    botTag: discordClient?.user?.tag ?? null,
    botId: discordClient?.user?.id ?? null,
    guildCount: discordClient?.guilds.cache.size ?? 0,
    error: botConnectionError,
  };
}

export async function reconnectDiscordBot(): Promise<BotStatus> {
  if (reconnectPromise) {
    return reconnectPromise;
  }

  reconnectPromise = (async () => {
    try {
      if (discordClient) {
        await discordClient.destroy().catch(() => {});
        discordClient = null;
      }
      botReady = false;
      botConnectionError = null;
      await initializeDiscordBot();
      return getBotStatus();
    } finally {
      reconnectPromise = null;
    }
  })();

  return reconnectPromise;
}

export async function fetchBotGuildIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  if (discordClient?.isReady()) {
    for (const guildId of discordClient.guilds.cache.keys()) {
      ids.add(guildId);
    }
    return ids;
  }

  // Fallback via Discord REST API if bot token is set but WebSocket is still connecting
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return ids;

  try {
    const response = await fetch('https://discord.com/api/v10/users/@me/guilds?limit=200', {
      headers: {
        Authorization: `Bot ${token}`,
      },
    });
    if (response.ok) {
      const guilds = (await response.json()) as Array<{ id: string }>;
      for (const g of guilds) {
        ids.add(g.id);
      }
    }
  } catch {
    // Ignore transient REST error
  }

  return ids;
}

export interface GuildTextChannelItem {
  id: string;
  name: string;
  categoryName: string | null;
}

export async function fetchGuildTextChannels(guildId: string): Promise<GuildTextChannelItem[]> {
  if (discordClient?.isReady()) {
    const guild = await discordClient.guilds.fetch(guildId).catch(() => null);
    if (guild) {
      const channels = await guild.channels.fetch();
      const categories = new Map<string, string>();
      for (const ch of channels.values()) {
        if (ch && ch.type === ChannelType.GuildCategory) {
          categories.set(ch.id, ch.name);
        }
      }

      const textChannels: Array<GuildTextChannelItem & { position: number }> = [];
      for (const ch of channels.values()) {
        if (
          ch &&
          (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
        ) {
          textChannels.push({
            id: ch.id,
            name: ch.name,
            categoryName: ch.parentId ? (categories.get(ch.parentId) ?? null) : null,
            position: 'rawPosition' in ch ? ch.rawPosition : 0,
          });
        }
      }

      textChannels.sort((a, b) => a.position - b.position);
      return textChannels.map(({ id, name, categoryName }) => ({ id, name, categoryName }));
    }
  }

  // Fallback to Bot REST API if WebSocket is not ready yet
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return [];

  const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!resp.ok) return [];

  const rawChannels = (await resp.json()) as Array<{
    id: string;
    name: string;
    type: number;
    parent_id: string | null;
    position: number;
  }>;

  const categories = new Map<string, string>();
  for (const ch of rawChannels) {
    if (ch.type === ChannelType.GuildCategory) {
      categories.set(ch.id, ch.name);
    }
  }

  return rawChannels
    .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.position - b.position)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      categoryName: ch.parent_id ? (categories.get(ch.parent_id) ?? null) : null,
    }));
}

async function handleMemberBannerEvent(
  member: GuildMember | PartialGuildMember,
  eventType: BannerEventType,
): Promise<void> {
  try {
    const guild = member.guild;
    const config = getGuildConfig(guild.id);
    const rule = eventType === 'welcome' ? config.welcome : config.leave;

    if (!rule.enabled || !rule.channelId) return;

    const channel = await guild.channels.fetch(rule.channelId).catch(() => null);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      return;
    }

    const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (botMember) {
      const perms = channel.permissionsFor(botMember);
      if (
        !perms?.has(PermissionsBitField.Flags.ViewChannel) ||
        !perms?.has(PermissionsBitField.Flags.SendMessages) ||
        !perms?.has(PermissionsBitField.Flags.AttachFiles)
      ) {
        return;
      }
    }

    const resolvedUser =
      member.user && !member.user.partial && member.user.username
        ? member.user
        : await member.client.users.fetch(member.id).catch(() => member.user ?? null);

    const displayName =
      member.displayName || resolvedUser?.globalName || resolvedUser?.username || 'Membro';
    const username = resolvedUser?.username || displayName;
    const avatarUrl =
      resolvedUser?.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }) ?? null;

    console.log(
      `[Discord Bot] Evento ${eventType === 'welcome' ? 'guildMemberAdd -> Entrada' : 'guildMemberRemove -> Saída'} | servidor "${guild.name}" (${guild.id}) | canal #${channel.name} (${channel.id}) | título "${rule.title}" | membro ${displayName} (${member.id})`,
    );

    const pngBuffer = await renderWelcomeBanner({
      title: rule.title,
      message: rule.message,
      memberDisplayName: displayName,
      memberUsername: username,
      guildName: guild.name,
      memberCount: guild.memberCount,
      avatarUrl,
      imageFilename: rule.imageFilename,
    });

    const filename = eventType === 'welcome' ? 'boas-vindas.png' : 'despedida.png';
    await channel.send({
      content: `<@${member.id}>`,
      files: [new AttachmentBuilder(pngBuffer, { name: filename })],
      allowedMentions:
        eventType === 'welcome' ? { users: [member.id] } : { parse: [] },
    });
  } catch (err) {
    console.error(`[Discord Bot] Falha ao enviar imagem de ${eventType}:`, err);
  }
}

export async function sendTestWelcomeBanner(options: {
  guildId: string;
  eventType: BannerEventType;
  channelId: string;
  title: string;
  message: string;
  memberUserId: string;
  memberDisplayName: string;
  memberUsername: string;
  avatarUrl: string | null;
  imageFilename: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    let guildName = 'Servidor';
    let memberCount = 1;

    if (discordClient?.isReady()) {
      const guild = await discordClient.guilds.fetch(options.guildId).catch(() => null);
      if (!guild) {
        return { ok: false, error: 'Servidor não encontrado pelo bot.' };
      }

      guildName = guild.name;
      memberCount = guild.memberCount;

      const channel = await guild.channels.fetch(options.channelId).catch(() => null);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      ) {
        return { ok: false, error: 'Canal de texto inválido ou não encontrado.' };
      }

      const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (botMember) {
        const perms = channel.permissionsFor(botMember);
        if (
          !perms?.has(PermissionsBitField.Flags.ViewChannel) ||
          !perms?.has(PermissionsBitField.Flags.SendMessages) ||
          !perms?.has(PermissionsBitField.Flags.AttachFiles)
        ) {
          return {
            ok: false,
            error:
              'O bot precisa das permissões Ver Canal, Enviar Mensagens e Anexar Arquivos neste canal.',
          };
        }
      }

      const pngBuffer = await renderWelcomeBanner({
        title: options.title,
        message: options.message,
        memberDisplayName: options.memberDisplayName,
        memberUsername: options.memberUsername,
        guildName,
        memberCount,
        avatarUrl: options.avatarUrl,
        imageFilename: options.imageFilename,
      });

      const filename =
        options.eventType === 'welcome' ? 'demonstracao-entrada.png' : 'demonstracao-saida.png';
      await channel.send({
        content: `<@${options.memberUserId}>`,
        files: [new AttachmentBuilder(pngBuffer, { name: filename })],
        allowedMentions: { users: [options.memberUserId] },
      });

      return { ok: true };
    }

    // Fallback via Discord REST API if gateway is still connecting
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) {
      return { ok: false, error: 'Token do bot não configurado no servidor.' };
    }

    const guildResp = await fetch(`https://discord.com/api/v10/guilds/${options.guildId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (guildResp.ok) {
      const g = (await guildResp.json()) as { name?: string };
      if (g.name) guildName = g.name;
    }

    const pngBuffer = await renderWelcomeBanner({
      title: options.title,
      message: options.message,
      memberDisplayName: options.memberDisplayName,
      memberUsername: options.memberUsername,
      guildName,
      memberCount,
      avatarUrl: options.avatarUrl,
      imageFilename: options.imageFilename,
    });

    const filename =
      options.eventType === 'welcome' ? 'demonstracao-entrada.png' : 'demonstracao-saida.png';

    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content: `<@${options.memberUserId}>`,
        allowed_mentions: { users: [options.memberUserId] },
      }),
    );
    form.append('files[0]', new Blob([new Uint8Array(pngBuffer)], { type: 'image/png' }), filename);

    const sendResp = await fetch(
      `https://discord.com/api/v10/channels/${options.channelId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bot ${token}` },
        body: form,
      },
    );

    if (!sendResp.ok) {
      const errDetail = await sendResp.text().catch(() => '');
      return {
        ok: false,
        error: `O Discord recusou o envio no canal (HTTP ${sendResp.status}). Verifique as permissões do bot no canal selecionado. ${errDetail}`.trim(),
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: formatApiError(err),
    };
  }
}


