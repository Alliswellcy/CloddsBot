/**
 * Slash Command Registry - shared command registration and handling
 *
 * Provides a single source of truth for commands across channels and
 * supports platform-level registration (e.g., Telegram setMyCommands).
 */

import type { IncomingMessage, OutgoingMessage, Platform, Position, Session, User, Market } from '../types';
import type { SessionManager } from '../sessions/index';
import type { FeedManager } from '../feeds/index';
import type { Database } from '../db/index';
import type { MemoryService } from '../memory/index';
import { logger } from '../utils/logger';
import { execApprovals } from '../permissions';

export interface CommandContext {
  session: Session;
  message: IncomingMessage;
  sessions: SessionManager;
  feeds: FeedManager;
  db: Database;
  memory?: MemoryService;
  commands: CommandRegistry;
  send: (message: OutgoingMessage) => Promise<string | null>;
}

export interface CommandDefinition {
  /** Command name without leading slash, e.g. "help" */
  name: string;
  /** Short human-readable description */
  description: string;
  /** Usage string including slash */
  usage: string;
  /** Optional aliases without leading slash */
  aliases?: string[];
  /** Whether this should be registered with platform UIs */
  register?: boolean;
  /** Handle a command invocation */
  handler: (args: string, ctx: CommandContext) => Promise<string> | string;
}

export interface CommandInfo {
  name: string;
  description: string;
  usage: string;
  register: boolean;
}

export interface CommandRegistry {
  register(command: CommandDefinition): void;
  registerMany(commands: CommandDefinition[]): void;
  list(): CommandInfo[];
  /**
   * Handle a command message. Returns null when not handled.
   */
  handle(message: IncomingMessage, ctx: Omit<CommandContext, 'message' | 'commands'>): Promise<string | null>;
}

const PLATFORM_NAMES: Platform[] = [
  'polymarket',
  'kalshi',
  'manifold',
  'metaculus',
  'predictit',
  'drift',
  'betfair',
];

function isPlatformName(value: string): value is Platform {
  return PLATFORM_NAMES.includes(value as Platform);
}

function parseRememberArgs(args: string): {
  scope: 'global' | 'channel';
  type: 'fact' | 'preference' | 'note' | 'profile';
  key: string;
  value: string;
  error?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      scope: 'global',
      type: 'note',
      key: '',
      value: '',
      error: 'Usage: /remember [global|channel] [fact|preference|note|profile] <key>=<value>',
    };
  }

  const tokens = trimmed.split(/\s+/);
  let scope: 'global' | 'channel' = 'global';
  let type: 'fact' | 'preference' | 'note' | 'profile' = 'note';

  if (tokens[0] === 'global' || tokens[0] === 'channel') {
    scope = tokens.shift() as 'global' | 'channel';
  }

  if (
    tokens[0] === 'fact' ||
    tokens[0] === 'preference' ||
    tokens[0] === 'note' ||
    tokens[0] === 'profile'
  ) {
    type = tokens.shift() as 'fact' | 'preference' | 'note' | 'profile';
  }

  const remainder = tokens.join(' ').trim();
  if (!remainder) {
    return {
      scope,
      type,
      key: '',
      value: '',
      error: 'Usage: /remember [global|channel] [fact|preference|note|profile] <key>=<value>',
    };
  }

  if (type === 'profile' && !remainder.includes('=') && !remainder.includes(':')) {
    return {
      scope,
      type,
      key: 'profile',
      value: remainder,
    };
  }

  const match = remainder.match(/^([^:=]+)[:=](.+)$/);
  if (!match) {
    return {
      scope,
      type,
      key: '',
      value: '',
      error: 'Usage: /remember [global|channel] [fact|preference|note|profile] <key>=<value>',
    };
  }

  const key = match[1].trim();
  const value = match[2].trim();
  if (!key || !value) {
    return {
      scope,
      type,
      key: '',
      value: '',
      error: 'Usage: /remember [global|channel] [fact|preference|note|profile] <key>=<value>',
    };
  }

  return {
    scope,
    type,
    key: key.slice(0, 120),
    value: value.slice(0, 500),
  };
}

function formatPriceCents(price: number): string {
  const cents = Math.round(price * 100);
  return `${cents}c`;
}

function formatMemoryEntries(
  label: string,
  entries: Array<{ key: string; value: string }>,
  max = 10
): string[] {
  const lines: string[] = [label];
  for (const entry of entries.slice(0, max)) {
    const value = entry.value.length > 80 ? `${entry.value.slice(0, 80)}...` : entry.value;
    lines.push(`- ${entry.key}: ${value}`);
  }
  if (entries.length > max) {
    lines.push(`...and ${entries.length - max} more.`);
  }
  return lines;
}

function estimateTokensFromHistory(session: Session): number {
  const history = session.context.conversationHistory || [];
  const totalChars = history.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.max(0, Math.round(totalChars / 4));
}

function isOwner(db: Database, channel: string, userId: string): boolean {
  try {
    const rows = db.query<{ isOwner: number }>(
      'SELECT isOwner FROM paired_users WHERE channel = ? AND userId = ? LIMIT 1',
      [channel, userId]
    );
    return rows[0]?.isOwner === 1;
  } catch {
    return false;
  }
}

