import { describe, expect, it } from 'vitest';
import { parseWordTimestamps } from './utils';

const frame = {
  word_timestamps: [
    {
      word: 'twelve',
      start_ms: 0,
      end_ms: 300,
      char_start: 6,
      char_end: 12,
      original_char_start: 6,
      original_char_end: 12,
      score: 1.0,
    },
  ],
  chunk_id: 0,
  text: 'About twelve thousand visitors.',
  original_text: 'About 12,000 visitors.',
};

describe('parseWordTimestamps', () => {
  it('carries original offsets and the frame texts', () => {
    const [ts] = parseWordTimestamps(frame);
    expect(ts.originalCharStart).toBe(6);
    expect(ts.originalCharEnd).toBe(12);
    expect(ts.text).toBe('About twelve thousand visitors.');
    expect(ts.originalText).toBe('About 12,000 visitors.');
    expect(ts.originalText!.slice(ts.originalCharStart, ts.originalCharEnd)).toBe('12,000');
    expect(ts.charStart).toBe(6);
  });

  it('leaves the new fields undefined when the server omits them', () => {
    const [ts] = parseWordTimestamps({
      word_timestamps: [{ word: 'Hi', start_ms: 0, end_ms: 50, char_start: 0, char_end: 2 }],
    });
    expect(ts.originalCharStart).toBeUndefined();
    expect(ts.originalCharEnd).toBeUndefined();
    expect(ts.text).toBeUndefined();
    expect(ts.originalText).toBeUndefined();
    expect(ts.score).toBe(1.0);
  });

  it('offsets count code points: slice with Array.from after an emoji', () => {
    const [ts] = parseWordTimestamps({
      word_timestamps: [
        {
          word: 'twelve',
          start_ms: 0,
          end_ms: 300,
          char_start: 2,
          char_end: 8,
          original_char_start: 2,
          original_char_end: 8,
        },
      ],
      text: '\u{1F600} twelve visitors.',
      original_text: '\u{1F600} 12,000 visitors.',
    });
    const points = Array.from(ts.originalText!);
    expect(points.slice(ts.originalCharStart, ts.originalCharEnd).join('')).toBe('12,000');
  });
});
