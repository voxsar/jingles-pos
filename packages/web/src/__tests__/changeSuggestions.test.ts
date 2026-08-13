import { describe, expect, it } from 'vitest';
import {
  addCounts,
  countsTotal,
  formatDenominationBreakdown,
  makeChangeBreakdown,
  suggestChangeBreakdowns,
  subtractCounts,
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
    expect(makeChangeBreakdown(7, { values: [5] })).toBeNull();
    expect(formatDenominationBreakdown(makeChangeBreakdown(10, { values: [5] })!)).toBe('2x5');
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

describe('makeChangeBreakdown with a drawer supply', () => {
  it('never spends more of a note than the drawer holds', () => {
    // Greedy would take the single 100 and then be stuck; the right answer
    // ignores it entirely.
    const result = makeChangeBreakdown(450, { supply: { 100: 1, 50: 9 } });

    expect(formatDenominationBreakdown(result!)).toBe('1x100 + 7x50');
    expect(result!.pieceCount).toBe(8);
  });

  it('returns null when the drawer simply cannot make the amount', () => {
    expect(makeChangeBreakdown(450, { supply: { 1000: 5 } })).toBeNull();
    expect(makeChangeBreakdown(450, { supply: {} })).toBeNull();
  });

  it('still prefers the fewest pieces among the affordable answers', () => {
    const result = makeChangeBreakdown(450, { supply: { 100: 4, 50: 9, 20: 10, 10: 10 } });

    expect(formatDenominationBreakdown(result!)).toBe('4x100 + 1x50');
  });

  it('treats a missing or zero supply entry as none of that denomination', () => {
    const result = makeChangeBreakdown(100, { supply: { 100: 0, 50: 2 } });

    expect(formatDenominationBreakdown(result!)).toBe('2x50');
  });

  it('accepts a supply keyed by string, as it arrives over the wire', () => {
    const result = makeChangeBreakdown(150, { supply: { '100': 1, '50': 1 } });

    expect(formatDenominationBreakdown(result!)).toBe('1x100 + 1x50');
  });
});

describe('suggestChangeBreakdowns with a drawer supply', () => {
  it('only offers breakdowns the drawer can actually pay', () => {
    const suggestions = suggestChangeBreakdowns(450, 3, { 100: 4, 50: 1, 20: 2, 10: 1 });

    expect(suggestions.every((suggestion) => suggestion.payableFromDrawer)).toBe(true);
    expect(formatDenominationBreakdown(suggestions[0])).toBe('4x100 + 1x50');
  });

  it('falls back to the theoretical answer, marked, when the drawer is short', () => {
    const suggestions = suggestChangeBreakdowns(450, 3, { 5000: 2 });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((suggestion) => !suggestion.payableFromDrawer)).toBe(true);
    expect(formatDenominationBreakdown(suggestions[0])).toBe('4x100 + 1x50');
  });

  it('marks suggestions as unpayable when no drawer is known', () => {
    // Callers must not read this as "the drawer is short" — only as "unverified".
    expect(suggestChangeBreakdowns(450, 1).every((suggestion) => !suggestion.payableFromDrawer)).toBe(true);
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

  it('asks for the note that unblocks a drawer which cannot make the change', () => {
    // 450 owed back, but the drawer only has 500s. Asking for 50 more turns the
    // change into a single 500 the drawer can actually hand over.
    const [first] = suggestTenderTopUps(4550, 5000, 3, { 500: 4 });

    expect(first.askFor).toBe(50);
    expect(first.unblocksDrawer).toBe(true);
    expect(first.payableFromDrawer).toBe(true);
    expect(formatDenominationBreakdown(first.changeBreakdown)).toBe('1x500');
  });

  it('counts the notes the customer hands over as available for the change', () => {
    // The drawer has five 100s and no 50, so 450 cannot be paid. Asking for 50
    // makes the change 500, which the five 100s cover exactly.
    const [first] = suggestTenderTopUps(4550, 5000, 3, { 100: 5 });

    expect(first.askFor).toBe(50);
    expect(first.unblocksDrawer).toBe(true);
    expect(formatDenominationBreakdown(first.changeBreakdown)).toBe('5x100');
  });

  it('cannot unblock an empty drawer, because the ask is always smaller than the change', () => {
    const suggestions = suggestTenderTopUps(4550, 5000, 3, {});

    expect(suggestions.every((suggestion) => !suggestion.unblocksDrawer)).toBe(true);
    expect(suggestions.every((suggestion) => !suggestion.payableFromDrawer)).toBe(true);
  });

  it('ranks an unblocking ask above one that merely tidies the change', () => {
    const suggestions = suggestTenderTopUps(4550, 5000, 5, { 500: 4 });
    const unblocking = suggestions.map((suggestion) => suggestion.unblocksDrawer);

    expect(unblocking).toEqual([...unblocking].sort((left, right) => Number(right) - Number(left)));
  });

  it('leaves the drawer flags false when no drawer is known', () => {
    for (const suggestion of suggestTenderTopUps(4550, 5000, 3)) {
      expect(suggestion.unblocksDrawer).toBe(false);
      expect(suggestion.payableFromDrawer).toBe(false);
    }
  });
});

describe('drawer count arithmetic', () => {
  it('adds and subtracts denomination maps without going negative', () => {
    expect(addCounts({ 100: 2 }, { 100: 3, 50: 1 })).toEqual({ 100: 5, 50: 1 });
    expect(subtractCounts({ 100: 5, 50: 1 }, { 100: 2 })).toEqual({ 100: 3, 50: 1 });
    // Taking more than is held clears the entry rather than recording a debt.
    expect(subtractCounts({ 100: 1 }, { 100: 4 })).toEqual({});
  });

  it('ignores zero and non-numeric entries', () => {
    expect(addCounts({ 100: 0 }, { 50: Number.NaN })).toEqual({});
  });

  it('values a denomination map', () => {
    expect(countsTotal({ 1000: 2, 100: 3, 5: 1 })).toBe(2_305);
    expect(countsTotal({})).toBe(0);
  });
});
