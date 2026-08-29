import { createFileRoute } from "@tanstack/react-router";
import { requireUploaderIdentity } from "@/lib/notify-auth.server";
import { buildUploadEmail, sendGmail } from "@/lib/gmail.server";
import { beginRecord, getRecord, markFailed, markSent } from "@/lib/notify-store.server";

export const Route = createFileRoute("/api/notify/upload-complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let identity;
        try {
          identity = await requireUploaderIdentity(request);
        } catch (e) {
          if (e instanceof Response) return e;
          return new Response("Auth error", { status: 500 });
        }

        const body = (await request.json().catch(() => ({}))) as {
          batchId?: string;
          batchName?: string;
          imageCount?: number;
        };
        const batchId = typeof body.batchId === "string" ? body.batchId.slice(0, 200) : "";
        const batchName =
          typeof body.batchName === "string" && body.batchName.trim()
            ? body.batchName.trim().slice(0, 200)
            : "Untitled batch";
        const imageCount = Number.isFinite(body.imageCount) ? Math.floor(Number(body.imageCount)) : 0;
        if (!batchId || imageCount <= 0) {
          return Response.json({ error: "Missing batchId or imageCount" }, { status: 400 });
        }

        const existing = getRecord(batchId);
        if (existing && (existing.status === "sent" || existing.status === "sending")) {
          return Response.json({ status: existing.status, duplicate: true });
        }

        beginRecord({
          batchId,
          clerkUserId: identity.userId,
          userName: identity.name,
          userEmail: identity.email,
          batchName,
          imageCount,
        });

        try {
          const { subject, html } = buildUploadEmail({
            userName: identity.name,
            userEmail: identity.email,
            batchName,
            imageCount,
          });
          await sendGmail({ subject, html });
          markSent(batchId);
          return Response.json({ status: "sent" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          markFailed(batchId, msg);
          console.error("gmail notify failed:", msg);
          // Never surface as an upload failure — Drive result is unaffected.
          return Response.json({ status: "failed", error: msg }, { status: 200 });
        }
      },
    },
  },
});
