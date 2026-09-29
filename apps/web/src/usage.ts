import type { UsageReport } from "@pios/protocol";

export async function fetchUsage(baseUrl: string, token: string): Promise<UsageReport | null> {
  const response = await fetch(new URL("/usage", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`usage failed (${response.status})`);
  const body = (await response.json()) as { usage: UsageReport | null };
  return body.usage;
}

/** "resets in 4h 22m", the only part of the timestamp worth reading on a phone. */
export function resetsIn(iso: string, now = Date.now()): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatSpend(spend: NonNullable<UsageReport["spend"]>): string {
  const scale = 10 ** spend.exponent;
  const text = (amount: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: spend.currency }).format(
      amount / scale,
    );
  return spend.limit === null
    ? `${text(spend.used)} used`
    : `${text(spend.used)} of ${text(spend.limit)}`;
}