function summarizePositions(positions: Position[]): {
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  byPlatform: Map<string, { value: number; pnl: number }>;
} {
  let totalValue = 0;
  let totalPnl = 0;
  const byPlatform = new Map<string, { value: number; pnl: number }>();

  for (const pos of positions) {
    const value = pos.shares * pos.currentPrice;
    const pnl = value - pos.shares * pos.avgPrice;

    totalValue += value;
    totalPnl += pnl;

    const agg = byPlatform.get(pos.platform) || { value: 0, pnl: 0 };
    agg.value += value;
    agg.pnl += pnl;
    byPlatform.set(pos.platform, agg);
  }

  const totalCostBasis = positions.reduce((sum, p) => sum + p.shares * p.avgPrice, 0);
  const totalPnlPct = totalCostBasis > 0 ? totalPnl / totalCostBasis : 0;

  return { totalValue, totalPnl, totalPnlPct, byPlatform };
}

function parsePnlHistoryArgs(args: string): {
  sinceMs?: number;
  limit: number;
  error?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return { limit: 24 };
  }

  let limit = 24;
  let sinceMs: number | undefined;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const now = Date.now();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('limit=')) {
      const value = Number.parseInt(lower.slice('limit='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        return { limit, error: 'Limit must be a positive integer.' };
      }
      limit = Math.min(value, 500);
      continue;
    }

    const match = lower.match(/^(\d+)([hdw]|m)$/);
    if (match) {
      const amount = Number.parseInt(match[1], 10);
      const unit = match[2];
      const mult =
        unit === 'm'
          ? 60 * 1000
          : unit === 'h'
            ? 60 * 60 * 1000
            : unit === 'd'
              ? 24 * 60 * 60 * 1000
              : 7 * 24 * 60 * 60 * 1000;
      sinceMs = now - amount * mult;
      continue;
    }

    if (/^\d+$/.test(lower)) {
      const hours = Number.parseInt(lower, 10);
      sinceMs = now - hours * 60 * 60 * 1000;
      continue;
    }

    return { limit, error: 'Usage: /pnl [24h|7d|30m] [limit=50]' };
  }

  return { sinceMs, limit };
}

function parseCompareArgs(args: string): {
  query?: string;
  platforms?: string[];
  limit: number;
  error?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return { limit: 3, error: 'Usage: /compare <query> [platforms=polymarket,kalshi] [limit=3]' };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const queryParts: string[] = [];
  let platforms: string[] | undefined;
  let limit = 3;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('limit=')) {
      const value = Number.parseInt(lower.slice('limit='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        return { limit, error: 'Limit must be a positive integer.' };
      }
      limit = Math.min(value, 10);
      continue;
    }
    if (lower.startsWith('platforms=')) {
      const raw = lower.slice('platforms='.length);
      platforms = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      continue;
    }
    queryParts.push(token);
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    return { limit, error: 'Usage: /compare <query> [platforms=polymarket,kalshi] [limit=3]' };
  }
  return { query, platforms, limit };
}

function parseArbitrageArgs(args: string): {
  query: string;
  platforms?: string[];
  limit: number;
  minEdge: number;
  mode: 'internal' | 'cross' | 'both';
  error?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return { query: '', platforms: undefined, limit: 10, minEdge: 1, mode: 'both' };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const queryParts: string[] = [];
  let platforms: string[] | undefined;
  let limit = 10;
  let minEdge = 1;
  let mode: 'internal' | 'cross' | 'both' = 'both';

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('limit=')) {
      const value = Number.parseInt(lower.slice('limit='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        return { query: '', platforms, limit, minEdge, mode, error: 'Limit must be a positive integer.' };
      }
      limit = Math.min(value, 20);
      continue;
    }
    if (lower.startsWith('minedge=')) {
      const value = Number.parseFloat(lower.slice('minedge='.length));
      if (!Number.isFinite(value) || value < 0) {
        return { query: '', platforms, limit, minEdge, mode, error: 'minEdge must be a non-negative number.' };
      }
      minEdge = value;
      continue;
    }
    if (lower.startsWith('platforms=')) {
      const raw = lower.slice('platforms='.length);
      platforms = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      continue;
    }
    if (lower.startsWith('mode=')) {
      const raw = lower.slice('mode='.length);
      if (raw === 'internal' || raw === 'cross' || raw === 'both') {
        mode = raw;
        continue;
      }
      return { query: '', platforms, limit, minEdge, mode, error: 'mode must be internal, cross, or both.' };
    }
    queryParts.push(token);
  }

  return { query: queryParts.join(' ').trim(), platforms, limit, minEdge, mode };
}

