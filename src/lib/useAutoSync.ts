import { useCallback, useEffect, useRef } from "react";
import type { SyncSettings } from "./storage";
import type { CedarSyncSnapshot } from "./sync";
import {
  pullSyncSnapshot,
  pushSyncSnapshot,
  syncSnapshotDataSignature,
} from "./sync";

export interface AutoSyncCallbacks {
  createSnapshot: () => CedarSyncSnapshot;
  mergeAndApply: (
    local: CedarSyncSnapshot,
    cloud: CedarSyncSnapshot,
  ) => CedarSyncSnapshot;
  applySnapshot: (snapshot: CedarSyncSnapshot) => void;
  onSyncComplete: (pushed: boolean, pulled: boolean) => void;
  onSyncError?: (error: Error) => void;
  onSyncStatus?: (message: string | null) => void;
  isStreaming?: () => boolean;
  localVersion?: string;
}

export function useAutoSync(
  syncSettings: SyncSettings,
  callbacks: AutoSyncCallbacks,
): void {
  const busyRef = useRef(false);
  const pendingSyncRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const doSyncRef = useRef<(() => Promise<void>) | null>(null);
  const callbacksRef = useRef(callbacks);
  const localVersion = callbacks.localVersion;
  const settingsRef = useRef(syncSettings);

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    settingsRef.current = syncSettings;
  }, [syncSettings]);

  const canSync = useCallback((): boolean => {
    const settings = settingsRef.current;
    return (
      settings.autoSyncEnabled &&
      Boolean(settings.endpoint.trim()) &&
      settings.syncCode.trim().length >= 8
    );
  }, []);

  const doSync = useCallback(async () => {
    if (busyRef.current) {
      pendingSyncRef.current = true;
      return;
    }
    if (!canSync()) return;
    if (document.visibilityState !== "visible") {
      pendingSyncRef.current = true;
      return;
    }
    if (callbacksRef.current.isStreaming?.()) {
      pendingSyncRef.current = true;
      if (retryTimerRef.current === null) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          void doSyncRef.current?.();
        }, 1_000);
      }
      return;
    }

    busyRef.current = true;
    const {
      createSnapshot,
      mergeAndApply,
      applySnapshot,
      onSyncComplete,
      onSyncError,
      onSyncStatus,
    } = callbacksRef.current;
    const settings = settingsRef.current;

    try {
      onSyncStatus?.("Auto-syncing...");
      const localSnapshot = createSnapshot();
      const localIsEmpty = !snapshotHasMessages(localSnapshot);

      if (localIsEmpty) {
        const cloudSnapshot = await pullSyncSnapshot(settings);
        if (cloudSnapshot && snapshotHasMessages(cloudSnapshot)) {
          applySnapshot(cloudSnapshot);
        }
        onSyncComplete(false, Boolean(cloudSnapshot));
        pendingSyncRef.current = false;
        onSyncStatus?.(null);
        return;
      }

      const cloudSnapshot = await pullSyncSnapshot(settings);
      const mergedSnapshot = cloudSnapshot
        ? mergeAndApply(localSnapshot, cloudSnapshot)
        : localSnapshot;
      const localSignature = syncSnapshotDataSignature(localSnapshot);
      const cloudSignature = cloudSnapshot
        ? syncSnapshotDataSignature(cloudSnapshot)
        : null;
      const mergedSignature = syncSnapshotDataSignature(mergedSnapshot);

      if (cloudSnapshot && mergedSignature !== localSignature) {
        applySnapshot(mergedSnapshot);
      }

      const shouldPush = !cloudSnapshot || mergedSignature !== cloudSignature;
      if (shouldPush) {
        await pushSyncSnapshot(settings, mergedSnapshot);
      }
      onSyncComplete(shouldPush, Boolean(cloudSnapshot));
      pendingSyncRef.current = false;
      onSyncStatus?.(null);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      pendingSyncRef.current = false;
      onSyncError?.(err);
      onSyncStatus?.(`Auto-sync failed: ${err.message}`);
    } finally {
      busyRef.current = false;
      if (pendingSyncRef.current && retryTimerRef.current === null) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          void doSyncRef.current?.();
        }, 500);
      }
    }
  }, [canSync]);

  useEffect(() => {
    doSyncRef.current = doSync;
  }, [doSync]);

  useEffect(() => {
    if (!syncSettings.autoSyncEnabled) return;
    if (!syncSettings.endpoint.trim() || syncSettings.syncCode.trim().length < 8) return;
    if (!localVersion) return;

    const delayMs = Math.min(
      2_000,
      Math.max(800, Math.round(syncSettings.autoSyncIntervalMs / 5)),
    );
    const timer = window.setTimeout(() => {
      void doSync();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [
    syncSettings.autoSyncEnabled,
    syncSettings.autoSyncIntervalMs,
    syncSettings.endpoint,
    syncSettings.syncCode,
    localVersion,
    doSync,
  ]);

  useEffect(() => {
    if (!syncSettings.autoSyncEnabled) return;
    if (!syncSettings.endpoint.trim() || syncSettings.syncCode.trim().length < 8) return;

    const initialTimeout = window.setTimeout(() => {
      void doSync();
    }, 500);
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") void doSync();
    }, syncSettings.autoSyncIntervalMs);

    return () => {
      window.clearTimeout(initialTimeout);
      window.clearInterval(intervalId);
    };
  }, [
    syncSettings.autoSyncEnabled,
    syncSettings.autoSyncIntervalMs,
    syncSettings.endpoint,
    syncSettings.syncCode,
    doSync,
  ]);

  useEffect(() => {
    if (!syncSettings.autoSyncEnabled) return;

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void doSync();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [syncSettings.autoSyncEnabled, doSync]);

  useEffect(() => {
    if (!syncSettings.autoSyncEnabled) return;

    function handleOnline() {
      void doSync();
    }

    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [syncSettings.autoSyncEnabled, doSync]);

  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    },
    [],
  );
}

function snapshotHasMessages(snapshot: CedarSyncSnapshot): boolean {
  return snapshot.conversations.some(
    (conversation) => conversation.messages.length > 0,
  );
}
