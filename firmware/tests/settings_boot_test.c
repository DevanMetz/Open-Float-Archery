/* Real SDK Settings/ZMS backend and hash with production boot/read code.
 * This is single-threaded synthetic RRAM; it does not run Zephyr startup/LED/BLE.
 * Public ZMS call faults cover every strict-reader operation; one separate
 * flash-read fault demonstrates the SDK's missing-name/error distinction.
 */
#include "settings_read.h"
#include "boot_restore.h"
#include "shot_control.h"
#include "shot_log.h"
#include "control_values.h"
#include "trace_store.h"
#include "settings_retry.h"
#include "sleep_flush.h"
#include "shot_recovery.h"
#include <zephyr/sys/hash_function.h>
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#include "settings/backend_under_test.h"
#pragma GCC diagnostic pop
#include <stdio.h>

static uint8_t rram[65536], baseline[65536];
static const struct device device;
static const struct flash_parameters parameters = { 16, 0xff };
static const struct flash_area area = { &device, 0, sizeof(rram) };
static struct settings_store *source_store, *destination_store;
static unsigned int writes, erases, operations, fail_at;
static bool permanent_failure, flash_failure, record_operations;
static unsigned int saved_operations;
static struct stored_trace input, scratch;
static struct stored_shot_log expected_log;
static struct openfloat_shot_counters expected_counters = { 42, 70004 };
static const char *const ordinary[] = {
	"shots", "shotlog", "wakesens", "sleeptime", "sleepsens", "bufrate",
	"bufnvs", "autosleep", "streamrate", "followms", "cant_offset", "pitch_offset",
};
static const int32_t tuning[] = { 2000, 300000, 150, 52, 1, 1, 1, 1500, -7250, 1950 };

static struct {
	struct openfloat_shot_counters counters;
	struct stored_shot_log log;
	struct trace_store store;
	struct stored_trace traces[TRACE_RAM_SLOTS];
	bool tunings[10];
	bool counter_present, full_log_ids, id_recovered;
	unsigned int resets;
} restored;

const struct flash_parameters *flash_get_parameters(const struct device *dev)
{ (void)dev; return &parameters; }
int flash_get_page_info_by_offs(const struct device *dev, off_t offset, struct flash_pages_info *info)
{ (void)dev; (void)offset; info->size = 4096; return 0; }
int flash_area_open(int id, const struct flash_area **result)
{ (void)id; *result = &area; return 0; }
int flash_area_get_sectors(int id, uint32_t *count, struct flash_sector *sector)
{ (void)id; *count = 1; sector->fs_off = 0; sector->fs_size = 4096; return 0; }
int flash_read(const struct device *dev, off_t offset, void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	if (flash_failure) return -EIO;
	memcpy(data, rram + offset, size);
	return 0;
}
int flash_write(const struct device *dev, off_t offset, const void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram) && offset % 16 == 0 && size % 16 == 0);
	writes++;
	memcpy(rram + offset, data, size);
	return 0;
}
int flash_erase(const struct device *dev, off_t offset, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	erases++;
	memset(rram + offset, 0xff, size);
	return 0;
}
void settings_src_register(struct settings_store *store) { source_store = store; }
void settings_dst_register(struct settings_store *store) { destination_store = store; }
int settings_call_set_handler(const char *name, size_t len, settings_read_cb read_cb,
			     void *read_arg, const struct settings_load_arg *arg)
{
	return arg->cb ? arg->cb(name, len, read_cb, read_arg, arg->param) : 0;
}

static struct zms_fs *filesystem(void)
{ return destination_store->cs_itf->csi_storage_get(destination_store); }

static bool fail_operation(void)
{
	operations++;
	if (record_operations) saved_operations++;
	return fail_at && (operations == fail_at || (permanent_failure && operations >= fail_at));
}
ssize_t boot_test_zms_read(struct zms_fs *fs, zms_id_t id, void *data, size_t size)
{ return fail_operation() ? -EIO : zms_read(fs, id, data, size); }
ssize_t boot_test_zms_get_data_length(struct zms_fs *fs, zms_id_t id)
{ return fail_operation() ? -EIO : zms_get_data_length(fs, id); }

