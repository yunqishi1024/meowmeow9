// Cross-conversation search utility.
// The UI and built-in model tool share this so results stay consistent.

import type { ContentBlock } from "../providers";
import type { Conversation } from "./storage";

export interface SearchResult {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  messageRole: "user" | "assistant";
  messageIndex: number;
  matchText: string; // snippet containing the match
  createdAt: number;
}

/**
 * Extract plain text from ContentBlock[] for search purposes.
 */
function contentBlocksToSearchText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.text;
      if (block.type === "voice") return block.text;
      if (block.type === "tool") return [block.input, block.output].filter(Boolean).join(" ");
      if (block.type === "attachment") {
        return [block.attachment.name, block.attachment.text, block.attachment.error]
          .filter(Boolean)
          .join(" ");
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function queryTokens(query: string): string[] {
  return normalizeSearchText(query)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchIndexForQuery(text: string, query: string): number {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return -1;

  const phraseIndex = normalizedText.indexOf(normalizedQuery);
  if (phraseIndex !== -1) return phraseIndex;

  const tokens = queryTokens(query);
  if (tokens.length === 0) return -1;
  const tokenIndexes = tokens.map((token) => normalizedText.indexOf(token));
  if (tokenIndexes.some((index) => index === -1)) return -1;
  return Math.min(...tokenIndexes);
}

/**
 * Create a snippet around the match position.
 */
function createSnippet(text: string, matchIndex: number, snippetLength = 120): string {
  const halfLen = Math.floor(snippetLength / 2);
  const start = Math.max(0, matchIndex - halfLen);
  const end = Math.min(text.length, matchIndex + halfLen);

  let snippet = text.slice(start, end).replace(/\s+/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

/**
 * Search all conversations for a query string.
 * Returns matching results sorted by relevance (most recent first).
 */
export function searchConversations(
  conversations: Conversation[],
  query: string,
  maxResults = 50,
): SearchResult[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const results: SearchResult[] = [];

  for (const conversation of conversations) {
    for (const [messageIndex, message] of conversation.messages.entries()) {
      const text = contentBlocksToSearchText(message.content);
      const matchIndex = matchIndexForQuery(text, trimmed);

      if (matchIndex !== -1) {
        results.push({
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          messageId: message.id,
          messageRole: message.role,
          messageIndex,
          matchText: createSnippet(text, matchIndex),
          createdAt: message.createdAt ?? conversation.updatedAt,
        });
      }
    }
  }

  // Sort by most recent first
  results.sort((a, b) => b.createdAt - a.createdAt);
  return results.slice(0, maxResults);
}

/**
 * Search conversation titles only (for quick filtering).
 */
export function searchConversationTitles(
  conversations: Conversation[],
  query: string,
): Conversation[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return conversations;

  return conversations.filter(
    (c) => matchIndexForQuery(c.title, trimmed) !== -1,
  );
}
