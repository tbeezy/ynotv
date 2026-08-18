import { describe, it, expect } from 'vitest';
import { getProgramStyle } from '../ProgramBlock';
import type { StoredProgram } from '../../db';

describe('ProgramBlock getProgramStyle', () => {
  const windowStart = new Date('2026-08-18T09:00:00.000Z');
  const windowEnd = new Date('2026-08-18T13:00:00.000Z');
  const pixelsPerHour = 200;

  const createProgram = (startIso: string, endIso: string, title = 'Test Program'): StoredProgram => ({
    id: 'prog1',
    stream_id: 'channel1',
    title,
    description: '',
    start: new Date(startIso),
    end: new Date(endIso),
    source_id: 'source1',
  });

  it('hides a program that ended right at the window start (09:00:00)', () => {
    const prog = createProgram('2026-08-18T08:30:00.000Z', '2026-08-18T09:00:00.000Z');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(false);
  });

  it('hides a program from earlier timeslot with slight timestamp jitter (ends at 09:00:01)', () => {
    const prog = createProgram('2026-08-18T08:30:00.000Z', '2026-08-18T09:00:01.000Z');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(false);
  });

  it('hides a program from earlier timeslot ending within 1 minute of window start (e.g. 09:00:30)', () => {
    const prog = createProgram('2026-08-18T08:00:00.000Z', '2026-08-18T09:00:30.000Z');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(false);
  });

  it('correctly displays and positions a program starting at 09:00:00', () => {
    const prog = createProgram('2026-08-18T09:00:00.000Z', '2026-08-18T09:30:00.000Z', 'Storage Wars');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(true);
    expect(style.left).toBe(0);
    // 30 mins at 200 pph is 100px - 2px gap = 98px
    expect(style.width).toBe(98);
  });

  it('correctly clamps and displays a multi-hour program spanning across window start', () => {
    // 07:31:00 to 11:00:00 (like The Aging Brain in screenshot)
    const prog = createProgram('2026-08-18T07:31:00.000Z', '2026-08-18T11:00:00.000Z', 'The Aging Brain');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(true);
    expect(style.left).toBe(0);
    // 2 hours visible (09:00 to 11:00) at 200 pph = 400px - 2px gap = 398px
    expect(style.width).toBe(398);
  });

  it('correctly displays a program starting inside the window and spanning past window end', () => {
    const prog = createProgram('2026-08-18T12:00:00.000Z', '2026-08-18T14:00:00.000Z');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(true);
    // starts 3 hours from 09:00 -> 3 * 200 = 600px
    expect(style.left).toBe(600);
    // 1 hour visible (12:00 to 13:00) -> 200px - 2px gap = 198px
    expect(style.width).toBe(198);
  });

  it('hides a program entirely outside the window in future', () => {
    const prog = createProgram('2026-08-18T13:00:00.000Z', '2026-08-18T14:00:00.000Z');
    const style = getProgramStyle(prog, windowStart, windowEnd, pixelsPerHour);
    expect(style.visible).toBe(false);
  });
});
