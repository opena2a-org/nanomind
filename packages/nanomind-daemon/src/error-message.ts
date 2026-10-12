/**
 * The text to print for an error. Node reports a connection that fails on
 * every address of a host as an AggregateError with an empty message; its
 * reasons are in `errors` (one per address) and its `code` names the failure.
 * Without this, such an error prints as nothing at all.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  const inner = (err as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length > 0) return inner.map(errorMessage).join('; ');
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code) return code;
  return err.name;
}