function parseRiskSettingsArgs(args: string): {
  patch?: Partial<User['settings']>;
  error?: string;
  show?: boolean;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return { show: true };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (head === 'show') {
    return { show: true };
  }

  if (head === 'reset' || head === 'clear') {
    return {
      patch: {
        maxOrderSize: undefined,
        maxPositionValue: undefined,
        maxTotalExposure: undefined,
        stopLossPct: undefined,
      },
    };
  }

  if (head === 'off' || head === 'disable') {
    return {
      patch: {
        maxOrderSize: 0,
        maxPositionValue: 0,
        maxTotalExposure: 0,
        stopLossPct: 0,
      },
    };
  }

  if (head === 'set') {
    tokens.shift();
  }

  if (tokens.length === 0) {
    return { error: 'Usage: /risk set maxOrderSize=100 maxPositionValue=500 maxTotalExposure=2000 stopLossPct=0.2' };
  }

  const patch: Partial<User['settings']> = {};
  for (const token of tokens) {
    const [rawKey, rawValue] = token.split('=');
    if (!rawKey || rawValue === undefined) {
      return { error: 'Usage: /risk set maxOrderSize=100 maxPositionValue=500 maxTotalExposure=2000 stopLossPct=0.2' };
    }
    const key = rawKey.trim().toLowerCase();
    let valueText = rawValue.trim();
    if (!valueText) continue;

    let value: number | undefined;
    if (valueText.toLowerCase() === 'off') {
      value = 0;
    } else {
      if (valueText.endsWith('%')) {
        valueText = valueText.slice(0, -1);
      }
      const parsed = Number(valueText);
      if (!Number.isFinite(parsed)) {
        return { error: `Invalid number for ${rawKey}: ${rawValue}` };
      }
      value = parsed;
    }

    switch (key) {
      case 'maxordersize':
      case 'max_order_size':
      case 'max-order-size':
        patch.maxOrderSize = value;
        break;
      case 'maxpositionvalue':
      case 'max_position_value':
      case 'max-position-value':
        patch.maxPositionValue = value;
        break;
      case 'maxtotalexposure':
      case 'max_total_exposure':
      case 'max-total-exposure':
        patch.maxTotalExposure = value;
        break;
      case 'stoplosspct':
      case 'stop_loss_pct':
      case 'stop-loss-pct':
        patch.stopLossPct = value;
        break;
      default:
        return { error: `Unknown setting: ${rawKey}` };
    }
  }

  return { patch };
}

