// Pure helpers for talking to the daemon; register.tsx does the actual $.http.fetch.
export type Ctx = { id: string; endpoint: string; token: string }

export const request = (c: Ctx, method: string, path: string, body?: unknown): [string, { method: string; headers: Record<string, string>; body?: string }] => [
  `${c.endpoint}${path}`,
  {
    method,
    headers: { Authorization: `Bearer ${c.token}`, 'X-TL-Node': c.id, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
]

export const parse = (path: string, r: { ok: boolean; status: number; text: string }) => {
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.text}`)
  return r.text ? JSON.parse(r.text) : undefined
}