static void save(const char *key, const void *data, size_t size)
{ assert(!destination_store->cs_itf->csi_save(destination_store, key, data, size)); }

static int initialize(void *context)
{
	(void)context;
	return settings_backend_init();
}
static void reset(void *context)
{
	(void)context;
	unsigned int resets = restored.resets + 1;
	memset(&restored, 0, sizeof(restored));
	restored.resets = resets;
}
static int restore_setting(void *context, const char *name)
{
	(void)context;
	char key[32];
	snprintf(key, sizeof(key), "openfloat/%s", name);
	int rc = openfloat_settings_read(filesystem(), key, &scratch, sizeof(scratch));
	if (rc <= 0) return rc;
	if (!strcmp(name, "shots")) {
		if (!openfloat_restore_shot_counters(&restored.counters, (uint8_t *)&scratch, (size_t)rc)) return -EBADMSG;
		restored.counter_present = true;
		return 0;
	}
	if (!strcmp(name, "shotlog")) {
		if (!shot_log_restore(&restored.log, (uint8_t *)&scratch, (size_t)rc, (size_t)rc)) return -EBADMSG;
		restored.full_log_ids = (size_t)rc == sizeof(restored.log);
		return 0;
	}
	if (name[0] == 't') return trace_restore(&restored.traces[name[1] - '0'], (uint8_t *)&scratch, (size_t)rc) ? 0 : -EBADMSG;
	for (unsigned int i = 2; i < 12; i++) {
		if (strcmp(name, ordinary[i])) continue;
		if (rc != 4) return -EBADMSG;
		int32_t value;
		memcpy(&value, &scratch, 4);
		bool valid = i < 10 ? openfloat_valid_tuning_setting(name, (uint32_t)value) : true;
		if (!valid) return -EBADMSG;
		assert(value == tuning[i - 2]);
		restored.tunings[i - 2] = true;
		return 0;
	}
	return -ENOENT;
}
static int read_trace(void *context, unsigned int slot, unsigned int part, void *data, size_t size)
{
	(void)context;
	char key[32];
	snprintf(key, sizeof(key), "openfloat/ts%u/%u", slot, part);
	int rc = openfloat_settings_read(filesystem(), key, data, size);
	if (!rc) return -ENOENT;
	if (rc == -EMSGSIZE) return -EBADMSG;
	return rc < 0 ? rc : ((size_t)rc == size ? 0 : -EBADMSG);
}
static int write_trace(void *context, unsigned int slot, unsigned int part, const void *data, size_t size)
{
	(void)context;
	char key[32];
	snprintf(key, sizeof(key), "openfloat/ts%u/%u", slot, part);
	return destination_store->cs_itf->csi_save(destination_store, key, data, size);
}
static const struct trace_store_io trace_io = { NULL, read_trace, write_trace };
static void collect(void *context, const struct stored_trace *trace)
{ (void)context; restored.traces[trace->shot_id % TRACE_RAM_SLOTS] = *trace; }
static int restore_traces(void *context)
{
	(void)context;
	int rc = trace_store_load(&restored.store, &trace_io, &scratch, collect, NULL);
	if (rc) return rc;
	uint32_t previous = restored.counters.shot_id;
	rc = shot_recover_id(&restored.counters, restored.counter_present, &restored.log,
			     restored.full_log_ids, restored.traces, TRACE_RAM_SLOTS);
	restored.id_recovered = !rc && previous != restored.counters.shot_id;
	return rc;
}
static unsigned int repair_calls, repair_failures, repair_mode;
static int write_repaired(void *context, const char *key, const void *data, size_t size)
{
	(void)context;
	repair_calls++;
	if (repair_failures) {
		repair_failures--;
		if (repair_mode) save(key, data, repair_mode == 1 ? size / 2 : size);
		return -EIO;
	}
	return destination_store->cs_itf->csi_save(destination_store, key, data, size);
}
static int commit_recovered(void *context)
{
	(void)context;
	if (!restored.id_recovered) return 0;
	const struct sleep_flush_values values = { .counters = restored.counters };
	return settings_retry_save(SETTING_SHOTS, &values, write_repaired, NULL);
}
static void delay(void *context, uint32_t milliseconds)
{ (void)context; assert(milliseconds == 1000); }
static const struct boot_restore_io boot_io = {
	.initialize = initialize, .reset = reset, .restore_setting = restore_setting,
	.restore_traces = restore_traces, .commit_recovered = commit_recovered, .retry_delay = delay,
};

