export declare const CALENDAR_WEEKDAYS: readonly ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export type CalendarWeekday = typeof CALENDAR_WEEKDAYS[number];
export type CalendarRule = {
    every: "day" | "week";
    at: string;
    timezone: string;
    on?: CalendarWeekday[];
};
export type CalendarOccurrence = {
    nextLocalDate: string;
    nextRunAt: string;
};
export type CalendarTrigger = CalendarRule & CalendarOccurrence & {
    kind: "calendar";
};
export declare function normalizeCalendarRule(input: {
    every?: unknown;
    at?: unknown;
    timezone?: unknown;
    on?: unknown;
}): CalendarRule;
export declare function nextCalendarOccurrence(rule: CalendarRule, after: number, minimumDate?: string): CalendarOccurrence;
export declare function latestCalendarOccurrence(rule: CalendarRule, now: number, minimumDate: string): CalendarOccurrence | undefined;
export declare function calendarDateAfter(rule: CalendarRule, consumedAt: number, pendingDate: string): string;
/** Re-resolve the pending date using current timezone data, without consulting its UTC cache. */
export declare function restoreCalendarTrigger(input: CalendarTrigger): CalendarTrigger;
//# sourceMappingURL=calendar-schedule.d.ts.map