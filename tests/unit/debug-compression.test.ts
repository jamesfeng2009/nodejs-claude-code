import { describe, it } from 'vitest';
import { ConversationManager } from '../../src/conversation/manager.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type { Message } from '../../src/types/messages.js';

function makeMessage(role: Message['role'], content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('debug compression', () => {
  it('traces compression with AAA aa', async () => {
    const manager = new ConversationManager(
      { highWaterMark: 100, lowWaterMark: 50, maxContextTokens: 2000 },
      new KeyEntityCache(),
    );

    const filler = 'x'.repeat(80);
    for (let i = 0; i < 8; i++) {
      manager.addMessage(makeMessage(i % 2 === 0 ? 'user' : 'assistant', filler));
    }
    manager.addMessage(makeMessage('user', 'AAA aa'));
    manager.addMessage(makeMessage('assistant', 'response to last'));

    console.log('Before compression:', manager.getTokenCount(), 'tokens');
    await manager.compressIfNeeded();
    const msgs = manager.getMessages();
    console.log('After compression:', manager.getTokenCount(), 'tokens');
    console.log('Messages count:', msgs.length);
    msgs.forEach((m, i) => console.log(i, m.role, JSON.stringify(m.content.slice(0, 80))));
    const hasLastUser = msgs.some((m) => m.role === 'user' && m.content === 'AAA aa');
    console.log('Has last user:', hasLastUser);
  });
});
