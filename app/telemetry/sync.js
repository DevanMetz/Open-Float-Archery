// CloudSyncAdapter manages authentication, connection status, trace compression,
// and replication of local IndexedDB mutations to Supabase.

import {
  getPendingSyncTasks,
  updateSyncTaskStatus,
  remove,
  get,
  put
} from "../core/db.js";

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
    if (this.syncing) return;
    if (!navigator.onLine) {
      this.updateStatus();
      return;
    }

    const sb = await getSupabase();
    if (!sb) {
      this.updateStatus();
      return; // No config, quiet exit
    }

    if (!this.user) {
      // Retry auth
      await this.authenticate();
      if (!this.user) return;
    }

    this.syncing = true;
    this.updateStatus();

    try {
      await this.processQueue(sb);
    } catch (error) {
      console.error("Error during queue processing:", error);
      this.bus.emit("log", `Sync interrupted: ${error.message}`);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  async processQueue(sb) {
    const pending = await getPendingSyncTasks();
    if (pending.length === 0) return;

    this.bus.emit("log", `Uploading ${pending.length} pending records to cloud...`);

    for (const task of pending) {
      // 1. Mark task as syncing locally to avoid double processing
      await updateSyncTaskStatus(task.id, "syncing");

      try {
        await this.syncTask(sb, task);
        // 2. Success - delete task from queue
        await remove("sync_queue", task.id);
      } catch (err) {
        // 3. Transient error (network drop) - mark back to pending and halt execution
        await updateSyncTaskStatus(task.id, "pending");
        this.bus.emit("log", `Upload failed for task #${task.id}: ${err.message}`);
        throw err; 
      }
    }

    this.bus.emit("log", "All pending cloud sync tasks completed successfully.");
  }

  async syncTask(sb, task) {
    const { table, action, payload, targetId } = task;

    if (action === "CREATE" || action === "UPDATE") {
      let finalPayload = { ...payload };

      // Inject the user_id if needed by tables owning user constraints
      if (table === "sessions" || table === "bow_profiles") {
        finalPayload.user_id = this.user.id;
      }

      // If syncing trace data, compress it before sending
      if (table === "shot_traces") {
        const compressed = await compressPayload(payload.payload);
        finalPayload = {
          shot_id: payload.shot_id,
          encoding: "gzip-base64",
          sample_rate_hz: payload.sample_rate_hz || 416,
          source: payload.source || null,
          has_mic: !!payload.has_mic,
          mic_sample_rate_hz: payload.mic_sample_rate_hz || null,
          mic_series: payload.mic_series || null,
          payload: compressed
        };
      }

      // Perform upsert to Supabase table. Older user schemas may not have every
      // locally-derived metric yet, so retry after dropping unknown columns.
      const droppedColumns = [];
      for (let attempt = 0; attempt < 5; attempt++) {
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
        `Database upsert failed: too many unsupported columns in ${table}`,
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
