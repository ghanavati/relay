export function toMcpResult<T>(data: T): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
