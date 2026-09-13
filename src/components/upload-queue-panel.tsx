// Review panel for the temporary multi-folder upload queue.
// Phase 3: folder-wise automatic page numbering per group.
// Phase 4: pre-scan (duplicate + leftover + collision detection).
// Phase 5-7: the real multi-folder upload engine, per-folder status with
// verification and retry, batch history and Gmail notification per group.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  FolderOpen,
  Layers,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { formatPages, type LeftoverCandidate } from "@/lib/upload-scan";
import { prescanQueue, type QueueScan } from "@/lib/queue-prescan";
import { runQueueUpload, type GroupProgress, type QueueUploadState } from "@/lib/queue-upload";
import {
  clearQueue,
  queueFileCount,
  removeGroup,
  setGroupAutoNumber,
  useUploadQueue,
  type QueueGroup,
} from "@/lib/upload-queue";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function groupPages(g: QueueGroup): string {
  if (g.pageStart == null || g.pageEnd == null) return "—";
  return formatPages(g.pageStart === g.pageEnd ? [g.pageStart] : [g.pageStart, g.pageEnd]).replace(
    ", ",
    "–",
  );
}

const STATUS_LABEL: Record<GroupProgress["status"], string> = {
  pending: "Waiting",
  uploading: "Uploading",
  verifying: "Verifying",
  done: "Uploaded",
  partial: "Partly uploaded",
  failed: "Failed",
  paused: "Paused",
};

