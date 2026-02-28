import { describe, it, expect } from 'vitest';
import { renderMarkdown, MarkdownStreamRenderer, ANSI } from '../../src/context/markdown-renderer.js';

// ─── ATX Headings ─────────────────────────────────────────────────────────────

describe('ATX headings', () => {
  for (let level = 1; level <= 6; level++) {
    it(`renders h${level} as bold without '#' prefix`, () => {
      const hashes = '#'.repeat(level);
      const output = renderMarkdown(`${hashes} Hello World`, { ansi: true });
      expect(output).toContain(ANSI.BOLD);
      expect(output).toContain('Hello World');
      expect(output).not.toContain('#');
    });
  }

  it('heading text is wrapped with BOLD and RESET', () => {
    const output = renderMarkdown('# Title', { ansi: true });
    expect(output).toContain(`${ANSI.BOLD}`);
    expect(output).toContain(ANSI.RESET);
  });

  it('heading with ansi:false strips # and outputs plain text', () => {
    const output = renderMarkdown('## Section', { ansi: false });
    expect(output).not.toContain('#');
    expect(output).toContain('Section');
    expect(output).not.toContain('\x1b[');
  });
});

// ─── Bold ─────────────────────────────────────────────────────────────────────

describe('Bold formatting', () => {
  it('renders **text** with ANSI bold', () => {
    const output = renderMarkdown('This is **bold** text', { ansi: true });
    expect(output).toContain(ANSI.BOLD);
    expect(output).toContain('bold');
    expect(output).toContain(ANSI.RESET);
  });

  it('renders __text__ with ANSI bold', () => {
    const output = renderMarkdown('This is __bold__ text', { ansi: true });
    expect(output).toContain(ANSI.BOLD);
    expect(output).toContain('bold');
    expect(output).toContain(ANSI.RESET);
  });

  it('renders multiple bold spans in one line', () => {
    const output = renderMarkdown('**a** and **b**', { ansi: true });
    const boldCount = (output.match(/\x1b\[1m/g) ?? []).length;
    expect(boldCount).toBeGreaterThanOrEqual(2);
  });

  it('bold with ansi:false strips markers and keeps text', () => {
    const output = renderMarkdown('**bold**', { ansi: false });
    expect(output).toContain('bold');
    expect(output).not.toContain('*');
    expect(output).not.toContain('\x1b[');
  });
});

// ─── Unordered Lists ──────────────────────────────────────────────────────────

describe('Unordered list items', () => {
  it('renders "- item" with "  •" prefix', () => {
    const output = renderMarkdown('- apple', { ansi: true });
    expect(output).toContain('  \u2022 apple');
  });

  it('renders "* item" with "  •" prefix', () => {
    const output = renderMarkdown('* banana', { ansi: true });
    expect(output).toContain('  \u2022 banana');
  });

  it('does not include the original "- " marker in output', () => {
    const output = renderMarkdown('- item', { ansi: true });
    expect(output).not.toMatch(/^- /m);
  });

  it('renders multiple list items each with bullet', () => {
    const output = renderMarkdown('- one\n- two\n- three', { ansi: true });
    const bullets = (output.match(/  •/g) ?? []).length;
    expect(bullets).toBe(3);
  });
});

// ─── Ordered Lists ────────────────────────────────────────────────────────────

describe('Ordered list items', () => {
  it('renders "1. item" with two-space indent preserving number', () => {
    const output = renderMarkdown('1. first', { ansi: true });
    expect(output).toContain('  1. first');
  });

  it('renders "2. item" with two-space indent preserving number', () => {
    const output = renderMarkdown('2. second', { ansi: true });
    expect(output).toContain('  2. second');
  });

  it('preserves original numbering for multi-item list', () => {
    const output = renderMarkdown('1. one\n2. two\n3. three', { ansi: true });
    expect(output).toContain('  1. one');
    expect(output).toContain('  2. two');
    expect(output).toContain('  3. three');
  });
});

// ─── Fenced Code Blocks ───────────────────────────────────────────────────────

describe('Fenced code blocks with language identifier', () => {
  it('applies syntax highlighting for typescript', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const output = renderMarkdown(md, { ansi: true });
    // Should contain some ANSI color sequence (keyword or other highlighting)
    expect(output).toMatch(/\x1b\[\d+m/);
  });

  it('applies syntax highlighting for javascript', () => {
    const md = '```javascript\nfunction foo() {}\n```';
    const output = renderMarkdown(md, { ansi: true });
    expect(output).toMatch(/\x1b\[\d+m/);
  });

  it('applies syntax highlighting for python', () => {
    const md = '```python\ndef foo():\n    pass\n```';
    const output = renderMarkdown(md, { ansi: true });
    expect(output).toMatch(/\x1b\[\d+m/);
  });

  it('applies syntax highlighting for bash', () => {
    const md = '```bash\nif true; then echo hi; fi\n```';
    const output = renderMarkdown(md, { ansi: true });
    expect(output).toMatch(/\x1b\[\d+m/);
  });

  it('applies syntax highlighting for json', () => {
    const md = '```json\n{"key": "value"}\n```';
    const output = renderMarkdown(md, { ansi: true });
    // JSON keys are highlighted in FG_CYAN
    expect(output).toContain(ANSI.FG_CYAN);
  });

  it('preserves code content within the block', () => {
    const md = '```typescript\nconst x = 42;\n```';
    const output = renderMarkdown(md, { ansi: true });
    expect(output).toContain('x');
    expect(output).toContain('42');
  });
});

describe('Fenced code blocks without language identifier', () => {
  it('renders plain content without language-specific highlighting', () => {
    const md = '```\nsome plain code\n```';
    const output = renderMarkdown(md, { ansi: true });
    expect(output).toContain('some plain code');
  });

  it('does not apply keyword coloring for unlabeled block', () => {
    // "const" should not be colored blue since no language is specified
    const md = '```\nconst x = 1;\n```';
    const output = renderMarkdown(md, { ansi: true });
    // The code line itself should not contain ANSI sequences (no lang = no highlight)
    const lines = output.split('\n');
    const codeLine = lines.find(l => l.includes('const'));
    expect(codeLine).toBeDefined();
    expect(codeLine).not.toMatch(/\x1b\[\d+m/);
  });

  it('still outputs the fence delimiters', () => {
    const md = '```\ncode\n```';
    const output = renderMarkdown(md, { ansi: true });
    const fenceCount = (output.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });
});

// ─── Inline Code ──────────────────────────────────────────────────────────────

describe('Inline code', () => {
  it('renders `code` with FG_CYAN', () => {
    const output = renderMarkdown('Use `foo()` here', { ansi: true });
    expect(output).toContain(ANSI.FG_CYAN);
    expect(output).toContain('foo()');
  });

  it('inline code is followed by RESET', () => {
    const output = renderMarkdown('Use `bar` here', { ansi: true });
    const cyanIdx = output.indexOf(ANSI.FG_CYAN);
    const resetIdx = output.indexOf(ANSI.RESET, cyanIdx);
    expect(cyanIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(cyanIdx);
  });

  it('inline code with ansi:false strips backticks and keeps text', () => {
    const output = renderMarkdown('Use `foo` here', { ansi: false });
    expect(output).toContain('foo');
    expect(output).not.toContain('`');
    expect(output).not.toContain('\x1b[');
  });
});

// ─── Non-TTY (ansi: false) ────────────────────────────────────────────────────

describe('Non-TTY output (ansi: false)', () => {
  it('produces no ANSI escape sequences for headings', () => {
    const output = renderMarkdown('# Heading', { ansi: false });
    expect(output).not.toContain('\x1b[');
  });

  it('produces no ANSI escape sequences for bold text', () => {
    const output = renderMarkdown('**bold**', { ansi: false });
    expect(output).not.toContain('\x1b[');
  });

  it('produces no ANSI escape sequences for inline code', () => {
    const output = renderMarkdown('`code`', { ansi: false });
    expect(output).not.toContain('\x1b[');
  });

  it('produces no ANSI escape sequences for code blocks with language', () => {
    const output = renderMarkdown('```typescript\nconst x = 1;\n```', { ansi: false });
    expect(output).not.toContain('\x1b[');
  });

  it('still renders text content correctly without ANSI', () => {
    const md = '# Title\n**bold**\n- item\n`code`';
    const output = renderMarkdown(md, { ansi: false });
    expect(output).toContain('Title');
    expect(output).toContain('bold');
    expect(output).toContain('item');
    expect(output).toContain('code');
  });
});

// ─── MarkdownStreamRenderer.flush() ──────────────────────────────────────────

describe('MarkdownStreamRenderer flush()', () => {
  it('closes an unclosed code block when flush() is called', () => {
    const renderer = new MarkdownStreamRenderer({ ansi: true });
    renderer.push('```typescript\n');
    const flushed = renderer.flush();
    // flush() should close the block with a closing fence
    expect(flushed).toContain('```');
  });

  it('returns empty string when no buffered content and no open code block', () => {
    const renderer = new MarkdownStreamRenderer({ ansi: true });
    renderer.push('hello\n');
    const flushed = renderer.flush();
    expect(flushed).toBe('');
  });

  it('flushes remaining line buffer content', () => {
    const renderer = new MarkdownStreamRenderer({ ansi: true });
    // Push text without trailing newline — stays in buffer
    renderer.push('partial line');
    const flushed = renderer.flush();
    expect(flushed).toContain('partial line');
  });

  it('reset() clears state so subsequent push works cleanly', () => {
    const renderer = new MarkdownStreamRenderer({ ansi: true });
    renderer.push('```typescript\n');
    renderer.flush();
    renderer.reset();
    // After reset, pushing a heading should work normally
    const out = renderer.push('# Fresh Start\n');
    expect(out).toContain('Fresh Start');
    expect(out).not.toContain('```');
  });

  it('flush() after complete code block returns empty (block already closed)', () => {
    const renderer = new MarkdownStreamRenderer({ ansi: true });
    renderer.push('```typescript\nconst x = 1;\n```\n');
    const flushed = renderer.flush();
    // No unclosed block, no buffered content
    expect(flushed).toBe('');
  });
});
