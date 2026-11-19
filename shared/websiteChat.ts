export interface ChatModel {
  id: string;
  name: string;
  imageInput?: boolean;
}

export const chatAttachmentLimit = 3;
export const chatAttachmentMaxBytes = 4 * 1024 * 1024;
export const chatAttachmentAccept = '.png,.jpg,.jpeg,.webp,.pdf,.docx';
export const chatImageExtension = /\.(png|jpe?g|webp)$/i;

export interface ChatAttachment {
  name: string;
  kind: 'image' | 'document';
}

export interface ChatConversation {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ChatTurn {
  id: string;
  model: string;
  question: string;
  answer: string;
  status: 'running' | 'complete' | 'failed' | 'review';
  error: string | null;
  attachments?: ChatAttachment[];
}

export type ChatEvent = { delta: string } | { turn: ChatTurn };
