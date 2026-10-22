import { PersonalApiError } from './errors.js';

export function date(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PersonalApiError('Date must use YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PersonalApiError('Date must be a real calendar date.');
  }
  return value;
}

export function range(start: string, end: string, maxDays?: number): [string, string] {
  date(start);
  date(end);
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days < 1) throw new PersonalApiError('Start date must not follow end date.');
  if (maxDays !== undefined && days > maxDays) {
    throw new PersonalApiError(`Date range must contain at most ${maxDays} inclusive days.`);
  }
  return [start, end];
}

export function positiveId(value: number | string): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new PersonalApiError('Activity ID must be a positive safe integer, or an int64 decimal string.');
  }
  const result = String(value);
  if (!/^[1-9]\d*$/.test(result) || result.length > 19 || BigInt(result) > 9223372036854775807n) {
    throw new PersonalApiError('Activity ID must be a positive int64 integer.');
  }
  return result;
}

export function integer(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PersonalApiError(`${name} must be an integer between ${min} and ${max}.`);
  }
}
