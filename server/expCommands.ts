import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type ModalSubmitInteraction,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import {
  generateExpCarousel,
  generateExpDraftPreview,
  generateExpVideo,
} from './expMediaGenerator.ts';
import {
  allocateUniqueExpNumber,
  createExpRecord,
  deleteExpDraft,
  formatExpCaption,
  formatExpCode,
  getExpDraft,
  getExpMediaFilePath,
  getExpRecord,
  getGuildTikTokOwner,
  getNextPreviewExpNumber,
  parseEvidenceLinks,
  saveExpDraft,
  updateExpRecord,
  validateExpNoPrivateData,
  type ExpFormat,
  type ExpRecord,
} from './expStore.ts';
import { publishExpToTikTok } from './tiktokService.ts';
import { getAnyConnectedTikTok, getTikTokConnection } from './tiktokStore.ts';
import {
  findExpChannelInGuild,
  normalizeDiscordName,
  toTinyFont,
} from './channelUtils.ts';

function normalizeChannelName(name: string): string {
  return normalizeDiscordName(name);
}

function isGuildTextOrAnnouncement(
  channel: GuildBasedChannel | null | undefined,
): channel is TextChannel | NewsChannel {
  return Boolean(
    channel &&
      (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement),
  );
}

function isGuildAdmin(
  guild: Guild,
  userId: string,
  memberPermissions?: Readonly<PermissionsBitField> | null,
): boolean {
  if (guild.ownerId === userId) return true;
  return memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

export function findExpChannel(guild: Guild): TextChannel | NewsChannel | null {
  return findExpChannelInGuild(guild);
}

async function enforceReadOnlyPermissions(
  channel: TextChannel | NewsChannel,
  guild: Guild,
): Promise<void> {
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) return;

  const everyoneOverwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  const alreadyDeniesMessages =
    Boolean(everyoneOverwrite?.deny.has(PermissionsBitField.Flags.SendMessages)) &&
    Boolean(everyoneOverwrite?.deny.has(PermissionsBitField.Flags.SendMessagesInThreads));

  const botOverwrite = channel.permissionOverwrites.cache.get(botMember.id);
  const botAlreadyAllowed =
    Boolean(botOverwrite?.allow.has(PermissionsBitField.Flags.ViewChannel)) &&
    Boolean(botOverwrite?.allow.has(PermissionsBitField.Flags.SendMessages)) &&
    Boolean(botOverwrite?.allow.has(PermissionsBitField.Flags.EmbedLinks)) &&
    Boolean(botOverwrite?.allow.has(PermissionsBitField.Flags.AttachFiles));

  if (!alreadyDeniesMessages) {
    await channel.permissionOverwrites
      .edit(guild.roles.everyone.id, {
        SendMessages: false,
        SendMessagesInThreads: false,
      })
      .catch(() => {});
  }

  if (!botAlreadyAllowed) {
    await channel.permissionOverwrites
      .edit(botMember.id, {
        ViewChannel: true,
        SendMessages: true,
        EmbedLinks: true,
        AttachFiles: true,
        ManageMessages: true,
      })
      .catch(() => {});
  }
}

const UNIFIED_EMBED_COLOR = 0x1e2025;

async function findBotButtonMessage(
  channel: TextChannel | NewsChannel,
  botUserId: string,
  customId: string,
) {
  try {
    const messages = await channel.messages.fetch({ limit: 25 });
    for (const msg of messages.values()) {
      if (msg.author.id !== botUserId) continue;
      for (const row of msg.components) {
        if (!('components' in row)) continue;
        for (const comp of row.components) {
          if ('customId' in comp && comp.customId === customId) {
            return msg;
          }
        }
      }
    }
  } catch {
    // Ignore transient fetch issues
  }
  return null;
}

/**
 * Restores the #exp channel if it does not exist on the guild, configures read-only permissions,
 * and posts the permanent interactive panel with button "EXPONHA UMA OCORRÊNCIA".
 */
