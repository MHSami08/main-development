// Client-side trigger for the Gmail batch notification.
// Completely independent of Drive upload results: never throws.

const SENT_KEY = "upload-notify-sent-v1";

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Stable id for one batch: same folder + same file set = same id across refreshes. */
export function computeBatchId(folderId: string, names: string[]): string {
  const sorted = [...names].sort().join("\u0000");
  return `${folderId}-${names.length}-${hash(sorted)}`;
}

function sentIds(): string[] {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

function rememberSent(batchId: string) {
  try {
    const next = [...sentIds().filter((x) => x !== batchId), batchId].slice(-50);
    localStorage.setItem(SENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export async function notifyBatchComplete(params: {
  token: string | null;
  batchId: string;
  batchName: string;
  imageCount: number;
}): Promise<void> {
  if (sentIds().includes(params.batchId)) return;
  try {
    const res = await fetch("/api/notify/upload-complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.token ?? ""}`,
      },
      body: JSON.stringify({
        batchId: params.batchId,
        batchName: params.batchName,
        imageCount: params.imageCount,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string };
    if (json.status === "sent" || json.status === "sending") rememberSent(params.batchId);
  } catch {
    // Email failure must never affect the upload result.
  }
}
