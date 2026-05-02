export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}
