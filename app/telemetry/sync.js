// CloudSyncAdapter manages authentication, connection status, trace compression,
// and replication of local IndexedDB mutations to Supabase.

import {
  getAll,
  getPendingSyncTasks,
  updateSyncTaskStatus,
  remove,
} from "../core/db.js?v=shot-store-146";

let supabaseClient = null;
let initializationPromise = null;

async function getSupabase() {
  if (supabaseClient) return supabaseClient;
  if (initializationPromise) return initializationPromise;

  const url = localStorage.getItem("openfloat_supabase_url");
  const key = localStorage.getItem("openfloat_supabase_key");

  if (!url || !key) return null;

  initializationPromise = (async () => {
    try {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      supabaseClient = createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      });
      return supabaseClient;
    } catch (error) {
      console.error("Failed to load Supabase client from CDN:", error);
      return null;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// Compress JSON data using native browser CompressionStream (Gzip)
// and encode to Base64 for database-friendly text storage.
async function compressPayload(data) {
  try {
    const jsonStr = JSON.stringify(data);
    const stream = new Response(jsonStr).body.pipeThrough(
      new CompressionStream("gzip")
    );
    const compressedBuffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(compressedBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (err) {
    console.error("Gzip compression failed, falling back to raw JSON:", err);
    return JSON.stringify(data);
  }
}

function missingColumnFromError(error) {
  const message = error && error.message ? error.message : "";
  const match = message.match(/Could not find the '([^']+)' column/);
  return match ? match[1] : null;
}

export class CloudSyncAdapter {
  constructor(bus, store) {
    this.bus = bus;
    this.store = store;
    this.syncing = false;
    this.syncRequested = false;
    this.user = null;
    this.reportedSchemaSkips = new Set();

    // Listen to network status changes
    window.addEventListener("online", () => {
      this.bus.emit("log", "Network online. Triggering cloud sync...");
      this.triggerSync();
    });

    window.addEventListener("offline", () => {
      this.bus.emit("log", "Network offline. Running local-only mode.");
      this.updateStatus();
    });

    // Check credentials and auth status on startup
    this.init();
  }

  async init() {
    await this.authenticate();
    this.triggerSync();
  }

  async authenticate() {
    const sb = await getSupabase();
    if (!sb) {
      this.user = null;
      this.updateStatus();
      return null;
    }

    try {
      let { data: { session } } = await sb.auth.getSession();
      
      if (!session) {
        // Run anonymous sign-in
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw error;
        session = data.session;
        this.bus.emit("log", "Authenticated anonymously with Supabase.");
      } else {
        this.bus.emit("log", `Connected to Supabase as user: ${session.user.id}`);
      }

      this.user = session.user;
      
      // Ensure user profile row exists in public.users table
      await this.syncUserProfile();
    } catch (error) {
      console.error("Supabase Authentication error:", error);
      if (error.message && error.message.includes("Anonymous sign-ins are disabled")) {
        this.bus.emit("log", "Sync Failed: Anonymous sign-ins are disabled in your Supabase project. Enable them in your Supabase Console: Authentication -> Providers -> Anonymous.");
      } else {
        this.bus.emit("log", `Auth failed: ${error.message}`);
      }
      this.user = null;
    }

    this.updateStatus();
    return this.user;
  }

  // Ensure public.users table has a record for this user
  async syncUserProfile() {
    if (!this.user) return;
    const sb = await getSupabase();
    if (!sb) return;

    try {
      const { error } = await sb.from("users").upsert({
        id: this.user.id,
        display_name: "Archer " + this.user.id.slice(0, 5),
        created_at: new Date().toISOString()
      }, { onConflict: "id" });

      if (error) console.error("Error creating public user profile:", error);
    } catch (e) {
      console.error(e);
    }
  }

  async updateStatus() {
    const hasConfig = !!(localStorage.getItem("openfloat_supabase_url") && localStorage.getItem("openfloat_supabase_key"));
    let statusText = "Local-Only";
    let statusMode = "local";

    if (hasConfig) {
      if (!navigator.onLine) {
        statusText = "Offline (Local Queue)";
        statusMode = "offline";
      } else if (this.user) {
        statusText = this.syncing ? "Syncing..." : "Cloud Connected";
        statusMode = this.syncing ? "syncing" : "cloud";
      } else {
        statusText = "Sync Connection Failed";
        statusMode = "error";
      }
    }

    // Get current pending count
    let pendingCount = 0;
    try {
      const pending = await getPendingSyncTasks();
      pendingCount = pending.length;
    } catch (_) {}

    this.store.set({
      syncStatus: statusMode,
      syncText: statusText,
      syncQueueCount: pendingCount,
      cloudUser: this.user ? this.user.email || "Anonymous User" : null
    });
  }

  async triggerSync() {
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    this.syncing = true;
    this.syncRequested = false;
    let completed = false;
    try {
      if (!navigator.onLine) return;
      const sb = await getSupabase();
      if (!sb) return; // No config, quiet exit.
      if (!this.user) {
        await this.authenticate();
        if (!this.user) return;
      }
      this.updateStatus();
      await this.processQueue(sb);
      completed = true;
    } catch (error) {
      console.error("Error during queue processing:", error);
      this.bus.emit("log", `Sync interrupted: ${error.message}`);
    } finally {
      this.syncing = false;
      this.updateStatus();
      // Catch a trigger arriving just as the last empty-queue read finishes.
      // Failed uploads wait for the next trigger instead of retrying in a loop.
      if (completed && this.syncRequested) this.triggerSync();
    }
  }

  async processQueue(sb) {
    const drain = async () => {
      let uploaded = 0;
      for (;;) {
        // A tab may have closed after marking a task as syncing. The shared
        // lock makes it safe to replay that unfinished work with an upsert.
        const pending = (await getAll("sync_queue"))
          .filter((task) => task.status === "pending" || task.status === "syncing");
        if (!pending.length) break;
        this.bus.emit("log", `Uploading ${pending.length} pending records to cloud...`);
        for (const task of pending) {
          // A local deletion may have removed work while an earlier upload
          // was in flight. Use the committed queue row, not the stale snapshot.
          const currentTask = await updateSyncTaskStatus(task.id, "syncing");
          if (!currentTask) continue;
          try {
            await this.syncTask(sb, currentTask);
            await remove("sync_queue", task.id);
            uploaded += 1;
          } catch (err) {
            await updateSyncTaskStatus(task.id, "pending");
            this.bus.emit("log", `Upload failed for task #${task.id}: ${err.message}`);
            throw err;
          }
        }
      }
      if (uploaded) this.bus.emit("log", "All pending cloud sync tasks completed successfully.");
    };
    // Chrome/Edge coordinate uploads across tabs. Older browsers retain the
    // adapter's existing per-tab guard without requiring another dependency.
    return navigator.locks?.request
      ? navigator.locks.request("openfloat-cloud-sync", drain)
      : drain();
  }

  async syncTask(sb, task) {
    const { table, action, payload, targetId } = task;

    if (action === "CREATE" || action === "UPDATE") {
      let finalPayload = { ...payload };

      // Stamp the owning user on every user-scoped table so row-level security
      // can partition data per user. shots carry no user_id locally (session_id
      // is null), so inject it here; shot_traces is handled in its block below.
      if (
        table === "sessions" ||
        table === "bow_profiles" ||
        table === "shots"
      ) {
        finalPayload.user_id = this.user.id;
      }

      // If syncing trace data, compress both the motion payload and the
      // full-rate mic envelope before sending. The mic series is high-rate and
      // largely redundant with the per-point micAmp already inside payload, so
      // storing it raw bloated rows to hundreds of KB; both blobs now share the
      // `encoding` marker. Nothing reads these back in-app today.
      if (table === "shot_traces") {
        const compressedPayload = await compressPayload(payload.payload);
        const compressedMic =
          payload.mic_series && payload.mic_series.length
            ? await compressPayload(payload.mic_series)
            : null;
        finalPayload = {
          shot_id: payload.shot_id,
          user_id: this.user.id,
          encoding: "gzip-base64",
          sample_rate_hz: payload.sample_rate_hz || 416,
          source: payload.source || null,
          has_mic: !!payload.has_mic,
          mic_sample_rate_hz: payload.mic_sample_rate_hz || null,
          mic_series: compressedMic,
          payload: compressedPayload
        };
      }

      // Perform upsert to Supabase table. Older user schemas may not have every
      // locally-derived metric yet, so retry after dropping unknown columns.
      const droppedColumns = [];
      const maxAttempts = Object.keys(finalPayload).length + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { error } = await sb.from(table).upsert(finalPayload);
        if (!error) {
          if (droppedColumns.length > 0) {
            const schemaSkipKey = `${table}:${droppedColumns.sort().join(",")}`;
            if (!this.reportedSchemaSkips.has(schemaSkipKey)) {
              this.reportedSchemaSkips.add(schemaSkipKey);
              this.bus.emit(
                "log",
                `Cloud schema skipped unsupported ${table} field(s): ${droppedColumns.join(", ")}.`,
              );
            }
          }
          return;
        }

        const missingColumn = missingColumnFromError(error);
        if (
          missingColumn &&
          Object.prototype.hasOwnProperty.call(finalPayload, missingColumn)
        ) {
          delete finalPayload[missingColumn];
          droppedColumns.push(missingColumn);
          continue;
        }

        // If foreign key constraint fails because the parent session has not
        // been synced yet, raise an error to block the queue, maintaining
        // sequential ordering.
        throw new Error(`Database upsert failed: ${error.message}`);
      }

      throw new Error(
        `Database upsert failed after removing unsupported columns from ${table}`,
      );
    } else if (action === "DELETE") {
      const idColumn = table === "shot_traces" ? "shot_id" : "id";
      const { error } = await sb.from(table).delete().eq(idColumn, targetId);
      if (error) throw new Error(`Database delete failed: ${error.message}`);
    }
  }

  // Force re-initialization after credential changes in UI settings
  async resetConfig() {
    supabaseClient = null;
    initializationPromise = null;
    this.user = null;
    await this.init();
  }
}
