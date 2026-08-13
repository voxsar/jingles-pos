import { describe, expect, it } from 'vitest';
import {
  formatDenominationBreakdown,
  makeChangeBreakdown,
  suggestChangeBreakdowns,
  suggestTenderTopUps,
} from '../utils/pos';

const asText = (amount: number, limit?: number) =>
  suggestChangeBreakdowns(amount, limit).map(formatDenominationBreakdown);

describe('makeChangeBreakdown', () => {
  it('uses the fewest pieces that make the amount', () => {
    expect(formatDenominationBreakdown(makeChangeBreakdown(450)!)).toBe('4x100 + 1x50');
    expect(formatDenominationBreakdown(makeChangeBreakdown(4550)!)).toBe('2x2000 + 1x500 + 1x50');
    expect(makeChangeBreakdown(450)!.pieceCount).toBe(5);
  });

  it('returns an empty breakdown for zero and rejects negatives', () => {
    expect(makeChangeBreakdown(0)).toEqual({ counts: {}, pieceCount: 0 });
    expect(makeChangeBreakdown(-10)).toBeNull();
  });

  it('rejects an amount the denominations cannot make exactly', () => {
    // Fractional rupees have no coin, so there is no honest breakdown for them.
    expect(makeChangeBreakdown(10.5)).toBeNull();
  });

  it('reports null rather than guessing when the available set cannot reach the amount', () => {
    expect(makeChangeBreakdown(7, [5])).toBeNull();
    expect(formatDenominationBreakdown(makeChangeBreakdown(10, [5])!)).toBe('2x5');
  });
});

describe('suggestChangeBreakdowns', () => {
  it('offers the worked example: 450 as notes, then without the fifty', () => {
    expect(asText(450, 3)).toEqual([
      '4x100 + 1x50',
      '4x100 + 2x20 + 1x10',
      '4x100 + 2x20 + 2x5',
    ]);
  });

  it('keeps the large notes and only rebuilds the small remainder', () => {
    // Dropping the smallest denomination is what happens at a till when the
    // drawer runs out of change; dropping the largest would answer with 9x50.
    for (const option of asText(450, 3)) {
      expect(option.startsWith('4x100')).toBe(true);
    }
  });

  it('never suggests a breakdown no cashier would count out', () => {
    for (const suggestion of suggestChangeBreakdowns(450, 5)) {
      expect(suggestion.pieceCount).toBeLessThanOrEqual(12);
    }
  });

  it('returns a single option when the amount can only be made one way', () => {
    expect(asText(3, 3)).toEqual(['1x2 + 1x1']);
  });

  it('returns nothing for a zero or negative change amount', () => {
    expect(suggestChangeBreakdowns(0)).toEqual([]);
    expect(suggestChangeBreakdowns(-50)).toEqual([]);
  });
});

describe('suggestTenderTopUps', () => {
  it('spots the classic ask: another 50 turns 450 change into a single 500', () => {
    const [first] = suggestTenderTopUps(4550, 5000, 3);

    expect(first.askFor).toBe(50);
    expect(formatDenominationBreakdown(first.askBreakdown)).toBe('1x50');
    expect(first.changeAmount).toBe(500);
    expect(formatDenominationBreakdown(first.changeBreakdown)).toBe('1x500');
    expect(first.piecesSaved).toBe(4);
  });

  it('finds a two-piece ask when no single note works', () => {
    // 1,230 paid with 2,000 leaves 770; asking for 30 more makes it 800.
    const [first] = suggestTenderTopUps(1230, 2000, 3);

    expect(first.askFor).toBe(30);
    expect(formatDenominationBreakdown(first.askBreakdown)).toBe('1x20 + 1x10');
    expect(formatDenominationBreakdown(first.changeBreakdown)).toBe('1x500 + 3x100');
  });

  it('only asks for round amounts a cashier would actually say out loud', () => {
    for (const suggestion of suggestTenderTopUps(4550, 5000, 5)) {
      expect(suggestion.askFor % 5).toBe(0);
      expect(suggestion.askBreakdown.pieceCount).toBeLessThanOrEqual(2);
    }
  });

  it('ranks by how much simpler the change gets', () => {
    const suggestions = suggestTenderTopUps(4550, 5000, 5);
    const saved = suggestions.map((suggestion) => suggestion.piecesSaved);

    expect(saved).toEqual([...saved].sort((left, right) => right - left));
    expect(suggestions.every((suggestion) => suggestion.piecesSaved > 0)).toBe(true);
  });

  it('stays quiet when the change is already as simple as it gets', () => {
    // 10 back is one coin; nothing to improve on.
    expect(suggestTenderTopUps(4990, 5000, 3)).toEqual([]);
    // 220 back cannot be simplified by any round ask.
    expect(suggestTenderTopUps(780, 1000, 3)).toEqual([]);
  });

  it('stays quiet when there is no change to give', () => {
    expect(suggestTenderTopUps(1000, 1000, 3)).toEqual([]);
    expect(suggestTenderTopUps(1000, 800, 3)).toEqual([]);
  });

  it('never asks for more than the change being handed back on a large bill', () => {
    for (const suggestion of suggestTenderTopUps(2340, 5000, 5)) {
      expect(suggestion.askFor).toBeLessThanOrEqual(5000 - 2340);
    }
  });
});
