/**
 * Attachment helpers for resolving media content.
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { MessageAttachment } from '../types';

export interface ResolvedAttachment {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}

function safeBasename(value: string): string {
  try {
    return path.basename(value.split('?')[0].split('#')[0]);
  } catch {
    return '';
  }
}

function guessFilename(attachment: MessageAttachment): string {
  if (attachment.filename) return attachment.filename;
  if (attachment.url) {
    const name = safeBasename(attachment.url);
    if (name) return name;
  }

  const ext = attachment.mimeType?.split('/')[1];
  const suffix = ext ? `.${ext}` : '';
  return `attachment-${crypto.randomBytes(4).toString('hex')}${suffix}`;
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function stripFileScheme(value: string): string {
  return value.replace(/^file:\/\//i, '');
}

async function resolveAttachmentInternal(
  attachment: MessageAttachment,
  headers?: Record<string, string>
): Promise<ResolvedAttachment | null> {
  if (attachment.data) {
    const buffer = Buffer.from(attachment.data, 'base64');
    return {
      buffer,
      filename: guessFilename(attachment),
      mimeType: attachment.mimeType,
    };
  }

  if (attachment.url) {
    if (isRemoteUrl(attachment.url)) {
      const autoHeaders: Record<string, string> = {};
      if (!headers && /slack\.com/i.test(attachment.url) && process.env.SLACK_BOT_TOKEN) {
        autoHeaders.Authorization = `Bearer ${process.env.SLACK_BOT_TOKEN}`;
      }
      const finalHeaders = headers || (Object.keys(autoHeaders).length > 0 ? autoHeaders : undefined);
      const response = await fetch(attachment.url, finalHeaders ? { headers: finalHeaders } : undefined);
      if (!response.ok) {
        throw new Error(`Failed to fetch attachment: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        filename: guessFilename(attachment),
        mimeType: attachment.mimeType || response.headers.get('content-type') || undefined,
      };
    }

    const filePath = stripFileScheme(attachment.url);
    const buffer = await fs.readFile(filePath);
    return {
      buffer,
      filename: guessFilename(attachment),
      mimeType: attachment.mimeType,
    };
  }

  return null;
}

export async function resolveAttachment(
  attachment: MessageAttachment
): Promise<ResolvedAttachment | null> {
  return resolveAttachmentInternal(attachment);
}

export async function resolveAttachmentWithHeaders(
  attachment: MessageAttachment,
  headers: Record<string, string>
): Promise<ResolvedAttachment | null> {
  return resolveAttachmentInternal(attachment, headers);
}

export function guessAttachmentType(mimeType?: string, filename?: string): MessageAttachment['type'] {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
  }

  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'].includes(ext)) return 'image';
    if (['.mp4', '.mov', '.mkv', '.webm'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.m4a', '.ogg', '.opus'].includes(ext)) return 'audio';
  }

  return 'document';
}