static void remount(void)
{
	if (destination_store) memset(CONTAINER_OF(destination_store, struct settings_zms, cf_store), 0, sizeof(struct settings_zms));
	assert(!settings_backend_init());
	assert(source_store == destination_store);
}
static void check_restored(void)
{
	/* This read-fault fixture already has the newest ID, so it needs no repair. */
	assert(restored.counters.count == expected_counters.count && restored.counters.shot_id == 70004);
	assert(!memcmp(&restored.log, &expected_log, sizeof(expected_log)));
	for (unsigned int i = 0; i < 10; i++) assert(restored.tunings[i]);
	assert(restored.store.ready);
	for (uint32_t id = 70001; id <= 70004; id++) {
		const struct stored_trace *trace = &restored.traces[id % TRACE_RAM_SLOTS];
		assert(trace->shot_id == id && trace->count == TRACE_CAPACITY && trace->flags == TRACE_HAS_TIMING);
		assert(trace->points[999].roll_cdeg == (int16_t)(id + 999) && trace->points[999].dt_ms == 7);
	}
}
static void restore_baseline(void)
{
	fail_at = operations = 0;
	permanent_failure = flash_failure = false;
	memcpy(rram, baseline, sizeof(rram));
	remount();
	memset(&restored, 0, sizeof(restored));
	writes = erases = 0;
}

/* Real Settings writes with callback-level errors, not simulated flash power
 * cuts or Zephyr worker scheduling. A torn value is committed at half length. */
static struct {
	struct settings_retry queue;
	struct stored_shot_log log;
	struct sleep_flush_values values;
	unsigned int target, mode, remaining, calls[SETTING_COUNT];
	bool replace_in_flight, old_result_fails;
} awake;
static const int32_t awake_tuning[] = { 2500, 500000, 200, 104, 0, 1, 2, 2000, -8000, 2200 };