export async function ensureExpPanelForGuild(guild: Guild): Promise<void> {
  const botUserId = guild.client.user?.id;
  if (!botUserId) return;

  await guild.channels.fetch().catch(() => {});
  let expChannel = findExpChannel(guild);

  if (!expChannel) {
    const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return;
    }

    // Place #exp inside MURAL or SERVIÇOS category if present
    let targetParentId: string | undefined;
    for (const ch of guild.channels.cache.values()) {
      if (ch.type !== ChannelType.GuildCategory) continue;
      const norm = normalizeChannelName(ch.name);
      if (norm.includes('mural') || norm.includes('servic')) {
        targetParentId = ch.id;
        break;
      }
    }

    try {
      const created = await guild.channels.create({
        name: toTinyFont('exp'),
        type: ChannelType.GuildText,
        parent: targetParentId,
        topic:
          'Clique em EXPONHA UMA OCORRÊNCIA para enviar um relato com evidências para análise administrativa.',
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.SendMessagesInThreads,
            ],
          },
          {
            id: botMember.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.EmbedLinks,
              PermissionsBitField.Flags.AttachFiles,
              PermissionsBitField.Flags.ManageMessages,
            ],
          },
        ],
        reason: 'Restauração automática do canal EXP',
      });
      if (isGuildTextOrAnnouncement(created)) {
        expChannel = created;
      }
    } catch {
      return;
    }
  }

  if (!expChannel) return;

  await enforceReadOnlyPermissions(expChannel, guild);
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const perms = botMember ? expChannel.permissionsFor(botMember) : null;
  if (
    !perms?.has(PermissionsBitField.Flags.ViewChannel) ||
    !perms?.has(PermissionsBitField.Flags.SendMessages)
  ) {
    return;
  }

  const panelDescription = [
    'Utilize este canal para registrar ocorrências com relato estruturado e evidências verificáveis.',
    '',
    '**Como funciona:**',
    '1. Clique em **EXPONHA UMA OCORRÊNCIA** abaixo para preencher os fatos.',
    '2. Adicione os links das provas (imagens, vídeos ou outras evidências).',
    '3. Escolha o formato (**Carrossel de imagens** ou **Vídeo**) e revise a prévia.',
    '4. O recurso será enviado para análise privada do administrador antes de qualquer publicação.',
  ].join('\n');

  const panelEmbed = new EmbedBuilder()
    .setColor(UNIFIED_EMBED_COLOR)
    .setTitle('Sistema de Exposição · EXP')
    .setDescription(panelDescription)
    .setFooter({ text: 'Aprovação administrativa obrigatória · Identificação automática Exp XXX' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('exp_open_modal_btn')
      .setLabel('EXPONHA UMA OCORRÊNCIA')
      .setStyle(ButtonStyle.Secondary),
  );

  const existingPanelMsg = await findBotButtonMessage(
    expChannel,
    botUserId,
    'exp_open_modal_btn',
  );
  if (existingPanelMsg) {
    const currentEmbed = existingPanelMsg.embeds[0];
    const needsUpdate =
      !currentEmbed ||
      currentEmbed.description !== panelDescription ||
      currentEmbed.color !== UNIFIED_EMBED_COLOR;
    if (needsUpdate) {
      await existingPanelMsg
        .edit({
          embeds: [panelEmbed],
          components: [row],
        })
        .catch(() => {});
    }
    return;
  }

  await expChannel
    .send({
      embeds: [panelEmbed],
      components: [row],
    })
    .catch(() => {});
}

