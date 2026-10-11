// Pure schema: model imports this without entering runtime/model cycles.
export const SHIFT_SERIES_ENTITY = 'shift-series';
export const SHIFT_SERIES_FIELDS_STRING = 'name caseId employeeId carePlanId startDate endDate intervalWeeks weekdays startTime endTime services status note endDay';
export const shiftSeriesEntities = { [SHIFT_SERIES_ENTITY]: { fields: SHIFT_SERIES_FIELDS_STRING, required: ['name', 'caseId', 'employeeId', 'carePlanId', 'startDate', 'intervalWeeks', 'weekdays', 'startTime', 'endTime', 'services'], statuses: ['active', 'paused', 'ended'], defaults: { endDate: '', intervalWeeks: 1, weekdays: [], services: [], status: 'active', note: '' }, jsonFields: ['intervalWeeks', 'weekdays'] } };