static int write_awake(void *context, const char *name, const void *data, size_t size)
{
	(void)context;
	unsigned int key = 0;
	while (key < SETTING_COUNT && strcmp(name, settings_retry_key(key))) key++;
	assert(key < SETTING_COUNT);
	awake.calls[key]++;
	if (awake.replace_in_flight && key == SETTING_SHOTS) {
		awake.replace_in_flight = false;
		save(name, data, size);
		awake.values.counters = (struct openfloat_shot_counters){ 44, 90777 };
		settings_retry_request(&awake.queue, BIT(SETTING_SHOTS), 0);
		return awake.old_result_fails ? -EIO : 0;
	}
	if (key == awake.target && awake.remaining) {
		awake.remaining--;
		if (awake.mode) save(name, data, awake.mode == 1 ? size / 2 : size);
		return -EIO;
	}
	return destination_store->cs_itf->csi_save(destination_store, name, data, size);
}
static void drain_awake(void)
{
	uint32_t now = 0;
	for (unsigned int step = 0; step < 100; step++) {
		uint32_t token;
		int key = settings_retry_take(&awake.queue, now, &token);
		if (key >= 0) {
			struct sleep_flush_values snapshot = awake.values;
			int rc = settings_retry_save(key, &snapshot, write_awake, NULL);
			now += 7;
			settings_retry_finish(&awake.queue, key, token, rc, now);
		} else {
			uint32_t wait = settings_retry_delay(&awake.queue, now);
			if (wait == UINT32_MAX) return;
			assert(wait > 0 && wait <= SETTINGS_RETRY_DELAY_MS);
			now += wait;
		}
	}
	assert(!"Settings retries did not stop");
}
static void check_awake(unsigned int skip)
{
	remount();
	for (unsigned int key = 0; key < SETTING_COUNT; key++) {
		if (key == skip) continue;
		int rc = openfloat_settings_read(filesystem(), settings_retry_key(key), &scratch, sizeof(scratch));
		if (key == SETTING_SHOTS) {
			struct openfloat_shot_counters counters = { 0 };
			assert(openfloat_restore_shot_counters(&counters, (uint8_t *)&scratch, rc));
			assert(counters.count == awake.values.counters.count && counters.shot_id == awake.values.counters.shot_id);
		} else if (key == SETTING_SHOTLOG) {
			struct stored_shot_log log = { 0 };
			assert(shot_log_restore(&log, (uint8_t *)&scratch, rc, rc));
			assert(log.count == 1 && log.shots[0].shot_id == 90000 && log.shots[0].shot_count == 43);
			assert(log.shots[0].ax_mg == -12000 && log.shots[0].threshold_cg == 1200);
		} else {
			int32_t value;
			assert(rc == 4);
			memcpy(&value, &scratch, 4);
			assert(value == awake_tuning[key - 2]);
		}
	}
}
static int write_awake_sleep(void *context, const char *name, const void *data, size_t size)
{
	int rc = write_awake(context, name, data, size);
	for (unsigned int key = 0; key < SETTING_COUNT; key++) {
		if (!strcmp(name, settings_retry_key(key))) settings_retry_settle(&awake.queue, key, rc);
	}
	return rc;
}
static int no_awake_traces(void *context) { (void)context; return 0; }
static void initialize_awake(void)
{
	restore_baseline();
	memset(&awake, 0, sizeof(awake));
	struct stored_shot shot = { .shot_id = 90000, .shot_count = 43, .ax_mg = -12000, .threshold_cg = 1200 };
	assert(!shot_log_append(&awake.log, &shot));
	awake.values = (struct sleep_flush_values){ .counters = { 43, 90000 }, .queue = &awake.log,
		.wakesens = 2500, .sleeptime = 500000, .sleepsens = 200, .bufrate = 104,
		.bufnvs = 0, .autosleep = 1, .streamrate = 2, .followms = 2000,
		.cant_offset = -8000, .pitch_offset = 2200 };
	settings_retry_request(&awake.queue, SETTINGS_ALL, 0);
}
static void check_awake_recovery(void)
{
	for (unsigned int key = 0; key < SETTING_COUNT; key++) {
		for (unsigned int mode = 0; mode < 3; mode++) {
			for (unsigned int failures = 1; failures <= 3; failures++) {
				initialize_awake();
				awake.target = key; awake.mode = mode; awake.remaining = failures;
				drain_awake();
				for (unsigned int i = 0; i < SETTING_COUNT; i++) {
					assert(awake.calls[i] == (i == key ? (failures < 3 ? failures + 1 : 3) : 1));
				}
				assert(awake.queue.failed_mask == (failures == 3 ? BIT(key) : 0));
				if (failures == 3) {
					check_awake(key);
					if (mode == 1) {
						const struct sleep_flush_io io = { NULL, write_awake_sleep, no_awake_traces, delay };
						assert(!sleep_flush(&awake.values, &io));
					} else {
						settings_retry_request(&awake.queue, BIT(key), 0);
						drain_awake();
					}
				}
				check_awake(SETTING_COUNT);
				assert(!awake.queue.pending_mask && !awake.queue.failed_mask);
			}
		}
	}
	for (unsigned int fail = 0; fail < 2; fail++) {
		initialize_awake();
		awake.replace_in_flight = true; awake.old_result_fails = fail;
		drain_awake();
		assert(awake.calls[SETTING_SHOTS] == 2 && !awake.queue.failed_mask);
		check_awake(SETTING_COUNT);
	}
	puts("SDK Settings save checks passed: 108 callback write-fault cases, all twelve values after remount, recovery after exhaustion by update/sleep, and newer counters during old successful/failed I/O.");
}