function buildExpStep1Modal(): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId('exp_form_step1_modal')
    .setTitle('Exponha uma Ocorrência');

  const involvedInput = new TextInputBuilder()
    .setCustomId('exp_involved')
    .setLabel('Nome/identificação pública da pessoa (opcional)')
    .setPlaceholder('Ex.: @apelido público ou deixe em branco')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);

  const descInput = new TextInputBuilder()
    .setCustomId('exp_description')
    .setLabel('Descrição do ocorrido')
    .setPlaceholder('Resumo objetivo da situação (sem dados pessoais privados)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(160);

  const whatInput = new TextInputBuilder()
    .setCustomId('exp_what_happened')
    .setLabel('O que aconteceu?')
    .setPlaceholder('Explique em detalhes o que aconteceu de forma clara e verdadeira...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(1000);

  const whyInput = new TextInputBuilder()
    .setCustomId('exp_why_wrong')
    .setLabel('Por que isso é considerado errado?')
    .setPlaceholder('Explique por que essa conduta foi errada ou prejudicou pessoas...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(600);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(involvedInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(whatInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(whyInput),
  );
  return modal;
}

function buildExpLinksModal(existingMediaLinks: string[], existingOtherLinks: string[]): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId('exp_form_links_modal')
    .setTitle('Links e Evidências da Ocorrência');

  const mediaInput = new TextInputBuilder()
    .setCustomId('exp_media_links')
    .setLabel('Links de imagens e vídeos que comprovem')
    .setPlaceholder('Cole links https://... (um por linha)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(800);
  if (existingMediaLinks.length > 0) {
    mediaInput.setValue(existingMediaLinks.join('\n').slice(0, 800));
  }

  const otherInput = new TextInputBuilder()
    .setCustomId('exp_other_links')
    .setLabel('Links de outras evidências')
    .setPlaceholder('Outros links de comprovação https://... (um por linha)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(800);
  if (existingOtherLinks.length > 0) {
    otherInput.setValue(existingOtherLinks.join('\n').slice(0, 800));
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(mediaInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(otherInput),
  );
  return modal;
}

function buildFormatSelectionRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('exp_choose_format:carousel')
      .setLabel('Carrossel de imagens')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('exp_choose_format:video')
      .setLabel('Vídeo')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('exp_open_links_modal_btn')
      .setLabel('Editar links')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('exp_cancel_draft_btn')
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Danger),
  );
}

function resolveTikTokUserForGuild(guildId: string, adminUserId: string): string | null {
  const owner = getGuildTikTokOwner(guildId);
  if (owner && getTikTokConnection(owner)) return owner;
  if (getTikTokConnection(adminUserId)) return adminUserId;
  const fallback = getAnyConnectedTikTok([owner || '', adminUserId]);
  return fallback?.discordUserId ?? null;
}

