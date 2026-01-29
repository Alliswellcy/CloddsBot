/**
 * Channel Manager - Handles messaging platform integrations
 */

import { WebSocketServer } from 'ws';
import { createTelegramChannel } from './telegram/index';
import { createDiscordChannel } from './discord/index';
import { createWebChatChannel, WebChatChannel } from './webchat/index';
import { createWhatsAppChannel, WhatsAppConfig } from './whatsapp/index';
import { createSlackChannel, SlackConfig } from './slack/index';
import { createGoogleChatChannel, GoogleChatConfig } from './googlechat/index';
import { createTeamsChannel, TeamsConfig } from './teams/index';
import { createMatrixChannel, MatrixConfig } from './matrix/index';
import { createSignalChannel, SignalConfig } from './signal/index';
import { createiMessageChannel, iMessageConfig } from './imessage/index';
import { createLineChannel, LineChannelConfig } from './line/index';
import { createMattermostChannel, MattermostConfig } from './mattermost/index';
import { createNextcloudTalkChannel, NextcloudTalkConfig } from './nextcloud-talk/index';
import { createNostrChannel, NostrConfig } from './nostr/index';
import { createTlonChannel, TlonConfig } from './tlon/index';
import { createTwitchChannel, TwitchConfig } from './twitch/index';
import { createVoiceChannel, VoiceConfig } from './voice/index';
import { createBlueBubblesChannel, BlueBubblesConfig } from './bluebubbles/index';
import { createZaloChannel, ZaloConfig, createZaloPersonalChannel, ZaloPersonalConfig } from './zalo/index';
import { logger } from '../utils/logger';
import type {
  Config,
  IncomingMessage,
  OfflineQueueConfig,
  OutgoingMessage,
  ReactionMessage,
  PollMessage,
} from '../types';
import type { PairingService } from '../pairing/index';
import type { CommandRegistry } from '../commands/registry';
import { formatOutgoingMessage } from '../messages/unified';

export interface DraftStream {
  start(initialText?: string): Promise<string | null>;
  update(newText: string): Promise<void>;
  append?(additionalText: string): Promise<void>;
  finish(finalText?: string): Promise<string | null>;
  cancel(): Promise<void>;
  getMessageId?(): string | null;
  getText?(): string;
}

export interface ChannelAdapter {
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: OutgoingMessage): Promise<string | null>;
  isConnected?: (message?: OutgoingMessage) => boolean;
  /** Optional event handler for webhook-based channels */
  handleEvent?: (event: unknown, req?: unknown) => Promise<unknown>;
  editMessage?: (message: OutgoingMessage & { messageId: string }) => Promise<void>;
  deleteMessage?: (message: OutgoingMessage & { messageId: string }) => Promise<void>;
  reactMessage?: (message: ReactionMessage) => Promise<void>;
  sendPoll?: (message: PollMessage) => Promise<string | null>;
  /** Optional streaming/draft message support */
  createDraftStream?: (chatId: string) => DraftStream;
}

export interface ChannelManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<string | null>;
  edit(message: OutgoingMessage & { messageId: string }): Promise<void>;
  delete(message: OutgoingMessage & { messageId: string }): Promise<void>;
  react(message: ReactionMessage): Promise<void>;
  sendPoll(message: PollMessage): Promise<string | null>;
  attachWebSocket(wss: WebSocketServer): void;
  getAdapters(): Record<string, ChannelAdapter>;
}

export interface ChannelCallbacks {
  onMessage: (message: IncomingMessage) => Promise<void>;
  pairing?: PairingService;
  commands?: CommandRegistry;
}