export function UploadQueuePanel({
  disabled,
  getToken,
  getClerkToken,
}: {
  disabled?: boolean;
  getToken?: (folderId: string, force?: boolean) => Promise<string>;
  getClerkToken?: () => Promise<string | null>;
}) {
  const groups = useUploadQueue();
  const [scan, setScan] = useState<QueueScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uploadState, setUploadState] = useState<QueueUploadState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  if (groups.length === 0 && !uploadState) return null;

  const totalFiles = queueFileCount(groups);
  const totalBytes = groups.reduce((s, g) => s + g.totalBytes, 0);
  const scanStale = scan != null && scan.totalFiles !== totalFiles;
  const scanById = new Map((scan?.groups ?? []).map((g) => [g.groupId, g]));
  const progressById = new Map((uploadState?.groups ?? []).map((p) => [p.groupId, p]));
  const overallPct = uploadState?.bytesTotal
    ? Math.min(100, Math.round((uploadState.bytesDone / uploadState.bytesTotal) * 100))
    : 0;
  const totalFailed = (uploadState?.groups ?? []).reduce((s, p) => s + p.failed.length, 0);

  async function runPrescan(): Promise<QueueScan | null> {
    if (!getToken) {
      toast.error("Drive is not connected yet — open a folder first.");
      return null;
    }
    setScanning(true);
    try {
      const result = await prescanQueue(groups, getToken);
      setScan(result);
      if (result.errors.length > 0) {
        toast.warning(`Some folders could not be read: ${result.errors[0]}`);
      } else {
        toast.success(
          `Scanned ${result.totalFiles} image${result.totalFiles === 1 ? "" : "s"} across ${result.folderCount} folder${result.folderCount === 1 ? "" : "s"}. Nothing uploaded.`,
        );
      }
      return result;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setScanning(false);
    }
  }

  async function handleUploadAll() {
    const result = scan && !scanStale ? scan : await runPrescan();
    if (result) setConfirmOpen(true);
  }

  /** Phase 5-7: upload every queued group to its own folder. */
  async function startUpload(opts: { deleteLeftovers: boolean; only?: string[] }) {
    if (!getToken) {
      toast.error("Drive is not connected yet — open a folder first.");
      return;
    }
    const selected = opts.only ? groups.filter((g) => opts.only!.includes(g.id)) : groups;
    if (selected.length === 0) return;

    const namesByGroup = new Map<string, string[]>();
    const leftoversByGroup = new Map<string, LeftoverCandidate[]>();
    for (const s of scan?.groups ?? []) {
      namesByGroup.set(s.groupId, s.names);
      if (opts.deleteLeftovers && s.leftovers.length > 0) {
        leftoversByGroup.set(s.groupId, s.leftovers);
      }
    }

    pausedRef.current = false;
    setPaused(false);
    setUploading(true);
    try {
      const result = await runQueueUpload({
        groups: selected,
        namesByGroup,
        leftoversByGroup,
        getDriveToken: (folderId, force) => getToken(folderId, force),
        getClerkToken: getClerkToken ?? (async () => null),
        onState: setUploadState,
        isPaused: () => pausedRef.current,
      });
      if (result.failed === 0 && !pausedRef.current) {
        toast.success(
          `Uploaded ${result.uploaded} image${result.uploaded === 1 ? "" : "s"} to ${selected.length} folder${selected.length === 1 ? "" : "s"}.`,
        );
        // Fully successful groups leave the queue.
        for (const g of result.groups) if (g.status === "done") removeGroup(g.groupId);
        setScan(null);
      } else if (pausedRef.current) {
        toast.info("Upload paused. Press Resume to continue.");
      } else {
        toast.warning(
          `${result.failed} image${result.failed === 1 ? "" : "s"} failed. Press "Retry failed folders".`,
        );
        for (const g of result.groups) if (g.status === "done") removeGroup(g.groupId);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function retryFailed() {
    const ids = (uploadState?.groups ?? [])
      .filter((p) => p.status === "partial" || p.status === "failed" || p.status === "paused")
      .map((p) => p.groupId)
      .filter((id) => groups.some((g) => g.id === id));
    if (ids.length === 0) return;
    void startUpload({ deleteLeftovers: false, only: ids });
  }

  const busy = disabled || uploading;

  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">Upload queue</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {groups.length} group{groups.length === 1 ? "" : "s"} · {totalFiles} image
              {totalFiles === 1 ? "" : "s"} · {formatBytes(totalBytes)}
              {uploading ? " — uploading…" : " — nothing uploaded yet"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            clearQueue();
            setScan(null);
            setUploadState(null);
          }}
          disabled={busy}
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-destructive disabled:opacity-40"
        >
          <Trash2 className="mr-1 inline h-3 w-3" />
          Clear
        </button>
      </div>

      {uploadState && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>
              {uploadState.doneFiles} / {uploadState.totalFiles} images
            </span>
            <span>{overallPct}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full bg-[image:var(--gradient-primary)] transition-all"
              style={{ width: `${Math.max(uploading ? 3 : 0, overallPct)}%` }}
            />
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-1.5">
        {groups.map((g) => {
          const s = scanById.get(g.id);
          const p = progressById.get(g.id);
          const pct = p && p.bytesTotal ? Math.round((p.bytesDone / p.bytesTotal) * 100) : 0;
          return (
            <li
              key={g.id}
              className="rounded-lg border border-border/50 bg-background/60 px-3 py-2"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{g.folderName}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {g.files.length} image{g.files.length === 1 ? "" : "s"} · pages{" "}
                      {groupPages(g)} · {formatBytes(g.totalBytes)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    removeGroup(g.id);
                    setScan(null);
                  }}
                  disabled={busy}
                  aria-label={`Remove ${g.folderName} group from queue`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Phase 3 — folder-wise automatic page numbering */}
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                  checked={g.autoNumber}
                  disabled={busy}
                  onChange={(e) => {
                    setGroupAutoNumber(g.id, e.target.checked);
                    setScan(null);
                  }}
                />
                Continue this folder&apos;s page numbers automatically
                {g.autoNumber && s?.renumbered && s.pageStart != null && s.pageEnd != null && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                    → pages {s.pageStart}–{s.pageEnd}
                  </span>
                )}
              </label>

              {/* Phase 4 — per-group scan result */}
              {s && !p && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-medium">
                  {s.error ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                      Folder could not be read
                    </span>
                  ) : (
                    <>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                        {s.freshCount} new
                      </span>
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-500">
                        {s.replaceCount} will replace
                      </span>
                      {s.leftovers.length > 0 && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                          {s.leftovers.length} possible leftover (
                          {formatPages(s.leftovers.map((l) => l.page))})
                        </span>
                      )}
                      {s.collisions.length > 0 && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                          {s.collisions.length} clash with an earlier group
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Phase 6 — per-folder upload status */}
              {p && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[10px] font-medium">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        p.status === "done" && "bg-primary/10 text-primary",
                        (p.status === "uploading" || p.status === "verifying") &&
                          "bg-primary/10 text-primary",
                        p.status === "partial" && "bg-amber-500/10 text-amber-500",
                        p.status === "failed" && "bg-destructive/10 text-destructive",
                        (p.status === "pending" || p.status === "paused") &&
                          "bg-muted text-muted-foreground",
                      )}
                    >
                      {(p.status === "uploading" || p.status === "verifying") && (
                        <Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />
                      )}
                      {p.status === "done" && (
                        <CheckCircle2 className="mr-1 inline h-2.5 w-2.5" />
                      )}
                      {STATUS_LABEL[p.status]}
                    </span>
                    <span className="text-muted-foreground">
                      {p.done} / {p.total}
                      {p.verified > 0 ? ` · ${p.verified} verified` : ""}
                      {p.failed.length > 0 ? ` · ${p.failed.length} failed` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-border/60">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {p.failed.length > 0 && (
                    <p className="mt-1 truncate text-[10px] text-destructive">
                      {p.failed[0].name}: {p.failed[0].message}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!uploading && (
        <Button
          variant="outline"
          size="lg"
          className="mt-3 h-11 w-full font-semibold"
          disabled={busy || scanning}
          onClick={() => void runPrescan()}
        >
          {scanning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scanning queue…
            </>
          ) : (
            <>
              <ScanSearch className="mr-2 h-4 w-4" />
              {scan && !scanStale ? "Re-scan queue" : "Pre-scan queue"}
            </>
          )}
        </Button>
      )}

      {uploading ? (
        <Button
          variant="outline"
          size="lg"
          className="mt-3 h-11 w-full font-semibold"
          onClick={() => {
            pausedRef.current = true;
            setPaused(true);
          }}
          disabled={paused}
        >
          <Pause className="mr-2 h-4 w-4" />
          {paused ? "Pausing…" : "Pause upload"}
        </Button>
      ) : (
        <>
          <Button
            size="lg"
            disabled={busy || scanning || groups.length === 0}
            onClick={() => void handleUploadAll()}
            className={cn(
              "mt-2 h-11 w-full font-semibold border-0",
              "bg-[image:var(--gradient-primary)] text-primary-foreground shadow-[var(--shadow-primary)]",
            )}
          >
            <UploadCloud className="mr-2 h-4 w-4" />
            Upload All to Google Drive ({totalFiles})
          </Button>
          {(totalFailed > 0 || paused) && (
            <Button
              variant="outline"
              size="lg"
              className="mt-2 h-11 w-full font-semibold"
              onClick={retryFailed}
            >
              {paused ? <Play className="mr-2 h-4 w-4" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              {paused ? "Resume upload" : "Retry failed folders"}
            </Button>
          )}
        </>
      )}
      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        Each folder is uploaded, verified and logged separately. Successful groups leave the queue
        automatically.
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review this upload session</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                {scan?.totalFiles ?? 0} image{(scan?.totalFiles ?? 0) === 1 ? "" : "s"} across{" "}
                {scan?.folderCount ?? 0} folder{(scan?.folderCount ?? 0) === 1 ? "" : "s"}:{" "}
                {scan?.totalFresh ?? 0} new, {scan?.totalReplace ?? 0} will replace an existing
                file.
              </span>
              {(scan?.totalLeftovers ?? 0) > 0 && (
                <span className="block">
                  {scan?.totalLeftovers} page{scan?.totalLeftovers === 1 ? "" : "s"} from an earlier
                  upload are no longer covered by this session.
                </span>
              )}
              {(scan?.totalCollisions ?? 0) > 0 && (
                <span className="block text-destructive">
                  {scan?.totalCollisions} file name{scan?.totalCollisions === 1 ? "" : "s"} appear
                  in two groups going to the same folder — the later group would overwrite the
                  earlier one.
                </span>
              )}
              {(scan?.errors.length ?? 0) > 0 && (
                <span className="block text-destructive">{scan?.errors[0]}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {(scan?.totalLeftovers ?? 0) > 0 && (
              <AlertDialogAction
                onClick={() => void startUpload({ deleteLeftovers: true })}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Upload &amp; remove leftovers
              </AlertDialogAction>
            )}
            <AlertDialogAction onClick={() => void startUpload({ deleteLeftovers: false })}>
              Upload all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
