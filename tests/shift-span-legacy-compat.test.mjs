import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, calendarDate, nextCalendarDate, shiftSpan, spansOverlap, spanCoveredByDates, moveCalendarDate, LAST_CALENDAR_DAY } from '../public/data/shift-span.js';
const same = (date, startTime, endTime) => shiftSpan({ date, startTime, endTime });
const explicit = (date, startTime, endDate, endTime) => shiftSpan({ date, startTime, endDate, endTime });
test('Gregorian arithmetic retains old year0000/9999, leap centuries and safe boundaries without local timezone arithmetic', () => {
  assert.equal(calendarDay('0000-01-01'), 0); assert.equal(calendarDay('9999-12-31'), LAST_CALENDAR_DAY);
  for (const date of ['0000-02-29', '0001-01-01', '1900-02-28', '2000-02-29', '2026-12-31', '2100-03-01', '9999-12-31']) assert.equal(calendarDate(calendarDay(date)), date);
  assert.equal(nextCalendarDate('2026-12-31'), '2027-01-01'); assert.equal(nextCalendarDate('2000-02-28'), '2000-02-29');
  for (const date of ['1900-02-29', '2100-02-29', '2026-02-30', '2026-10-10\n', '2026-10-10\r', '', null]) assert.throws(() => calendarDay(date));
  assert.throws(() => nextCalendarDate('9999-12-31')); assert.throws(() => calendarDate(-1));
});
test('old same-day ISO seconds/offset/0000 raw values keep original literal-minute semantics and own-presence byte-for-byte', () => {
  const item = { date: '0000-02-29', startTime: '0000-02-29T09:00:59+08:00', endTime: '0000-02-29T10:00:01-04:00' }, before = JSON.stringify(item), range = shiftSpan(item);
  assert.equal(range.durationMinutes, 60); assert.equal(range.hasEndDate, false); assert.equal(range.endDate, item.date); assert.equal(JSON.stringify(item), before); assert.equal(Object.hasOwn(item, 'endDate'), false);
  assert.throws(() => shiftSpan(item, { legacyWithoutEndDate: false }), { code: 'SPAN_TIME_INVALID' });
  assert.throws(() => same('2026-10-10', '09:00\n', '10:00\n'), { code: 'SPAN_TIME_INVALID' });
});
test('overnight requires an explicit next date; no clock-order inference, zero duration, reverse dates or third date', () => {
  const range = explicit('2026-10-10', '23:30', '2026-10-11', '01:15'); assert.equal(range.durationMinutes, 105); assert.deepEqual(range.segments.map(s => s.minutes), [30, 75]); assert.equal(range.lastOccupiedDate, '2026-10-11');
  assert.throws(() => same('2026-10-10', '23:30', '01:15'), { code: 'SPAN_TIME_RANGE' });
  for (const args of [['2026-10-10','09:00','2026-10-10','09:00'], ['2026-10-10','09:00','2026-10-09','10:00'], ['2026-10-10','09:00','2026-10-12','10:00']]) assert.throws(() => explicit(...args));
  for (const time of ['24:00','09:00\n','09:00\r','2026-10-10T09:00:00Z',null]) assert.throws(() => explicit('2026-10-10',time,'2026-10-11','01:00'), { code: 'SPAN_TIME_INVALID' });
});
test('two-date technical bound does not fabricate a legal maximum or reject next-day end later than clock start', () => {
  assert.equal(explicit('2026-10-10','00:00','2026-10-11','23:59').durationMinutes, 2879);
  assert.equal(explicit('2026-10-10','09:00','2026-10-11','10:00').durationMinutes, 1500);
});
test('half-open midnight boundary occupies only positive-minute dates; plan/service validity may test exact occupied dates', () => {
  const range = explicit('2026-10-10','23:00','2026-10-11','00:00'); assert.equal(range.durationMinutes, 60); assert.equal(range.segments.length, 1); assert.equal(range.lastOccupiedDate, '2026-10-10');
  assert.equal(spanCoveredByDates(range,'2026-10-10','2026-10-10'), true);
  assert.equal(spansOverlap(range,same('2026-10-11','00:00','01:00')), false);
  const pastMidnight = explicit('2026-10-10','23:00','2026-10-11','00:01'); assert.equal(spanCoveredByDates(pastMidnight,'2026-10-10','2026-10-10'), false);
});
test('night shifts collide with both-day shifts/leave and prior-day night source; touching endpoints remain allowed', () => {
  const night = explicit('2026-10-10','23:00','2026-10-11','01:00');
  assert.equal(spansOverlap(night,same('2026-10-10','22:30','23:30')), true); assert.equal(spansOverlap(night,same('2026-10-11','00:30','01:30')), true);
  assert.equal(spansOverlap(night,same('2026-10-11','01:00','02:00')), false); assert.equal(spansOverlap(night,same('2026-10-10','22:00','23:00')), false);
  const leave = explicit('2026-10-11','00:00','2026-10-12','00:30'); assert.equal(spansOverlap(leave,night), true);
  assert.equal(spansOverlap(leave,same('2026-10-12','00:00','01:00')), true);
});
test('validity checks span all positive-minute dates across month/year and do not turn midnight into a false extra occupied day', () => {
  const night = explicit('2026-12-31','23:30','2027-01-01','01:00'); assert.equal(spanCoveredByDates(night,'2026-01-01','2026-12-31'), false); assert.equal(spanCoveredByDates(night,'2026-01-01','2027-01-01'), true);
  assert.throws(() => spanCoveredByDates(night,'2027-01-01','2026-12-31'));
});
test('closed input rejects getters, symbols, null/array/unknown end-date shapes without invoking accessors or mutating source', () => {
  let invoked = 0; const item = {date:'2026-10-10',startTime:'09:00',endTime:'10:00'}; Object.defineProperty(item,'endDate',{enumerable:true,get(){invoked++;return '2026-10-11';}});
  assert.throws(() => shiftSpan(item), {code:'SPAN_SHAPE_INVALID'}); assert.equal(invoked,0);
  const base = {date:'2026-10-10',startTime:'09:00',endTime:'10:00'}; for (const value of [null, [], {...base,unexpected:true}, {...base,[Symbol('endDate')]:'2026-10-11'}, {date:'2026-10-10',startTime:'09:00',endTime:'10:00',endDate:null}]) assert.throws(() => shiftSpan(value));
});
test('calendar move preserves clock duration/span day offset and never changes an old saved record or snapshot', () => {
  const stored={date:'2026-12-31',startTime:'23:30',endDate:'2027-01-01',endTime:'01:00'}, original=JSON.stringify(stored), moved={...stored,date:moveCalendarDate(stored.date,7),endDate:moveCalendarDate(stored.endDate,7)};
  assert.equal(shiftSpan(moved).durationMinutes,shiftSpan(stored).durationMinutes); assert.equal(JSON.stringify(stored),original); assert.equal(moved.date,'2027-01-07'); assert.equal(moved.endDate,'2027-01-08');
  assert.throws(() => moveCalendarDate('0000-01-01',-1)); assert.throws(() => moveCalendarDate('9999-12-31',1)); assert.throws(() => moveCalendarDate('2026-10-10',1.5));
});
