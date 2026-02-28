function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

let lastPrefix = "";
let sequence = 0;

export function generateRunId(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1, 2);
  const day = pad(date.getUTCDate(), 2);
  const hour = pad(date.getUTCHours(), 2);
  const minute = pad(date.getUTCMinutes(), 2);
  const second = pad(date.getUTCSeconds(), 2);
  const millis = pad(date.getUTCMilliseconds(), 3);

  const prefix = `${year}${month}${day}_${hour}${minute}${second}`;
  if (prefix === lastPrefix) {
    sequence += 1;
  } else {
    lastPrefix = prefix;
    sequence = 0;
  }

  const suffix = `${millis}${pad(sequence, 3)}`;
  return `run_${prefix}_${suffix}`;
}