function parseDigestSettingsArgs(args: string): {
  patch?: Partial<User['settings']>;
  error?: string;
  show?: boolean;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return { show: true };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const patch: Partial<User['settings']> = {};
  let show = false;

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();
    if (token === 'show' || token === 'status') {
      show = true;
      continue;
    }
    if (token === 'on' || token === 'enable') {
      patch.digestEnabled = true;
      continue;
    }
    if (token === 'off' || token === 'disable') {
      patch.digestEnabled = false;
      continue;
    }
    if (token === 'reset' || token === 'clear') {
      patch.digestEnabled = false;
      patch.digestTime = undefined;
      continue;
    }

    const timeToken = token.startsWith('time=') ? token.slice('time='.length) : token;
    const match = timeToken.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hour = Number.parseInt(match[1], 10);
      const minute = Number.parseInt(match[2], 10);
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
        return { error: 'Hour must be between 0 and 23.' };
      }
      if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
        return { error: 'Minute must be between 0 and 59.' };
      }
      patch.digestTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      patch.digestEnabled = true;
      continue;
    }

    return { error: 'Usage: /digest [on|off|HH:MM|time=HH:MM|show|reset]' };
  }

  if (show && Object.keys(patch).length === 0) {
    return { show: true };
  }

  return { patch: Object.keys(patch).length === 0 ? undefined : patch };
}

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, CommandDefinition>();
  const aliasToName = new Map<string, string>();

  function register(command: CommandDefinition): void {
    commands.set(command.name, command);

    if (command.aliases) {
      for (const alias of command.aliases) {
        aliasToName.set(alias, command.name);
      }
    }
  }

  function registerMany(defs: CommandDefinition[]): void {
    for (const def of defs) register(def);
  }

  function list(): CommandInfo[] {
    return Array.from(commands.values())
      .map((c) => ({
        name: `/${c.name}`,
        description: c.description,
        usage: c.usage,
        register: c.register !== false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function handle(
    message: IncomingMessage,
    ctx: Omit<CommandContext, 'message' | 'commands'>
  ): Promise<string | null> {
    const text = message.text.trim();
    if (!text.startsWith('/')) return null;

    const spaceIdx = text.indexOf(' ');
    const rawName = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
    const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';

    const resolvedName = commands.has(rawName) ? rawName : aliasToName.get(rawName);
    if (!resolvedName) return null;

    const command = commands.get(resolvedName);
    if (!command) return null;

    try {
      const response = await command.handler(args, {
        ...ctx,
        commands: registry,
        message,
      });
      logger.info({ command: command.name, userId: message.userId }, 'Command handled');
      return response;
    } catch (error) {
      logger.error({ error, command: command.name }, 'Command handler failed');
      return `Error running /${command.name}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  const registry: CommandRegistry = {
    register,
    registerMany,
    list,
    handle,
  };

  return registry;
}

export function createDefaultCommands(): CommandDefinition[] {
  return [
    {
      name: 'help',
      description: 'Show available commands',
      usage: '/help',
      handler: (_args, ctx) => {
        const lines = ['Clodds Commands', ''];
        for (const cmd of ctx.commands.list()) {
          lines.push(`${cmd.name} - ${cmd.description}`);
        }
        lines.push('', 'Tip: try /markets <query> or /portfolio');
        return lines.join('\n');
      },
    },
    {
      name: 'remember',
      description: 'Store a memory entry',
      usage: '/remember [global|channel] [fact|preference|note|profile] <key>=<value>',
      handler: (args, ctx) => {
        if (!ctx.memory) {
          return 'Memory service not available.';
        }

        const parsed = parseRememberArgs(args);
        if (parsed.error) {
          return parsed.error;
        }

        const channelKey = ctx.message.chatId || ctx.message.platform;
        const scopeKey = parsed.scope === 'channel' ? channelKey : 'global';

        ctx.memory.remember(ctx.message.userId, scopeKey, parsed.type, parsed.key, parsed.value);

        return `Saved ${parsed.type} to ${parsed.scope} memory: ${parsed.key}`;
      },
    },
    {
      name: 'memory',
      description: 'Show stored memory entries',
      usage: '/memory',
      handler: (_args, ctx) => {
        if (!ctx.memory) {
          return 'Memory service not available.';
        }

        const channelKey = ctx.message.chatId || ctx.message.platform;
        const globalEntries = ctx.memory.recallAll(ctx.message.userId, 'global');
        const channelEntries = channelKey === 'global'
          ? []
          : ctx.memory.recallAll(ctx.message.userId, channelKey);

        if (globalEntries.length === 0 && channelEntries.length === 0) {
          return 'No memories stored for you yet.';
        }

        const lines: string[] = ['Your Memory', ''];
        if (globalEntries.length > 0) {
          lines.push(...formatMemoryEntries('Global', globalEntries));
          lines.push('');
        }
        if (channelEntries.length > 0) {
          lines.push(...formatMemoryEntries('This Channel', channelEntries));
        }
        return lines.join('\n').trim();
      },
    },
    {
      name: 'forget',
      description: 'Forget a memory entry',
      usage: '/forget <key>',
      handler: (args, ctx) => {
        if (!ctx.memory) {
          return 'Memory service not available.';
        }

        const key = args.trim();
        if (!key) {
          return 'Usage: /forget <key>';
        }

        const channelKey = ctx.message.chatId || ctx.message.platform;
        const channelRemoved = ctx.memory.forget(ctx.message.userId, channelKey, key);
        const globalRemoved = channelKey !== 'global'
          ? ctx.memory.forget(ctx.message.userId, 'global', key)
          : false;

        if (channelRemoved || globalRemoved) {
          const scopes = [
            channelRemoved ? 'channel' : null,
            globalRemoved ? 'global' : null,
          ].filter(Boolean).join(' + ');
          return `Forgot ${key} (${scopes})`;
        }
        return `Memory not found: ${key}`;
      },
    },
    {
      name: 'new',
      description: 'Start a fresh conversation',
      usage: '/new',
      aliases: ['reset'],
      handler: (_args, ctx) => {
        ctx.sessions.reset(ctx.session.id);
        return 'Session reset. Starting fresh.';
      },
    },
    {
      name: 'resume',
      description: 'Resume from the last checkpoint (if available)',
      usage: '/resume',
      handler: (_args, ctx) => {
        const restored = ctx.sessions.restoreCheckpoint(ctx.session);
        return restored
          ? 'Resumed conversation from last checkpoint.'
          : 'No checkpoint found to resume.';
      },
    },
    {
      name: 'status',
      description: 'Show session status and context usage',
      usage: '/status',
      handler: (_args, ctx) => {
        const uptimeMinutes = Math.max(
          0,
          Math.round((Date.now() - ctx.session.createdAt.getTime()) / 60000)
        );
        const tokens = estimateTokensFromHistory(ctx.session);

        return [
          'Session Status',
          `Session: ${ctx.session.id.slice(0, 8)}...`,
          `Channel: ${ctx.session.channel}`,
          `Messages: ${(ctx.session.context.conversationHistory || []).length}`,
          `Est. tokens: ~${tokens.toLocaleString()}`,
          `Uptime: ${uptimeMinutes}m`,
        ].join('\n');
      },
    },
    {
      name: 'risk',
      description: 'Show or update your risk limits',
      usage: '/risk [show|set ...|reset|off]',
      handler: (args, ctx) => {
        const parsed = parseRiskSettingsArgs(args);
        if (parsed.error) return parsed.error;

        if (parsed.show || !parsed.patch) {
          const user = ctx.db.getUser(ctx.session.userId);
          const settings: Partial<User['settings']> = user?.settings ?? {};
          const lines = [
            'Risk Settings',
            `maxOrderSize: ${settings.maxOrderSize ?? 'unset'}`,
            `maxPositionValue: ${settings.maxPositionValue ?? 'unset'}`,
            `maxTotalExposure: ${settings.maxTotalExposure ?? 'unset'}`,
            `stopLossPct: ${settings.stopLossPct ?? 'unset'}`,
          ];
          return lines.join('\n');
        }

        const ok = ctx.db.updateUserSettings(ctx.session.userId, parsed.patch);
        if (!ok) return 'Failed to update settings.';
        return 'Risk settings updated.';
      },
    },
    {
      name: 'digest',
      description: 'Configure daily digest notifications',
      usage: '/digest [on|off|HH:MM|time=HH:MM|show|reset]',
      handler: (args, ctx) => {
        const parsed = parseDigestSettingsArgs(args);
        if (parsed.error) return parsed.error;

        if (parsed.show || !parsed.patch) {
          const user = ctx.db.getUser(ctx.session.userId);
          const settings = user?.settings ?? {
            digestEnabled: false,
            digestTime: undefined,
          };
          const time = settings.digestTime ?? '09:00';
          return [
            'Daily Digest',
            `enabled: ${settings.digestEnabled ? 'on' : 'off'}`,
            `time: ${time}`,
          ].join('\n');
        }

        const ok = ctx.db.updateUserSettings(ctx.session.userId, parsed.patch);
        if (!ok) return 'Failed to update digest settings.';
        return 'Digest settings updated.';
      },
    },
    {
      name: 'approvals',
      description: 'List pending approval requests (owner only)',
      usage: '/approvals',
      handler: (_args, ctx) => {
        if (!isOwner(ctx.db, ctx.message.platform, ctx.message.userId)) {
          return 'Only owners can view approvals.';
        }

        const pending = execApprovals.getPendingApprovalsFromDisk();
        if (pending.length === 0) {
          return 'No pending approvals.';
        }

        const lines = ['Pending Approvals'];
        for (const req of pending.slice(0, 10)) {
          const expires = req.expiresAt ? req.expiresAt.toLocaleString() : 'n/a';
          lines.push(`- ${req.id} ${req.command} (agent ${req.agentId})`);
          lines.push(`  Expires: ${expires}`);
          if (req.requester) {
            lines.push(`  From: ${req.requester.userId} (${req.requester.channel})`);
          }
        }
        if (pending.length > 10) {
          lines.push(`...and ${pending.length - 10} more.`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'approve',
      description: 'Approve a pending request (owner only)',
      usage: '/approve <id> [always]',
      handler: (args, ctx) => {
        if (!isOwner(ctx.db, ctx.message.platform, ctx.message.userId)) {
          return 'Only owners can approve requests.';
        }

        const parts = args.trim().split(/\s+/).filter(Boolean);
        const requestId = parts[0];
        if (!requestId) {
          return 'Usage: /approve <id> [always]';
        }

        const always = parts.slice(1).some((p) => p.toLowerCase() === 'always');
        const decision = always ? 'allow-always' : 'allow-once';
        const ok = execApprovals.recordDecision(requestId, decision, ctx.message.userId);
        return ok ? `Approved ${requestId} (${decision})` : `Request not found: ${requestId}`;
      },
    },
    {
      name: 'deny',
      description: 'Deny a pending request (owner only)',
      usage: '/deny <id>',
      handler: (args, ctx) => {
        if (!isOwner(ctx.db, ctx.message.platform, ctx.message.userId)) {
          return 'Only owners can deny requests.';
        }

        const requestId = args.trim();
        if (!requestId) {
          return 'Usage: /deny <id>';
        }

        const ok = execApprovals.recordDecision(requestId, 'deny', ctx.message.userId);
        return ok ? `Denied ${requestId}` : `Request not found: ${requestId}`;
      },
    },
    {
      name: 'model',
      description: 'Show or change the current model',
      usage: '/model [sonnet|opus|haiku|claude-...]',
      handler: (args, ctx) => {
        const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
        const currentModel =
          ctx.session.context.modelOverride || ctx.session.context.model || defaultModel;

        if (!args) {
          return ['Current Model', currentModel, '', 'Usage: /model sonnet'].join('\n');
        }

        const requested = args.toLowerCase();
        const aliases: Record<string, string> = {
          sonnet: 'claude-sonnet-4-20250514',
          opus: 'claude-opus-4-20250514',
          haiku: 'claude-haiku-3-20240307',
        };

        const resolved = aliases[requested] || requested;
        if (!resolved.startsWith('claude-')) {
          return 'Unknown model. Try: sonnet, opus, haiku.';
        }

        ctx.session.context.modelOverride = resolved;
        ctx.sessions.updateSession(ctx.session);
        return `Model set to ${resolved}`;
      },
    },
    {
      name: 'context',
      description: 'Preview recent conversation context',
      usage: '/context',
      handler: (_args, ctx) => {
        const recent = (ctx.session.context.conversationHistory || []).slice(-5);
        if (recent.length === 0) {
          return 'No conversation history yet.';
        }

        const lines = ['Recent Context'];
        for (const [index, msg] of recent.entries()) {
          const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}...` : msg.content;
          lines.push(`${index + 1}. [${msg.role}] ${preview}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'markets',
      description: 'Search markets across platforms',
      usage: '/markets [platform] <query>',
      handler: async (args, ctx) => {
        if (!args) {
          return 'Usage: /markets [platform] <query>\nExample: /markets polymarket trump 2028';
        }

        const parts = args.split(/\s+/).filter(Boolean);
        let platform: Platform | undefined;
        let queryParts = parts;

        if (parts.length > 1 && isPlatformName(parts[0].toLowerCase())) {
          platform = parts[0].toLowerCase() as Platform;
          queryParts = parts.slice(1);
        }

        const query = queryParts.join(' ');
        if (!query) {
          return 'Please provide a search query.';
        }

        const markets = await ctx.feeds.searchMarkets(query, platform);
        if (markets.length === 0) {
          return `No markets found for "${query}"${platform ? ` on ${platform}` : ''}.`;
        }

        const top = markets.slice(0, 6);
        const lines = [`Markets${platform ? ` - ${platform}` : ''}`];

        for (const market of top) {
          const bestOutcome =
            market.outcomes.slice().sort((a, b) => b.volume24h - a.volume24h)[0] ||
            market.outcomes[0];
          const price = bestOutcome ? formatPriceCents(bestOutcome.price) : 'n/a';
          lines.push(`- ${market.question}`);
          lines.push(`  ${market.platform} - ${price} - vol ${Math.round(market.volume24h).toLocaleString()}`);
        }

        if (markets.length > top.length) {
          lines.push('', `...and ${markets.length - top.length} more.`);
        }

        return lines.join('\n');
      },
    },
    {
      name: 'compare',
      description: 'Compare market prices across platforms',
      usage: '/compare <query> [platforms=polymarket,kalshi] [limit=3]',
      handler: async (args, ctx) => {
        const parsed = parseCompareArgs(args);
        if (parsed.error || !parsed.query) return parsed.error || 'Please provide a query.';

        const markets = await ctx.feeds.searchMarkets(parsed.query);
        const filtered = parsed.platforms?.length
          ? markets.filter((m) => parsed.platforms?.includes(m.platform))
          : markets;

        if (filtered.length === 0) {
          return `No markets found for "${parsed.query}".`;
        }

        const byPlatform = new Map<string, typeof filtered>();
        for (const market of filtered) {
          const list = byPlatform.get(market.platform) || [];
          list.push(market);
          byPlatform.set(market.platform, list);
        }

        const lines: string[] = [`Market Comparison: ${parsed.query}`];
        const platforms = Array.from(byPlatform.keys()).sort();

        for (const platform of platforms) {
          const list = byPlatform.get(platform) || [];
          const top = list
            .slice()
            .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
            .slice(0, parsed.limit);

          lines.push('', platform);
          for (const market of top) {
            const yesOutcome = market.outcomes.find((o) => o.name?.toLowerCase() === 'yes');
            const bestOutcome = yesOutcome || market.outcomes[0];
            const price = bestOutcome ? formatPriceCents(bestOutcome.price) : 'n/a';
            const outcomeLabel = bestOutcome?.name ? ` (${bestOutcome.name})` : '';
            lines.push(
              `- ${market.question} — ${price}${outcomeLabel} — vol ${Math.round(market.volume24h).toLocaleString()}`
            );
          }
        }

        return lines.join('\n');
      },
    },
    {
      name: 'arbitrage',
      description: 'Find simple arbitrage opportunities (YES + NO < $1)',
      usage: '/arbitrage [query] [minEdge=1] [platforms=polymarket,kalshi] [mode=internal|cross|both] [limit=10]',
      handler: async (args, ctx) => {
        const parsed = parseArbitrageArgs(args);
        if (parsed.error) {
          return `Usage: /arbitrage [query] [minEdge=1] [platforms=polymarket,kalshi] [mode=internal|cross|both] [limit=10]\n${parsed.error}`;
        }

        const normalize = (text: string) =>
          text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const opportunities: Array<{ edge: number; lines: string[] }> = [];
        const query = parsed.query || '';

        if (parsed.mode === 'both' || parsed.mode === 'internal') {
          const markets = await ctx.feeds.searchMarkets(query, 'polymarket');
          for (const market of markets.slice(0, 60)) {
            if (market.outcomes.length < 2) continue;
            const yesOutcome = market.outcomes.find((o) => o.name?.toLowerCase() === 'yes') || market.outcomes[0];
            const noOutcome = market.outcomes.find((o) => o.name?.toLowerCase() === 'no') || market.outcomes[1];
            if (!yesOutcome || !noOutcome) continue;
            const yesPrice = yesOutcome.price;
            const noPrice = noOutcome.price;
            if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;
            const sum = yesPrice + noPrice;
            const edge = (1 - sum) * 100;
            if (edge < parsed.minEdge) continue;

            opportunities.push({
              edge,
              lines: [
                `- ${market.question} — ${edge.toFixed(2)}% (YES ${formatPriceCents(yesPrice)} / NO ${formatPriceCents(noPrice)})`,
                `  Buy YES at ${formatPriceCents(yesPrice)} + NO at ${formatPriceCents(noPrice)} = ${edge.toFixed(2)}% edge`,
              ],
            });
          }
        }

        if (parsed.mode === 'both' || parsed.mode === 'cross') {
          const platforms = parsed.platforms?.length ? parsed.platforms : ['polymarket', 'kalshi', 'manifold'];
          const results = await Promise.all(
            platforms.map(async (platform) => ({
              platform,
              markets: await ctx.feeds.searchMarkets(query, platform as Platform),
            }))
          );

          const grouped = new Map<string, Array<{ platform: string; market: Market; yesPrice: number }>>();
          for (const { platform, markets } of results) {
            for (const market of markets.slice(0, 30)) {
              const yesOutcome = market.outcomes.find((o) => o.name?.toLowerCase() === 'yes') || market.outcomes[0];
              if (!yesOutcome || !Number.isFinite(yesOutcome.price)) continue;
              const key = normalize(market.question).split(' ').slice(0, 8).join(' ');
              if (!key) continue;
              const list = grouped.get(key) || [];
              list.push({ platform, market, yesPrice: yesOutcome.price });
              grouped.set(key, list);
            }
          }

          for (const [, entries] of grouped.entries()) {
            const uniquePlatforms = new Set(entries.map((e) => e.platform));
            if (uniquePlatforms.size < 2) continue;
            const sorted = entries.slice().sort((a, b) => a.yesPrice - b.yesPrice);
            const low = sorted[0];
            const high = sorted[sorted.length - 1];
            const spread = (high.yesPrice - low.yesPrice) * 100;
            if (spread < parsed.minEdge) continue;

            opportunities.push({
              edge: spread,
              lines: [
                `- ${low.market.question} — ${spread.toFixed(2)}% spread`,
                `  Low: ${low.platform} ${formatPriceCents(low.yesPrice)} / High: ${high.platform} ${formatPriceCents(high.yesPrice)}`,
              ],
            });
          }
        }

        if (opportunities.length === 0) {
          return `No arbitrage opportunities found above ${parsed.minEdge}% edge.`;
        }

        opportunities.sort((a, b) => b.edge - a.edge);
        const lines = [`Arbitrage (${parsed.minEdge}%+ edge)`];
        for (const opp of opportunities.slice(0, parsed.limit)) {
          lines.push(...opp.lines);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'portfolio',
      description: 'Show your tracked positions and P&L',
      usage: '/portfolio',
      handler: async (_args, ctx) => {
        const positions = await ctx.db.getPositions(ctx.session.userId);
        if (positions.length === 0) {
          return 'No tracked positions yet. Add one by telling me what you bought.';
        }

        const summary = summarizePositions(positions);
        const lines = ['Portfolio'];
        lines.push(
          `Value: $${summary.totalValue.toFixed(2)} - P&L: $${summary.totalPnl.toFixed(2)} (${(
            summary.totalPnlPct * 100
          ).toFixed(1)}%)`
        );

        for (const [platform, agg] of summary.byPlatform) {
          const pnlPrefix = agg.pnl >= 0 ? '+' : '';
          lines.push(`- ${platform}: $${agg.value.toFixed(2)} (${pnlPrefix}$${agg.pnl.toFixed(2)})`);
        }

        const top = positions.slice(0, 6);
        lines.push('', 'Top positions:');
        for (const pos of top) {
          lines.push(
            `- [${pos.side}] ${pos.marketQuestion} - ${pos.outcome} - ${formatPriceCents(
              pos.currentPrice
            )} - ${pos.shares.toFixed(2)} sh`
          );
        }

        if (positions.length > top.length) {
          lines.push(`...and ${positions.length - top.length} more.`);
        }

        return lines.join('\n');
      },
    },
    {
      name: 'pnl',
      description: 'Show portfolio P&L history (snapshots)',
      usage: '/pnl [24h|7d|30m] [limit=50]',
      handler: async (args, ctx) => {
        const parsed = parsePnlHistoryArgs(args);
        if (parsed.error) return parsed.error;

        const snapshots = ctx.db.getPortfolioSnapshots(ctx.session.userId, {
          sinceMs: parsed.sinceMs,
          limit: parsed.limit,
          order: 'asc',
        });

        if (snapshots.length === 0) {
          return 'No P&L history yet. Snapshots are recorded when position prices update.';
        }

        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        const deltaPnl = last.totalPnl - first.totalPnl;
        const deltaValue = last.totalValue - first.totalValue;

        const formatStamp = (date: Date) =>
          date.toISOString().replace('T', ' ').slice(0, 16);

        const lines: string[] = [];
        lines.push(`P&L history (${snapshots.length} points)`);
        lines.push(
          `Start: $${first.totalValue.toFixed(2)} (${(first.totalPnlPct * 100).toFixed(1)}%) at ${formatStamp(
            first.createdAt
          )}`
        );
        lines.push(
          `Latest: $${last.totalValue.toFixed(2)} (${(last.totalPnlPct * 100).toFixed(1)}%) at ${formatStamp(
            last.createdAt
          )}`
        );
        lines.push(
          `Change: $${deltaValue.toFixed(2)} value, ${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(2)} P&L`
        );

        const display = snapshots.length > 10 ? snapshots.slice(-10) : snapshots;
        lines.push('', 'Latest snapshots:');
        for (const snap of display) {
          const pnlPrefix = snap.totalPnl >= 0 ? '+' : '';
          lines.push(
            `- ${formatStamp(snap.createdAt)}  $${snap.totalValue.toFixed(2)}  ${pnlPrefix}$${snap.totalPnl.toFixed(
              2
            )} (${(snap.totalPnlPct * 100).toFixed(1)}%)`
          );
        }

        return lines.join('\n');
      },
    },
    // ==========================================================================
    // Trading Bot Commands
    // ==========================================================================
    {
      name: 'bot',
      description: 'Manage trading bots (start/stop/status/list)',
      usage: '/bot [start|stop|pause|resume|status] <strategy-id>',
      aliases: ['bots', 'strategy'],
      handler: async (args, ctx) => {
        // Get trading system from context if available
        const trading = (ctx as any).trading;
        if (!trading?.bots) {
          return 'Trading system not initialized. Configure trading in clodds.json.';
        }

        const parts = args.trim().split(/\s+/).filter(Boolean);
        const subcommand = parts[0]?.toLowerCase() || 'list';
        const strategyId = parts[1];

        switch (subcommand) {
          case 'list': {
            const statuses = trading.bots.getAllBotStatuses();
            if (statuses.length === 0) {
              return [
                'Trading Bots',
                'No strategies registered.',
                '',
                'Register strategies programmatically:',
                '  trading.bots.registerStrategy(createMeanReversionStrategy())',
              ].join('\n');
            }

            const lines = ['Trading Bots', ''];
            for (const status of statuses) {
              const statusEmoji =
                status.status === 'running' ? '🟢' :
                status.status === 'paused' ? '🟡' :
                status.status === 'error' ? '🔴' : '⚪';
              lines.push(`${statusEmoji} ${status.name} (${status.id})`);
              lines.push(`   Status: ${status.status}`);
              lines.push(`   Trades: ${status.tradesCount} | Win rate: ${status.winRate.toFixed(1)}%`);
              lines.push(`   PnL: $${status.totalPnL.toFixed(2)}`);
            }
            return lines.join('\n');
          }

          case 'start': {
            if (!strategyId) {
              return 'Usage: /bot start <strategy-id>';
            }
            const started = await trading.bots.startBot(strategyId);
            return started
              ? `Bot ${strategyId} started successfully.`
              : `Failed to start bot ${strategyId}. Check if strategy is registered.`;
          }

          case 'stop': {
            if (!strategyId) {
              return 'Usage: /bot stop <strategy-id>';
            }
            await trading.bots.stopBot(strategyId);
            return `Bot ${strategyId} stopped.`;
          }

          case 'pause': {
            if (!strategyId) {
              return 'Usage: /bot pause <strategy-id>';
            }
            trading.bots.pauseBot(strategyId);
            return `Bot ${strategyId} paused.`;
          }

          case 'resume': {
            if (!strategyId) {
              return 'Usage: /bot resume <strategy-id>';
            }
            trading.bots.resumeBot(strategyId);
            return `Bot ${strategyId} resumed.`;
          }

          case 'status': {
            if (!strategyId) {
              return 'Usage: /bot status <strategy-id>';
            }
            const status = trading.bots.getBotStatus(strategyId);
            if (!status) {
              return `Strategy ${strategyId} not found.`;
            }

            const lines = [
              `Bot: ${status.name} (${status.id})`,
              '',
              `Status: ${status.status}`,
              `Started: ${status.startedAt?.toISOString() || 'never'}`,
              `Last check: ${status.lastCheck?.toISOString() || 'never'}`,
              '',
              'Performance:',
              `  Trades: ${status.tradesCount}`,
              `  Win rate: ${status.winRate.toFixed(1)}%`,
              `  Total PnL: $${status.totalPnL.toFixed(2)}`,
            ];

            if (status.lastSignal) {
              lines.push('', `Last signal: ${status.lastSignal.type} ${status.lastSignal.outcome}`);
              if (status.lastSignal.reason) {
                lines.push(`  Reason: ${status.lastSignal.reason}`);
              }
            }

            if (status.lastError) {
              lines.push('', `Last error: ${status.lastError}`);
            }

            return lines.join('\n');
          }

          default:
            return [
              'Usage: /bot [command] [strategy-id]',
              '',
              'Commands:',
              '  list     - Show all registered bots',
              '  start    - Start a bot',
              '  stop     - Stop a bot',
              '  pause    - Pause a running bot',
              '  resume   - Resume a paused bot',
              '  status   - Show detailed bot status',
            ].join('\n');
        }
      },
    },
    {
      name: 'trades',
      description: 'View trade history and stats',
      usage: '/trades [stats|export|recent] [platform] [limit=20]',
      handler: async (args, ctx) => {
        const trading = (ctx as any).trading;
        if (!trading?.logger) {
          return 'Trading system not initialized.';
        }

        const parts = args.trim().split(/\s+/).filter(Boolean);
        const subcommand = parts[0]?.toLowerCase() || 'recent';

        let platform: string | undefined;
        let limit = 20;

        for (const part of parts.slice(1)) {
          const lower = part.toLowerCase();
          if (lower.startsWith('limit=')) {
            limit = Math.min(100, parseInt(lower.slice(6), 10) || 20);
          } else if (isPlatformName(lower)) {
            platform = lower;
          }
        }

        switch (subcommand) {
          case 'stats': {
            const filter = platform ? { platform: platform as Platform } : {};
            const stats = trading.logger.getStats(filter);

            return [
              `Trade Statistics${platform ? ` (${platform})` : ''}`,
              '',
              `Total trades: ${stats.totalTrades}`,
              `Win rate: ${stats.winRate.toFixed(1)}%`,
              `Winning: ${stats.winningTrades} | Losing: ${stats.losingTrades}`,
              '',
              `Total PnL: $${stats.totalPnL.toFixed(2)}`,
              `Avg PnL: $${stats.avgPnL.toFixed(2)}`,
              `Avg Win: $${stats.avgWin.toFixed(2)} | Avg Loss: $${stats.avgLoss.toFixed(2)}`,
              `Largest win: $${stats.largestWin.toFixed(2)}`,
              `Largest loss: $${stats.largestLoss.toFixed(2)}`,
              '',
              `Profit factor: ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}`,
              `Total volume: $${stats.totalVolume.toFixed(2)}`,
              `Total fees: $${stats.totalFees.toFixed(2)}`,
            ].join('\n');
          }

          case 'daily': {
            const dailyPnL = trading.logger.getDailyPnL(30);
            if (dailyPnL.length === 0) {
              return 'No daily PnL data yet.';
            }

            const lines = ['Daily PnL (last 30 days)', ''];
            for (const day of dailyPnL.slice(0, 14)) {
              const prefix = day.pnl >= 0 ? '+' : '';
              lines.push(`${day.date}: ${prefix}$${day.pnl.toFixed(2)} (${day.trades} trades)`);
            }
            return lines.join('\n');
          }

          case 'export': {
            const filter = platform ? { platform: platform as Platform } : {};
            const csv = trading.logger.exportCsv(filter);
            return `Exported ${csv.split('\n').length - 1} trades to CSV format.\n\n${csv.slice(0, 1000)}${csv.length > 1000 ? '\n...(truncated)' : ''}`;
          }

          case 'recent':
          default: {
            const filter: any = { limit };
            if (platform) filter.platform = platform;

            const trades = trading.logger.getTrades(filter);
            if (trades.length === 0) {
              return 'No trades recorded yet.';
            }

            const lines = [`Recent Trades (${trades.length})`, ''];
            for (const trade of trades.slice(0, 10)) {
              const pnlStr = trade.realizedPnL !== undefined
                ? ` PnL: ${trade.realizedPnL >= 0 ? '+' : ''}$${trade.realizedPnL.toFixed(2)}`
                : '';
              lines.push(`- ${trade.side.toUpperCase()} ${trade.outcome} @ ${trade.price.toFixed(2)}`);
              lines.push(`  ${trade.platform} | ${trade.status} | ${trade.filled}/${trade.size} shares${pnlStr}`);
            }

            if (trades.length > 10) {
              lines.push(`\n...and ${trades.length - 10} more.`);
            }

            return lines.join('\n');
          }
        }
      },
    },
  ];
}