static void check_collisions(void)
{
	memset(rram, 0xff, sizeof(rram));
	remount();
	const char *key = "openfloat/shots";
	uint32_t hash = sys_hash32(key, strlen(key)) & ZMS_HASH_MASK;
	const char other[] = "openfloat/other";
	const uint32_t poison = UINT32_MAX;
	/* Reserve every collision position except the last. The SDK writer must
	 * choose that final position, and the reader must compare complete names. */
	for (unsigned int i = 0; i < ZMS_MAX_COLLISIONS; i++) {
		uint32_t id = ZMS_NAME_ID_FROM_HASH(ZMS_UPDATE_COLLISION_NUM(hash, i));
		assert(zms_write(filesystem(), id, other, sizeof(other) - 1) == sizeof(other) - 1);
		assert(zms_write(filesystem(), ZMS_DATA_ID_FROM_NAME(id), &poison, 4) == 4);
	}
	CONTAINER_OF(destination_store, struct settings_zms, cf_store)->hash_collision_num = ZMS_MAX_COLLISIONS - 1;
	save(key, &expected_counters, sizeof(expected_counters));
	struct openfloat_shot_counters value;
	assert(openfloat_settings_read(filesystem(), key, &value, sizeof(value)) == sizeof(value));
	assert(!memcmp(&value, &expected_counters, sizeof(value)));
	/* A deleted earlier name cannot stop the search before a later collision. */
	assert(zms_delete(filesystem(), ZMS_NAME_ID_FROM_HASH(hash)) >= 0);
	assert(openfloat_settings_read(filesystem(), key, &value, sizeof(value)) == sizeof(value));
	uint8_t too_small[7];
	memset(too_small, 0x5a, sizeof(too_small));
	assert(openfloat_settings_read(filesystem(), key, too_small, sizeof(too_small)) == -EMSGSIZE);
	for (unsigned int i = 0; i < sizeof(too_small); i++) assert(too_small[i] == 0x5a);
	uint32_t value_id = ZMS_DATA_ID_FROM_HASH(ZMS_UPDATE_COLLISION_NUM(hash, ZMS_MAX_COLLISIONS));
	assert(zms_delete(filesystem(), value_id) >= 0);
	assert(openfloat_settings_read(filesystem(), key, &value, sizeof(value)) == -EBADMSG);
}