export async function createChannelManager(
  config: Config['channels'],
  callbacks: ChannelCallbacks,
  options?: { offlineQueue?: OfflineQueueConfig }
): Promise<ChannelManager> {
  const channels = new Map<string, ChannelAdapter>();
  let webchat: WebChatChannel | null = null;
  const offlineQueue = resolveOfflineQueueConfig(options?.offlineQueue);
  const queueByPlatform = new Map<string, Array<QueuedMessage>>();
  let queueTimer: NodeJS.Timeout | null = null;

  // Initialize Telegram if enabled
  if (config.telegram?.enabled && config.telegram.botToken) {
    logger.info('Initializing Telegram channel');
    const telegram = await createTelegramChannel(
      config.telegram,
      callbacks,
      callbacks.pairing,
      callbacks.commands
    );
    channels.set('telegram', telegram as unknown as ChannelAdapter);
  }

  // Initialize Discord if enabled
  if (config.discord?.enabled && config.discord.token) {
    logger.info('Initializing Discord channel');
    const discord = await createDiscordChannel(
      config.discord,
      callbacks,
      callbacks.pairing,
      callbacks.commands
    );
    channels.set('discord', discord);
  }

  // Initialize WebChat if enabled (starts when WebSocket attached)
  if (config.webchat?.enabled) {
    logger.info('Initializing WebChat channel');
    webchat = createWebChatChannel(config.webchat, callbacks);
  }

  // Initialize WhatsApp if enabled
  if ((config as any).whatsapp?.enabled) {
    logger.info('Initializing WhatsApp channel');
    const whatsapp = await createWhatsAppChannel(
      (config as any).whatsapp as WhatsAppConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('whatsapp', whatsapp);
  }

  // Initialize Slack if enabled
  if ((config as any).slack?.enabled && (config as any).slack?.botToken) {
    logger.info('Initializing Slack channel');
    const slack = await createSlackChannel(
      (config as any).slack as SlackConfig,
      callbacks,
      callbacks.pairing,
      callbacks.commands
    );
    channels.set('slack', slack);
  }

  // Initialize Google Chat if enabled
  if ((config as any).googlechat?.enabled) {
    logger.info('Initializing Google Chat channel');
    const googlechat = await createGoogleChatChannel(
      (config as any).googlechat as GoogleChatConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('googlechat', googlechat);
  }

  // Initialize Microsoft Teams if enabled
  if ((config as any).teams?.enabled && (config as any).teams?.appId) {
    logger.info('Initializing Microsoft Teams channel');
    const teams = await createTeamsChannel(
      (config as any).teams as TeamsConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('teams', teams);
  }

  // Initialize Matrix if enabled
  if ((config as any).matrix?.enabled && (config as any).matrix?.accessToken) {
    logger.info('Initializing Matrix channel');
    const matrix = await createMatrixChannel(
      (config as any).matrix as MatrixConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('matrix', matrix);
  }

  // Initialize Signal if enabled
  if ((config as any).signal?.enabled && (config as any).signal?.phoneNumber) {
    logger.info('Initializing Signal channel');
    const signal = await createSignalChannel(
      (config as any).signal as SignalConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('signal', signal);
  }

  // Initialize iMessage if enabled (macOS only)
  if ((config as any).imessage?.enabled && process.platform === 'darwin') {
    logger.info('Initializing iMessage channel');
    const imessage = await createiMessageChannel(
      (config as any).imessage as iMessageConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('imessage', imessage);
  }

  // Initialize LINE if enabled
  if ((config as any).line?.enabled) {
    logger.info('Initializing LINE channel');
    const line = await createLineChannel(
      (config as any).line as LineChannelConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('line', line);
  }

  // Initialize Mattermost if enabled
  if ((config as any).mattermost?.enabled && (config as any).mattermost?.accessToken) {
    logger.info('Initializing Mattermost channel');
    const mattermost = await createMattermostChannel(
      (config as any).mattermost as MattermostConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('mattermost', mattermost);
  }

  // Initialize Nextcloud Talk if enabled
  if ((config as any)['nextcloud-talk']?.enabled && (config as any)['nextcloud-talk']?.appPassword) {
    logger.info('Initializing Nextcloud Talk channel');
    const nextcloudTalk = await createNextcloudTalkChannel(
      (config as any)['nextcloud-talk'] as NextcloudTalkConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('nextcloud-talk', nextcloudTalk);
  }

  // Initialize Nostr if enabled
  if ((config as any).nostr?.enabled && (config as any).nostr?.privateKey) {
    logger.info('Initializing Nostr channel');
    const nostr = await createNostrChannel(
      (config as any).nostr as NostrConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('nostr', nostr);
  }

  // Initialize Tlon (Urbit) if enabled
  if ((config as any).tlon?.enabled && (config as any).tlon?.code) {
    logger.info('Initializing Tlon channel');
    const tlon = await createTlonChannel(
      (config as any).tlon as TlonConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('tlon', tlon);
  }

  // Initialize Twitch if enabled
  if ((config as any).twitch?.enabled && (config as any).twitch?.oauthToken) {
    logger.info('Initializing Twitch channel');
    const twitch = await createTwitchChannel(
      (config as any).twitch as TwitchConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('twitch', twitch);
  }

  // Initialize Voice if enabled
  if ((config as any).voice?.enabled && (config as any).voice?.phoneNumber) {
    logger.info('Initializing Voice channel');
    const voice = await createVoiceChannel(
      (config as any).voice as VoiceConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('voice', voice);
  }

  // Initialize BlueBubbles if enabled
  if ((config as any).bluebubbles?.enabled && (config as any).bluebubbles?.password) {
    logger.info('Initializing BlueBubbles channel');
    const bluebubbles = await createBlueBubblesChannel(
      (config as any).bluebubbles as BlueBubblesConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('bluebubbles', bluebubbles);
  }

  // Initialize Zalo OA if enabled
  if ((config as any).zalo?.enabled && (config as any).zalo?.accessToken) {
    logger.info('Initializing Zalo channel');
    const zalo = await createZaloChannel(
      (config as any).zalo as ZaloConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('zalo', zalo);
  }

  // Initialize Zalo Personal if enabled
  if ((config as any)['zalo-personal']?.enabled && (config as any)['zalo-personal']?.cookies) {
    logger.info('Initializing Zalo Personal channel');
    const zaloPersonal = await createZaloPersonalChannel(
      (config as any)['zalo-personal'] as ZaloPersonalConfig,
      callbacks,
      callbacks.pairing
    );
    channels.set('zalo-personal', zaloPersonal);
  }

  return {
    async start() {
      for (const [name, channel] of channels) {
        logger.info({ channel: name }, 'Starting channel');
        await channel.start();
      }
      if (offlineQueue.enabled && !queueTimer) {
        queueTimer = setInterval(() => {
          flushAllQueues().catch((error) => {
            logger.warn({ error }, 'Failed to flush offline message queue');
          });
        }, offlineQueue.retryIntervalMs);
      }
    },

    async stop() {
      for (const [name, channel] of channels) {
        logger.info({ channel: name }, 'Stopping channel');
        await channel.stop();
      }
      if (webchat) {
        webchat.stop();
      }
      if (queueTimer) {
        clearInterval(queueTimer);
        queueTimer = null;
      }
    },

    async send(message: OutgoingMessage): Promise<string | null> {
      const formatted = formatOutgoingMessage(message);
      await flushQueueFor(formatted.platform);
      // Handle webchat separately
      if (formatted.platform === 'webchat') {
        if (webchat) {
          if (!isAdapterConnected(webchat, formatted)) {
            enqueueMessage(formatted, 'WebChat not connected');
            return null;
          }
          try {
            return await webchat.sendMessage(formatted);
          } catch (error) {
            enqueueMessage(formatted, 'WebChat send failed', error);
            return null;
          }
        } else {
          if (isPlatformEnabled('webchat')) {
            enqueueMessage(formatted, 'WebChat not enabled');
          } else {
            logger.warn('WebChat not enabled');
          }
          return null;
        }
      }

      const channel = channels.get(formatted.platform);
      if (channel) {
        if (!isAdapterConnected(channel, formatted)) {
          enqueueMessage(formatted, 'Channel not connected');
          return null;
        }
        try {
          return await channel.sendMessage(formatted);
        } catch (error) {
          enqueueMessage(formatted, 'Channel send failed', error);
          return null;
        }
      } else {
        if (isPlatformEnabled(formatted.platform)) {
          enqueueMessage(formatted, 'Channel not initialized');
        } else {
          logger.warn({ platform: formatted.platform }, 'Unknown channel');
        }
        return null;
      }
    },

    async edit(message: OutgoingMessage & { messageId: string }) {
      const formatted = {
        ...formatOutgoingMessage(message),
        messageId: message.messageId,
      };
      const channel = channels.get(formatted.platform);
      if (channel?.editMessage) {
        await channel.editMessage(formatted);
      } else {
        logger.warn({ platform: formatted.platform }, 'Edit not supported for channel');
      }
    },

    async delete(message: OutgoingMessage & { messageId: string }) {
      const formatted = {
        ...formatOutgoingMessage(message),
        messageId: message.messageId,
      };
      const channel = channels.get(formatted.platform);
      if (channel?.deleteMessage) {
        await channel.deleteMessage(formatted);
      } else {
        logger.warn({ platform: formatted.platform }, 'Delete not supported for channel');
      }
    },

    async react(message: ReactionMessage) {
      const channel = channels.get(message.platform);
      if (!channel?.reactMessage) {
        logger.warn({ platform: message.platform }, 'Reactions not supported for channel');
        return;
      }
      if (!isPlatformEnabled(message.platform)) {
        logger.warn({ platform: message.platform }, 'Channel not enabled; skipping reaction');
        return;
      }
      if (channel.isConnected && !channel.isConnected({
        platform: message.platform,
        chatId: message.chatId,
        text: '',
        accountId: message.accountId,
      })) {
        logger.warn({ platform: message.platform }, 'Channel not connected; skipping reaction');
        return;
      }
      await channel.reactMessage(message);
    },

    async sendPoll(message: PollMessage): Promise<string | null> {
      const channel = channels.get(message.platform);
      if (!channel?.sendPoll) {
        logger.warn({ platform: message.platform }, 'Polls not supported for channel');
        return null;
      }
      if (!isPlatformEnabled(message.platform)) {
        logger.warn({ platform: message.platform }, 'Channel not enabled; skipping poll');
        return null;
      }
      if (channel.isConnected && !channel.isConnected({
        platform: message.platform,
        chatId: message.chatId,
        text: '',
        accountId: message.accountId,
      })) {
        logger.warn({ platform: message.platform }, 'Channel not connected; skipping poll');
        return null;
      }
      return channel.sendPoll(message);
    },

    attachWebSocket(wss: WebSocketServer) {
      if (webchat) {
        webchat.start(wss);
        logger.info('WebChat attached to WebSocket server');
        flushQueueFor('webchat').catch((error) => {
          logger.warn({ error }, 'Failed to flush WebChat queue');
        });
      }
    },

    getAdapters(): Record<string, ChannelAdapter> {
      return Object.fromEntries(channels);
    },
  };

  function resolveOfflineQueueConfig(
    input?: OfflineQueueConfig
  ): Required<OfflineQueueConfig> {
    return {
      enabled: input?.enabled ?? true,
      maxSize: Math.max(1, input?.maxSize ?? 200),
      maxAgeMs: Math.max(1000, input?.maxAgeMs ?? 15 * 60 * 1000),
      retryIntervalMs: Math.max(1000, input?.retryIntervalMs ?? 5000),
      maxRetries: Math.max(1, input?.maxRetries ?? 10),
    };
  }

  function isPlatformEnabled(platform: string): boolean {
    const channelConfig = (config as Record<string, { enabled?: boolean } | undefined>)[platform];
    return Boolean(channelConfig?.enabled);
  }

  function isAdapterConnected(
    adapter: { isConnected?: (message?: OutgoingMessage) => boolean },
    message: OutgoingMessage
  ): boolean {
    if (!adapter.isConnected) return true;
    try {
      return adapter.isConnected(message);
    } catch (error) {
      logger.warn({ error }, 'Channel isConnected check failed');
      return true;
    }
  }

  function enqueueMessage(
    message: OutgoingMessage,
    reason: string,
    error?: unknown
  ): void {
    if (!offlineQueue.enabled) {
      logger.warn({ platform: message.platform, reason }, 'Dropping message (offline queue disabled)');
      return;
    }

    const queue = queueByPlatform.get(message.platform) ?? [];
    queue.push({
      message,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastError: error instanceof Error ? error.message : undefined,
    });
    while (queue.length > offlineQueue.maxSize) {
      queue.shift();
    }
    queueByPlatform.set(message.platform, queue);
    logger.warn(
      { platform: message.platform, reason, queued: queue.length },
      'Message queued (offline)'
    );
  }

  async function flushAllQueues(): Promise<void> {
    const platforms = new Set(queueByPlatform.keys());
    for (const platform of platforms) {
      await flushQueueFor(platform);
    }
  }

  async function flushQueueFor(platform: string): Promise<void> {
    if (!offlineQueue.enabled) return;
    const queue = queueByPlatform.get(platform);
    if (!queue || queue.length === 0) return;

    const now = Date.now();
    while (queue.length > 0) {
      const item = queue[0];
      if (now - item.enqueuedAt > offlineQueue.maxAgeMs) {
        queue.shift();
        logger.warn({ platform }, 'Dropping expired queued message');
        continue;
      }
      if (item.attempts >= offlineQueue.maxRetries) {
        queue.shift();
        logger.warn({ platform }, 'Dropping queued message (max retries)');
        continue;
      }

      const adapter = platform === 'webchat' ? webchat : channels.get(platform);
      if (!adapter) return;
      if (!isAdapterConnected(adapter, item.message)) return;

      try {
        if (platform === 'webchat') {
          await (adapter as WebChatChannel).sendMessage(item.message);
        } else {
          await (adapter as ChannelAdapter).sendMessage(item.message);
        }
        queue.shift();
      } catch (error) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        logger.warn({ platform, attempts: item.attempts }, 'Queued message send failed');
        return;
      }
    }
  }
}

interface QueuedMessage {
  message: OutgoingMessage;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}
