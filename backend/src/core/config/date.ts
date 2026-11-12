export function normalizeDateInput(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  const text = value
    .trim()
    .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+of\s+/gi, ' ');
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first === second || first > 12)
      return validDate(Number(numeric[3]), second, first);
    if (second > 12) return validDate(Number(numeric[3]), first, second);
    return null;
  }

  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const named = text
    .replace(/,/g, '')
    .match(/^(?:(\d{1,2})\s+([a-z]+)|([a-z]+)\s+(\d{1,2}))\s+(\d{4})$/i);
  if (!named) return null;
  const monthName = (named[2] ?? named[3]).slice(0, 3).toLowerCase();
  const month = months.indexOf(monthName) + 1;
  const day = Number(named[1] ?? named[4]);
  return month === 0 ? null : validDate(Number(named[5]), month, day);
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}
