export interface ChatModel {
  id: string;
  name: string;
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
}

export type ChatEvent = { delta: string } | { turn: ChatTurn };