static void check_id_recovery(void)
{
	const struct {
		uint32_t count, id, log_id, trace_id, recovered, next_count, next_id;
		unsigned int counter_size;
		bool legacy_log, have_trace, ambiguous;
	} cases[] = {
		{ 0, 70000, 70002, 70003, 70003, 1, 70004, 8, false, true, false },
		{ UINT32_MAX, UINT32_MAX - 2, 0, 1, 1, UINT32_MAX, 2, 8, false, true, false },
		{ 0, 0, UINT32_MAX, UINT32_MAX, UINT32_MAX, 1, 0, 0, false, true, false },
		{ UINT32_C(4000000000), 0, 2, 0, UINT32_C(4000000000), UINT32_C(4000000001), UINT32_C(4000000001), 4, true, false, false },
		{ 12, 8, 9, UINT32_C(0x80000009), 8, 0, 0, 8, false, true, true },
	};
	for (unsigned int i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
		fail_at = 0; permanent_failure = flash_failure = false;
		memset(rram, 0xff, sizeof(rram));
		memset(&restored, 0, sizeof(restored));
		remount();
		struct openfloat_shot_counters counters = { cases[i].count, cases[i].id };
		if (cases[i].counter_size) save("openfloat/shots", &counters, cases[i].counter_size);
		struct stored_shot_log log = { .count = 1 };
		log.shots[0] = (struct stored_shot){ .shot_id = cases[i].log_id, .shot_count = 65535 };
		if (cases[i].legacy_log) {
			uint8_t bytes[SHOT_LOG_LEGACY_SIZE] = { 1, 0, 0, 0, 2, 0 };
			save("openfloat/shotlog", bytes, sizeof(bytes));
		} else save("openfloat/shotlog", &log, sizeof(log));
		if (cases[i].have_trace) {
			memset(&input, 0, sizeof(input));
			input.shot_id = cases[i].trace_id; input.version = 1; input.flags = TRACE_HAS_TIMING; input.count = 1;
			struct trace_store store = { .ready = true };
			assert(!trace_store_save(&store, &trace_io, &input));
		}
		remount();
		writes = erases = 0;
		repair_calls = repair_failures = repair_mode = 0;
		assert(boot_restore(&boot_io) == (cases[i].ambiguous ? -EBADMSG : 0));
		assert(restored.counters.count == cases[i].count && restored.counters.shot_id == cases[i].recovered);
		if (cases[i].ambiguous) {
			assert(restored.resets == 3);
			assert(!repair_calls && !writes && !erases);
			continue;
		}
		assert(repair_calls == (cases[i].counter_size == 4 ? 0U : 1U));
		/* Replay may delete the only evidence as soon as BLE starts. Clear the
		 * queue and all trace manifests, then verify the durable repaired pair. */
		shot_log_reset(&log);
		save("openfloat/shotlog", &log, sizeof(log));
		for (unsigned int slot = 0; slot < TRACE_STORE_SLOTS; slot++)
			assert(!write_trace(NULL, slot, TRACE_STORE_MANIFEST_PART, NULL, 0));
		remount(); writes = erases = 0;
		assert(!boot_restore(&boot_io) && !writes && !erases);
		assert(restored.counters.count == cases[i].count && restored.counters.shot_id == cases[i].recovered);
		openfloat_advance_shot(&restored.counters);
		assert(restored.counters.count == cases[i].next_count && restored.counters.shot_id == cases[i].next_id);
		assert(restored.counters.shot_id != cases[i].log_id);
	}
	/* Fail each repair budget before commit, at half length, or after commit.
	 * A complete reread may prove a commit despite its error. No replay starts
	 * on failure; half-length counters remain readable as the legacy layout. */
	for (unsigned int mode = 0; mode < 3; mode++) {
		for (unsigned int failures = 1; failures <= 3; failures++) {
			restore_baseline();
			const struct openfloat_shot_counters stale = { 0, 69999 };
			save("openfloat/shots", &stale, sizeof(stale));
			writes = erases = repair_calls = 0;
			repair_failures = failures; repair_mode = mode;
			int rc = boot_restore(&boot_io);
			assert(rc == (mode < 2 && failures == 3 ? -EIO : 0));
			assert(restored.counters.count == 0 && restored.counters.shot_id == 70004);
			assert(repair_calls == (mode == 2 ? 1U : (failures < 3 ? failures + 1 : 3)));
			if (rc) {
				if (!mode) assert(!writes && !erases);
				repair_failures = 0;
				assert(!boot_restore(&boot_io));
			}
		}
	}
	repair_calls = repair_failures = repair_mode = 0;
	/* A failed tuning read after complete counters/log must never write the
	 * inferred ID. Once reads recover, the repair can commit. */
	restore_baseline();
	const struct openfloat_shot_counters stale = { 0, 69999 };
	save("openfloat/shots", &stale, sizeof(stale));
	writes = erases = 0;
	assert(openfloat_settings_read(filesystem(), "openfloat/shots", &scratch, sizeof(scratch)) > 0);
	assert(openfloat_settings_read(filesystem(), "openfloat/shotlog", &scratch, sizeof(scratch)) > 0);
	fail_at = operations + 1; operations = 0; permanent_failure = true;
	assert(boot_restore(&boot_io) == -EIO && !repair_calls && !writes && !erases);
	fail_at = 0; permanent_failure = false;
	assert(!boot_restore(&boot_io) && repair_calls == 1);
	puts("SDK boot capture-ID checks passed: stale/missing counters, preserved count resets, wrap, legacy exclusion, durable pair after all evidence is removed, nine repair faults, no repair on read/ambiguity errors, and recovery after exhaustion.");
}