async function deliverTikTokOutcomeToAdmin(
  interaction: ButtonInteraction,
  client: Client,
  record: ExpRecord,
  outcome: Awaited<ReturnType<typeof publishExpToTikTok>>,
  attachments: AttachmentBuilder[],
): Promise<void> {
  const expCode = record.expCode || formatExpCode(record.expNumber || 1);
  const caption = record.caption || formatExpCaption(record.expNumber || 1);

  if (outcome.outcome === 'published') {
    updateExpRecord(record.id, {
      status: 'published_tiktok',
      tiktokPublishId: outcome.publishId ?? null,
      tiktokPublishMode: outcome.publishMode ?? null,
      tiktokStatusText: outcome.statusText,
      tiktokError: null,
    });
    await interaction
      .editReply({
        content: [
          `✅ **${expCode}** aprovado, gerado e publicado no TikTok!`,
          `**Padrão:** \`${caption}\``,
          `**Formato:** ${record.format === 'carousel' ? 'Carrossel de imagens' : 'Vídeo'}`,
          `**Resultado:** ${outcome.statusText}`,
          outcome.publishId ? `**Publish ID:** \`${outcome.publishId}\`` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        embeds: [],
        components: [],
        files: attachments.slice(0, 4),
      })
      .catch(() => {});
  } else if (outcome.outcome === 'inbox_draft') {
    updateExpRecord(record.id, {
      status: 'tiktok_inbox',
      tiktokPublishId: outcome.publishId ?? null,
      tiktokPublishMode: outcome.publishMode ?? 'inbox_draft',
      tiktokStatusText: outcome.statusText,
      tiktokError: null,
    });
    await interaction
      .editReply({
        content: [
          `📲 **${expCode}** enviado para a caixa de entrada (Rascunhos) do TikTok!`,
          `**Padrão:** \`${caption}\``,
          `**Status:** ${outcome.statusText}`,
          outcome.publishId ? `**Publish ID:** \`${outcome.publishId}\`` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        embeds: [],
        components: [],
        files: attachments.slice(0, 4),
      })
      .catch(() => {});
  } else if (outcome.outcome === 'awaiting_confirmation') {
    updateExpRecord(record.id, {
      status: 'awaiting_tiktok_confirmation',
      tiktokStatusText: outcome.statusText,
      tiktokError: outcome.error ?? null,
    });

    const confirmButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`exp_tiktok_confirm_inbox:${record.id}`)
        .setLabel('Confirmar: Enviar para Inbox TikTok')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`exp_tiktok_confirm_private:${record.id}`)
        .setLabel('Confirmar: Publicar Privado')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`exp_tiktok_skip:${record.id}`)
        .setLabel('Manter apenas gerado')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction
      .editReply({
        content: [
          `⚠️ **${expCode}** gerado com sucesso, mas a API do TikTok solicitou **confirmação final**:`,
          `**Padrão:** \`${caption}\``,
          `**Motivo:** ${outcome.statusText}`,
          outcome.error ? `**Detalhes:** ${outcome.error}` : '',
          '',
          'Escolha uma opção abaixo para concluir o envio:',
        ]
          .filter(Boolean)
          .join('\n'),
        embeds: [],
        components: [confirmButtons],
        files: attachments.slice(0, 4),
      })
      .catch(() => {});
  } else {
    updateExpRecord(record.id, {
      status: 'tiktok_error',
      tiktokStatusText: outcome.statusText,
      tiktokError: outcome.error ?? outcome.statusText,
    });
    await interaction
      .editReply({
        content: [
          `✅ **${expCode}** aprovado e conteúdo gerado com sucesso!`,
          `**Padrão:** \`${caption}\``,
          `⚠️ **Status TikTok:** ${outcome.statusText}`,
          outcome.error ? `**Detalhe:** ${outcome.error}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        embeds: [],
        components: [],
        files: attachments.slice(0, 4),
      })
      .catch(() => {});
  }

  // Inform requester that their EXP was approved (without exposing admin TikTok details)
  const requester = await client.users.fetch(record.requesterId).catch(() => null);
  if (requester) {
    await requester
      .send(
        `Sua exposição **${expCode}** (\`${record.id}\`) em **${record.guildName}** foi **ACEITA** pela administração e o conteúdo no formato **${record.format === 'carousel' ? 'Carrossel de imagens' : 'Vídeo'}** foi gerado!`,
      )
      .catch(() => {});
  }
}

export async function handleExpButtonInteraction(
  interaction: ButtonInteraction,
  client: Client,
): Promise<boolean> {
  const customId = interaction.customId;

  // 1. Open Step 1 modal from #exp panel button
  if (customId === 'exp_open_modal_btn') {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'Use este botão dentro de um servidor Discord.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(buildExpStep1Modal());
    return true;
  }

  // 2. Open Step 2 Links modal
  if (customId === 'exp_open_links_modal_btn') {
    if (!interaction.guildId) return true;
    const draft = getExpDraft(interaction.guildId, interaction.user.id);
    if (!draft) {
      await interaction.reply({
        content: 'Seu rascunho expirou. Clique em EXPONHA UMA OCORRÊNCIA para começar novamente.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(buildExpLinksModal(draft.mediaLinks, draft.otherLinks));
    return true;
  }

  // 3. Skip links and show format selector
  if (customId === 'exp_skip_links_btn') {
    if (!interaction.guildId) return true;
    const draft = getExpDraft(interaction.guildId, interaction.user.id);
    if (!draft) {
      await interaction.update({
        content: 'Seu rascunho expirou. Clique em EXPONHA UMA OCORRÊNCIA novamente.',
        components: [],
      });
      return true;
    }

    await interaction.update({
      content: [
        '**Etapa 2 de 3 — Escolha o formato da exposição**',
        `• **Descrição:** ${draft.description}`,
        draft.involvedName ? `• **Envolvido(a):** ${draft.involvedName}` : '',
        '• **Links de evidências:** Nenhum adicionado',
        '',
        'Selecione abaixo se deseja gerar um **Carrossel de imagens** ou um **Vídeo** para visualizar a prévia:',
      ]
        .filter(Boolean)
        .join('\n'),
      components: [buildFormatSelectionRow()],
    });
    return true;
  }

  // 4. Cancel draft
  if (customId === 'exp_cancel_draft_btn') {
    if (interaction.guildId) {
      deleteExpDraft(interaction.guildId, interaction.user.id);
    }
    await interaction.update({
      content: 'Envio cancelado. Nenhuma ocorrência foi registrada.',
      embeds: [],
      files: [],
      components: [],
    });
    return true;
  }

  // 5. Choose format -> generate and display live preview BEFORE sending to admin
  if (customId === 'exp_choose_format:carousel' || customId === 'exp_choose_format:video') {
    if (!interaction.guildId) return true;
    const draft = getExpDraft(interaction.guildId, interaction.user.id);
    if (!draft) {
      await interaction.update({
        content: 'Seu rascunho expirou. Clique em EXPONHA UMA OCORRÊNCIA novamente.',
        components: [],
      });
      return true;
    }

    const format: ExpFormat = customId.endsWith(':video') ? 'video' : 'carousel';
    await interaction.deferUpdate();

    const updatedDraft = saveExpDraft({
      ...draft,
      selectedFormat: format,
      updatedAt: new Date().toISOString(),
    });

    const previewNumber = getNextPreviewExpNumber();
    const previewCaption = formatExpCaption(previewNumber);
    const previewBuffer = await generateExpDraftPreview({
      nextExpNumber: previewNumber,
      involvedName: updatedDraft.involvedName,
      description: updatedDraft.description,
      whatHappened: updatedDraft.whatHappened,
      whyWrong: updatedDraft.whyWrong,
      mediaLinksCount: updatedDraft.mediaLinks.length,
      otherLinksCount: updatedDraft.otherLinks.length,
      format,
    });

    const formatLabel = format === 'carousel' ? 'Carrossel de imagens' : 'Vídeo';
    const altFormat: ExpFormat = format === 'carousel' ? 'video' : 'carousel';
    const altLabel = altFormat === 'carousel' ? 'Trocar para Carrossel' : 'Trocar para Vídeo';

    const previewEmbed = new EmbedBuilder()
      .setColor(UNIFIED_EMBED_COLOR)
      .setTitle(`Prévia do Conteúdo (${formatLabel})`)
      .setDescription(
        [
          `**Identificação prevista:** \`${previewCaption}\``,
          updatedDraft.involvedName
            ? `**Pessoa envolvida:** ${updatedDraft.involvedName}`
            : '**Pessoa envolvida:** Não especificada',
          `**Descrição:** ${updatedDraft.description}`,
          `**O que aconteceu:** ${updatedDraft.whatHappened.slice(0, 260)}`,
          `**Por que é errado:** ${updatedDraft.whyWrong.slice(0, 240)}`,
          `**Evidências:** ${updatedDraft.mediaLinks.length + updatedDraft.otherLinks.length} link(s)`,
          '',
          'Se tudo estiver correto, clique em **Enviar para o Administrador**. Nenhum conteúdo será publicado antes da aprovação.',
        ].join('\n'),
      )
      .setImage('attachment://previa-exp.jpg');

    const previewActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('exp_submit_to_admin_btn')
        .setLabel('Enviar para o Administrador')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`exp_choose_format:${altFormat}`)
        .setLabel(altLabel)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('exp_open_links_modal_btn')
        .setLabel('Editar links')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('exp_cancel_draft_btn')
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({
      content: '',
      embeds: [previewEmbed],
      files: [new AttachmentBuilder(previewBuffer, { name: 'previa-exp.jpg' })],
      components: [previewActions],
    });
    return true;
  }

  // 6. Confirm and submit EXP to Administrator DMs
  if (customId === 'exp_submit_to_admin_btn') {
    if (!interaction.inGuild() || !interaction.guild) return true;
    const draft = getExpDraft(interaction.guild.id, interaction.user.id);
    if (!draft || !draft.selectedFormat) {
      await interaction.update({
        content: 'Rascunho inválido ou expirado. Clique em EXPONHA UMA OCORRÊNCIA novamente.',
        embeds: [],
        files: [],
        components: [],
      });
      return true;
    }

    await interaction.deferUpdate();

    const guild = interaction.guild;
    const members = await guild.members.fetch().catch(() => guild.members.cache);
    const adminMembers = members.filter(
      (m) =>
        !m.user.bot &&
        (m.id === guild.ownerId || m.permissions.has(PermissionsBitField.Flags.Administrator)),
    );

    if (adminMembers.size === 0) {
      await interaction.editReply({
        content: 'Nenhum administrador humano com DM disponível foi encontrado neste servidor.',
        embeds: [],
        files: [],
        components: [],
      });
      return true;
    }

    const record = createExpRecord({
      guildId: guild.id,
      guildName: guild.name,
      requesterId: interaction.user.id,
      requesterTag: interaction.user.tag,
      involvedName: draft.involvedName,
      description: draft.description,
      whatHappened: draft.whatHappened,
      whyWrong: draft.whyWrong,
      mediaLinks: draft.mediaLinks,
      otherLinks: draft.otherLinks,
      format: draft.selectedFormat,
      status: 'pending',
      expNumber: null,
      expCode: null,
      caption: null,
      generatedFiles: [],
      handledById: null,
      handledByTag: null,
      handledAt: null,
      tiktokPublishId: null,
      tiktokPublishMode: null,
      tiktokStatusText: null,
      tiktokError: null,
    });

    deleteExpDraft(guild.id, interaction.user.id);

    const formatLabel =
      record.format === 'carousel' ? 'Carrossel de imagens' : 'Vídeo';

    const evidenceSummary = [
      record.mediaLinks.length > 0
        ? `**Imagens/Vídeos:**\n${record.mediaLinks.map((u) => `• ${u}`).join('\n')}`
        : '**Imagens/Vídeos:** Nenhum link enviado',
      record.otherLinks.length > 0
        ? `**Outras evidências:**\n${record.otherLinks.map((u) => `• ${u}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const dmEmbed = new EmbedBuilder()
      .setColor(UNIFIED_EMBED_COLOR)
      .setTitle(`Novo Recurso EXP · ${record.id}`)
      .setDescription(
        [
          `**Identificação do recurso:** \`${record.id}\``,
          `**Servidor:** ${guild.name}`,
          `**Enviado por:** <@${record.requesterId}> (${record.requesterTag})`,
          `**Formato escolhido:** ${formatLabel}`,
          record.involvedName
            ? `**Pessoa envolvida:** ${record.involvedName}`
            : '**Pessoa envolvida:** Não especificada',
          '',
          `**Descrição do ocorrido:**\n${record.description}`,
          '',
          `**O que aconteceu:**\n${record.whatHappened}`,
          '',
          `**Por que isso é considerado errado:**\n${record.whyWrong}`,
          '',
          evidenceSummary,
          '',
          'Nenhum conteúdo será gerado ou publicado no TikTok antes da sua aprovação.',
        ].join('\n').slice(0, 4000),
      )
      .setTimestamp();

    const adminRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`exp_admin_accept:${record.id}`)
        .setLabel('ACEITAR')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`exp_admin_reject:${record.id}`)
        .setLabel('RECUSAR')
        .setStyle(ButtonStyle.Danger),
    );

    let sentCount = 0;
    for (const admin of adminMembers.values()) {
      try {
        await admin.send({ embeds: [dmEmbed], components: [adminRow] });
        sentCount += 1;
      } catch {
        // Admin DM closed
      }
    }

    if (sentCount === 0) {
      updateExpRecord(record.id, { status: 'rejected', handledAt: new Date().toISOString() });
      await interaction.editReply({
        content:
          'Não foi possível entregar o recurso na DM de nenhum administrador (DMs bloqueadas).',
        embeds: [],
        files: [],
        components: [],
      });
      return true;
    }

    await interaction.editReply({
      content: `✅ Recurso \`${record.id}\` enviado com sucesso para análise privada de **${sentCount}** administrador(es)! Você será avisado por DM assim que for avaliado.`,
      embeds: [],
      files: [],
      components: [],
    });
    return true;
  }

  // 7. Admin Accept / Reject EXP on DM
  if (customId.startsWith('exp_admin_accept:') || customId.startsWith('exp_admin_reject:')) {
    const isAccept = customId.startsWith('exp_admin_accept:');
    const expId = customId.split(':')[1] ?? '';
    const record = getExpRecord(expId);

    if (!record) {
      await interaction.reply({
        content: 'Este recurso EXP não foi encontrado ou já expirou.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (record.status !== 'pending') {
      await interaction
        .update({
          content: `Este recurso (\`${record.id}\`) já foi processado por ${record.handledByTag ?? 'outro administrador'}.`,
          components: [],
        })
        .catch(async () => {
          await interaction.reply({
            content: `Recurso já processado por ${record.handledByTag ?? 'outro administrador'}.`,
            flags: MessageFlags.Ephemeral,
          });
        });
      return true;
    }

    const guild = await client.guilds.fetch(record.guildId).catch(() => null);
    if (!guild) {
      await interaction.reply({
        content: 'O servidor deste recurso não está mais acessível pelo bot.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !isGuildAdmin(guild, interaction.user.id, member.permissions)) {
      await interaction.reply({
        content: 'Permissão negada. Apenas administradores do servidor podem decidir este recurso.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (!isAccept) {
      updateExpRecord(expId, {
        status: 'rejected',
        handledById: interaction.user.id,
        handledByTag: interaction.user.tag,
        handledAt: new Date().toISOString(),
      });

      await interaction.update({
        content: `❌ Recurso \`${record.id}\` recusado por **${interaction.user.tag}**.`,
        embeds: [],
        components: [],
      });

      const requester = await client.users.fetch(record.requesterId).catch(() => null);
      if (requester) {
        await requester
          .send(
            `Seu recurso de exposição \`${record.id}\` em **${record.guildName}** foi recusado por um administrador.`,
          )
          .catch(() => {});
      }
      return true;
    }

    await interaction.deferUpdate();

    // Allocate unique monotonic number (Exp 001, Exp 002...)
    const allocation = allocateUniqueExpNumber(record.id);
    updateExpRecord(record.id, {
      status: 'accepted',
      expNumber: allocation.expNumber,
      expCode: allocation.expCode,
      caption: allocation.caption,
      handledById: interaction.user.id,
      handledByTag: interaction.user.tag,
      handledAt: new Date().toISOString(),
    });

    await interaction
      .editReply({
        content: `⏳ **${allocation.expCode}** aprovado por **${interaction.user.tag}**. Gerando ${record.format === 'carousel' ? 'carrossel de imagens' : 'vídeo com legendas'} e conectando ao TikTok...`,
        components: [],
      })
      .catch(() => {});

    const mediaInput = {
      expId: record.id,
      expNumber: allocation.expNumber,
      involvedName: record.involvedName,
      description: record.description,
      whatHappened: record.whatHappened,
      whyWrong: record.whyWrong,
      mediaLinks: record.mediaLinks,
      otherLinks: record.otherLinks,
    };

    const attachments: AttachmentBuilder[] = [];
    let generatedFiles: string[] = [];

    if (record.format === 'carousel') {
      const car = await generateExpCarousel(mediaInput);
      generatedFiles = car.files;
      for (const filePath of car.filePaths.slice(0, 4)) {
        attachments.push(new AttachmentBuilder(filePath));
      }
    } else {
      const vid = await generateExpVideo(mediaInput);
      generatedFiles = vid.files;
      attachments.push(
        new AttachmentBuilder(vid.videoPath, { name: `${allocation.expCode.replace(/\s+/g, '-')}.mp4` }),
      );
    }

    const updatedRecord =
      updateExpRecord(record.id, { generatedFiles }) ??
      ({ ...record, ...allocation, generatedFiles, status: 'accepted' } as ExpRecord);

    const tiktokDiscordOwner = resolveTikTokUserForGuild(record.guildId, interaction.user.id);
    const outcome = await publishExpToTikTok(updatedRecord, tiktokDiscordOwner, 'auto');

    await deliverTikTokOutcomeToAdmin(interaction, client, updatedRecord, outcome, attachments);
    return true;
  }

  // 8. Final TikTok API confirmation buttons in Admin DM
  if (
    customId.startsWith('exp_tiktok_confirm_inbox:') ||
    customId.startsWith('exp_tiktok_confirm_private:') ||
    customId.startsWith('exp_tiktok_skip:')
  ) {
    const expId = customId.split(':')[1] ?? '';
    const record = getExpRecord(expId);
    if (!record) {
      await interaction.reply({
        content: 'Registro EXP não encontrado.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (customId.startsWith('exp_tiktok_skip:')) {
      await interaction.update({
        content: `✅ **${record.expCode ?? record.id}** mantido no histórico apenas como conteúdo gerado (não enviado ao TikTok).`,
        components: [],
      });
      return true;
    }

    await interaction.deferUpdate();
    const mode = customId.startsWith('exp_tiktok_confirm_inbox:')
      ? 'inbox_draft'
      : 'direct_private';

    const tiktokDiscordOwner = resolveTikTokUserForGuild(record.guildId, interaction.user.id);
    const outcome = await publishExpToTikTok(record, tiktokDiscordOwner, mode);

    const attachments: AttachmentBuilder[] = [];
    for (const file of record.generatedFiles.slice(0, 1)) {
      const p = getExpMediaFilePath(record.id, file);
      if (p) attachments.push(new AttachmentBuilder(p));
    }

    await deliverTikTokOutcomeToAdmin(interaction, client, record, outcome, attachments);
    return true;
  }

  return false;
}

export async function handleExpModalInteraction(
  interaction: ModalSubmitInteraction,
): Promise<boolean> {
  if (interaction.customId === 'exp_form_step1_modal') {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'Este formulário só pode ser enviado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const involvedName = interaction.fields.getTextInputValue('exp_involved').trim();
    const description = interaction.fields.getTextInputValue('exp_description').trim();
    const whatHappened = interaction.fields.getTextInputValue('exp_what_happened').trim();
    const whyWrong = interaction.fields.getTextInputValue('exp_why_wrong').trim();

    const privacyCheck = validateExpNoPrivateData({
      involvedName,
      description,
      whatHappened,
      whyWrong,
    });

    if (!privacyCheck.ok) {
      await interaction.reply({
        content: `🚫 **Envio bloqueado pela proteção de privacidade:**\n${privacyCheck.reason}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const existing = getExpDraft(interaction.guild.id, interaction.user.id);
    saveExpDraft({
      key: `${interaction.guild.id}:${interaction.user.id}`,
      guildId: interaction.guild.id,
      guildName: interaction.guild.name,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      involvedName,
      description,
      whatHappened,
      whyWrong,
      mediaLinks: existing?.mediaLinks ?? [],
      otherLinks: existing?.otherLinks ?? [],
      selectedFormat: null,
      previewImagePath: null,
      updatedAt: new Date().toISOString(),
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('exp_open_links_modal_btn')
        .setLabel('Adicionar Links e Evidências')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('exp_skip_links_btn')
        .setLabel('Continuar sem links')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('exp_cancel_draft_btn')
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: [
        '**Etapa 1 concluída — Links de Evidências (Opcional)**',
        `• **Descrição:** ${description}`,
        involvedName ? `• **Envolvido(a):** ${involvedName}` : '',
        '',
        'Clique em **Adicionar Links e Evidências** para informar links de imagens, vídeos ou outras provas, ou clique em **Continuar sem links**.',
      ]
        .filter(Boolean)
        .join('\n'),
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === 'exp_form_links_modal') {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'Este formulário só pode ser enviado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const rawMediaLinks = interaction.fields.getTextInputValue('exp_media_links').trim();
    const rawOtherLinks = interaction.fields.getTextInputValue('exp_other_links').trim();

    const privacyCheck = validateExpNoPrivateData({
      mediaLinks: rawMediaLinks,
      otherLinks: rawOtherLinks,
    });

    if (!privacyCheck.ok) {
      await interaction.reply({
        content: `🚫 **Links bloqueados pela proteção de privacidade:**\n${privacyCheck.reason}`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const draft = getExpDraft(interaction.guild.id, interaction.user.id);
    if (!draft) {
      await interaction.reply({
        content: 'Seu rascunho expirou. Clique novamente em EXPONHA UMA OCORRÊNCIA no canal.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const mediaLinks = parseEvidenceLinks(rawMediaLinks);
    const otherLinks = parseEvidenceLinks(rawOtherLinks);

    const updated = saveExpDraft({
      ...draft,
      mediaLinks,
      otherLinks,
      updatedAt: new Date().toISOString(),
    });

    await interaction.reply({
      content: [
        '**Etapa 2 concluída — Escolha o Formato da Exposição**',
        `• **Descrição:** ${updated.description}`,
        `• **Links de imagens/vídeos válidos:** ${mediaLinks.length}`,
        `• **Outros links válidos:** ${otherLinks.length}`,
        '',
        'Escolha abaixo o formato para gerar e visualizar a prévia antes do envio:',
      ].join('\n'),
      components: [buildFormatSelectionRow()],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}
