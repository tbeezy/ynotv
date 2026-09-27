import { describe, it, expect } from 'vitest';
import { getCurrentProgramInfo } from '../ChannelRow';
import type { StoredProgram } from '../../db';

describe('ChannelRow getCurrentProgramInfo', () => {
  const prog1: StoredProgram = {
    id: 'p1',
    stream_id: 'ch1',
    title: 'Morning News',
    description: 'News updates',
    start: new Date('2026-09-27T10:00:00.000Z'),
    end: new Date('2026-09-27T11:00:00.000Z'),
    source_id: 'src1',
  };

  const prog2: StoredProgram = {
    id: 'p2',
    stream_id: 'ch1',
    title: 'Afternoon Movie',
    description: 'A great movie',
    start: new Date('2026-09-27T11:00:00.000Z'),
    end: new Date('2026-09-27T13:00:00.000Z'),
    source_id: 'src1',
  };

  const programs = [prog1, prog2];

  it('returns null for empty programs list', () => {
    expect(getCurrentProgramInfo([])).toBeNull();
  });

  it('returns null when current time is before any program starts', () => {
    const beforeStart = new Date('2026-09-27T09:30:00.000Z').getTime();
    expect(getCurrentProgramInfo(programs, beforeStart)).toBeNull();
  });

  it('returns null when current time is after all programs end', () => {
    const afterEnd = new Date('2026-09-27T13:30:00.000Z').getTime();
    expect(getCurrentProgramInfo(programs, afterEnd)).toBeNull();
  });

  it('correctly calculates progress at the start of a program (0%)', () => {
    const startMs = new Date('2026-09-27T10:00:00.000Z').getTime();
    const info = getCurrentProgramInfo(programs, startMs);
    expect(info).not.toBeNull();
    expect(info?.program.title).toBe('Morning News');
    expect(info?.pct).toBe(0);
  });

  it('correctly calculates progress halfway through a program (50%)', () => {
    const halfwayMs = new Date('2026-09-27T10:30:00.000Z').getTime();
    const info = getCurrentProgramInfo(programs, halfwayMs);
    expect(info).not.toBeNull();
    expect(info?.program.title).toBe('Morning News');
    expect(info?.pct).toBe(50);
  });

  it('correctly calculates progress advancing over time (e.g. 75%)', () => {
    const threeQuarterMs = new Date('2026-09-27T10:45:00.000Z').getTime();
    const info = getCurrentProgramInfo(programs, threeQuarterMs);
    expect(info).not.toBeNull();
    expect(info?.program.title).toBe('Morning News');
    expect(info?.pct).toBe(75);
  });

  it('advances automatically to the next program when time rolls over (11:00:00)', () => {
    const rolloverMs = new Date('2026-09-27T11:00:00.000Z').getTime();
    const info = getCurrentProgramInfo(programs, rolloverMs);
    expect(info).not.toBeNull();
    expect(info?.program.title).toBe('Afternoon Movie');
    expect(info?.pct).toBe(0);
  });

  it('calculates progress percentage in the second program as time advances', () => {
    // 30 mins into a 2-hour (120 min) movie -> 25%
    const movieQuarterMs = new Date('2026-09-27T11:30:00.000Z').getTime();
    const info = getCurrentProgramInfo(programs, movieQuarterMs);
    expect(info).not.toBeNull();
    expect(info?.program.title).toBe('Afternoon Movie');
    expect(info?.pct).toBe(25);
  });

  it('handles programs with string dates correctly', () => {
    const stringDateProg: StoredProgram = {
      id: 'p3',
      stream_id: 'ch1',
      title: 'String Date Show',
      description: '',
      start: '2026-09-27T14:00:00.000Z' as any,
      end: '2026-09-27T15:00:00.000Z' as any,
      source_id: 'src1',
    };
    const halfwayMs = new Date('2026-09-27T14:30:00.000Z').getTime();
    const info = getCurrentProgramInfo([stringDateProg], halfwayMs);
    expect(info).not.toBeNull();
    expect(info?.pct).toBe(50);
  });
});
