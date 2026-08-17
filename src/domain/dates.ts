const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function toLocalCalendarDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(value: string, days: number): string {
  if (!isCalendarDate(value) || !Number.isInteger(days)) {
    throw new TypeError("Неверная календарная дата или число дней");
  }

  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return toLocalCalendarDate(date);
}

export function compareCalendarDates(left: string, right: string): number {
  if (!isCalendarDate(left) || !isCalendarDate(right)) {
    throw new TypeError("Неверная календарная дата");
  }
  return left.localeCompare(right);
}

export function formatCalendarDate(value: string): string {
  if (!isCalendarDate(value)) throw new TypeError("Неверная календарная дата");
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}