int main(void)
{
	memset(rram, 0xff, sizeof(rram));
	assert(!boot_restore(&boot_io));
	assert(restored.counters.count == 0 && restored.counters.shot_id == 0 && restored.log.count == 0 && restored.store.ready);
	shot_log_reset(&expected_log);
	struct stored_shot shot = { .shot_id = 70000, .shot_count = 42, .ax_mg = -12000, .threshold_cg = 1200 };
	assert(!shot_log_append(&expected_log, &shot));
	save("openfloat/shots", &expected_counters, sizeof(expected_counters));
	save("openfloat/shotlog", &expected_log, sizeof(expected_log));
	for (unsigned int i = 2; i < 12; i++) {
		char key[32];
		snprintf(key, sizeof(key), "openfloat/%s", ordinary[i]);
		save(key, &tuning[i - 2], 4);
	}
	for (uint32_t id = 70001; id <= 70004; id++) {
		memset(&input, 0, sizeof(input));
		input.shot_id = id; input.version = 1; input.flags = TRACE_HAS_TIMING; input.count = TRACE_CAPACITY;
		for (unsigned int i = 0; i < TRACE_CAPACITY; i++) input.points[i] = (struct trace_point){ .roll_cdeg = (int16_t)(id + i), .dt_ms = i ? 7 : 0 };
		assert(!trace_store_save(&restored.store, &trace_io, &input));
	}
	memcpy(baseline, rram, sizeof(rram));
	restore_baseline();
	record_operations = true;
	assert(!boot_restore(&boot_io));
	record_operations = false;
	check_restored();
	assert(!writes && !erases);
	assert(saved_operations > 600);
	/* Every production name-length/name/value-length/value read, including
	 * every trace part in both validation and restore passes. */
	for (unsigned int at = 1; at <= saved_operations; at++) {
		restore_baseline();
		fail_at = at;
		assert(!boot_restore(&boot_io));
		assert(restored.resets == 2);
		check_restored();
		assert(!writes && !erases && !memcmp(rram, baseline, sizeof(rram)));
		restore_baseline();
		fail_at = at; permanent_failure = true;
		assert(boot_restore(&boot_io) == -EIO && restored.resets == 3);
		assert(!writes && !erases && !memcmp(rram, baseline, sizeof(rram)));
		fail_at = 0; permanent_failure = false;
		assert(!boot_restore(&boot_io));
		check_restored();
		assert(!writes && !erases);
	}
	/* A physical-layer read error must remain an error. SDK single-key lookup
	 * reports the same error as a missing name, which motivated the strict read. */
	restore_baseline();
	flash_failure = true;
	assert(source_store->cs_itf->csi_load_one(source_store, "openfloat/shots", (char *)&scratch, sizeof(scratch)) == 0);
	assert(openfloat_settings_read(filesystem(), "openfloat/shots", &scratch, sizeof(scratch)) == -EIO);
	assert(boot_restore(&boot_io) == -EIO);
	assert(!writes && !erases);
	flash_failure = false;
	assert(!boot_restore(&boot_io));
	check_restored();
	/* Four-byte legacy count still initializes both counters. Malformed
	 * critical values stay closed; malformed tuning retains its default. */
	restore_baseline();
	uint32_t legacy = 65537;
	save("openfloat/shots", &legacy, 4);
	assert(!boot_restore(&boot_io));
	assert(restored.counters.count == legacy && restored.counters.shot_id == 70004);
	restore_baseline();
	uint8_t malformed = 7;
	save("openfloat/shots", &malformed, 1);
	writes = erases = 0;
	assert(boot_restore(&boot_io) == -EBADMSG && !writes && !erases);
	restore_baseline();
	expected_log.count = 101;
	save("openfloat/shotlog", &expected_log, sizeof(expected_log));
	writes = erases = 0;
	assert(boot_restore(&boot_io) == -EBADMSG && !writes && !erases);
	expected_log.count = 1;
	restore_baseline();
	uint32_t bad_tuning = 9;
	save("openfloat/bufrate", &bad_tuning, 4);
	writes = erases = 0;
	assert(!boot_restore(&boot_io) && !restored.tunings[3] && !writes && !erases);
	check_awake_recovery();
	check_id_recovery();
	check_collisions();
	printf("SDK Settings boot checks passed: %u transient and %u persistent read faults, counter/backlog/full-trace recovery, no application writes, legacy counts, malformed values, real flash read errors, and final collision slot.\n", saved_operations, saved_operations);
	return 0;
}
