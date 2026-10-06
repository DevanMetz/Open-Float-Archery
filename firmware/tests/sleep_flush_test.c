/* SPDX-License-Identifier: Apache-2.0 */
#include "sleep_flush.h"
#include "trace_store.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

#define SETTING_COUNT 12
static const char *const keys[SETTING_COUNT] = {
	"openfloat/shots", "openfloat/shotlog", "openfloat/wakesens", "openfloat/sleeptime",
	"openfloat/sleepsens", "openfloat/bufrate", "openfloat/bufnvs", "openfloat/autosleep",
	"openfloat/streamrate", "openfloat/followms", "openfloat/cant_offset", "openfloat/pitch_offset",
};
static const size_t sizes[SETTING_COUNT] = { 8, 2804, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4 };
/* Independent frozen little-endian scalar values, including signed offsets. */
static const uint8_t scalars[][4] = {
	{0xd0, 0x07, 0, 0}, {0xe0, 0x93, 0x04, 0}, {0x96, 0, 0, 0}, {0x68, 0, 0, 0},
	{1, 0, 0, 0}, {1, 0, 0, 0}, {5, 0, 0, 0}, {0xbe, 0x0a, 0, 0},
	{0xc0, 0x1d, 0xfe, 0xff}, {0xd0, 0x07, 0, 0},
};
struct setting_value { size_t size; uint8_t data[2804]; };
struct trace_value { size_t size; uint8_t data[TRACE_STORE_PART_SIZE]; };
static struct {
	struct setting_value settings[SETTING_COUNT];
	struct trace_value parts[TRACE_STORE_SLOTS][TRACE_STORE_PARTS + 1];
	unsigned int setting_calls, trace_calls, trace_attempts, part_calls, delays;
	int fail_key;
	unsigned int setting_fail_passes, trace_fail_passes, fail_part, fail_mode;
	bool trace_dirty;
} backend;
static struct stored_shot_log queue;
static struct stored_trace input, scratch, received;
static struct trace_store store;
static unsigned int restored_count;

static const struct sleep_flush_values values = {
	.counters = { 42, UINT32_MAX }, .queue = &queue,
	.wakesens = 2000, .sleeptime = 300000, .sleepsens = 150,
	.bufrate = 104, .bufnvs = 1, .autosleep = 1, .streamrate = 5, .followms = 2750,
	.cant_offset = -123456, .pitch_offset = 2000,
};

static void copy_with_fault(uint8_t *dest, const void *data, size_t size, bool fail)
{
	if (!size) return;
	if (fail && backend.fail_mode == 1) {
		memcpy(dest, data, size / 2);
		memset(dest + size / 2, 0xa5, size - size / 2);
	} else memcpy(dest, data, size);
}

static int write_setting(void *context, const char *key, const void *data, size_t size)
{
	(void)context;
	unsigned int index = backend.setting_calls % SETTING_COUNT;
	unsigned int pass = backend.setting_calls++ / SETTING_COUNT;
	assert(!strcmp(key, keys[index]) && size == sizes[index]);
	if (index == 0) {
		const uint8_t expected[] = { 42, 0, 0, 0, 0xff, 0xff, 0xff, 0xff };
		assert(!memcmp(data, expected, sizeof(expected)));
	} else if (index == 1) assert(!memcmp(data, &queue, sizeof(queue)));
	else assert(!memcmp(data, scalars[index - 2], sizeof(scalars[0])));
	bool fail = (int)index == backend.fail_key && pass < backend.setting_fail_passes;
	if (fail && backend.fail_mode == 0) return -EIO;
	backend.settings[index].size = size;
	copy_with_fault(backend.settings[index].data, data, size, fail);
	return fail ? -EIO : 0;
}

static int read_part(void *context, unsigned int slot, unsigned int part, void *data, size_t size)
{
	(void)context;
	assert(slot < TRACE_STORE_SLOTS && part <= TRACE_STORE_PARTS);
	struct trace_value *value = &backend.parts[slot][part];
	if (!value->size) return -ENOENT;
	if (value->size != size) return -EBADMSG;
	memcpy(data, value->data, size);
	return 0;
}

static int write_part(void *context, unsigned int slot, unsigned int part, const void *data, size_t size)
{
	(void)context;
	assert(slot < TRACE_STORE_SLOTS && part <= TRACE_STORE_PARTS && size <= TRACE_STORE_PART_SIZE);
	bool fail = ++backend.part_calls == backend.fail_part && backend.trace_attempts <= backend.trace_fail_passes;
	if (fail && backend.fail_mode == 0) return -EIO;
	struct trace_value *value = &backend.parts[slot][part];
	value->size = size;
	copy_with_fault(value->data, data, size, fail);
	return fail ? -EIO : 0;
}

static const struct trace_store_io trace_io = { NULL, read_part, write_part };

static int write_traces(void *context)
{
	(void)context;
	backend.trace_calls++;
	if (!backend.trace_dirty) return 0;
	backend.trace_attempts++;
	backend.part_calls = 0;
	int rc = trace_store_save(&store, &trace_io, &input);
	if (!rc) backend.trace_dirty = false;
	return rc;
}

static void retry_delay(void *context, uint32_t milliseconds)
{
	(void)context;
	assert(milliseconds == 1000 && backend.delays < 2);
	assert(backend.setting_calls == (backend.delays + 1) * SETTING_COUNT);
	backend.delays++;
}

static const struct sleep_flush_io io = { NULL, write_setting, write_traces, retry_delay };

static void collect(void *context, const struct stored_trace *trace)
{
	(void)context;
	received = *trace;
	restored_count++;
}

static void reset(void)
{
	memset(&backend, 0, sizeof(backend));
	backend.fail_key = -1;
	backend.trace_dirty = true;
	assert(!trace_store_load(&store, &trace_io, &scratch, NULL, NULL));
}

static void check_reboot(void)
{
	struct openfloat_shot_counters counters = { 0 };
	assert(openfloat_restore_shot_counters(&counters, backend.settings[0].data, backend.settings[0].size));
	assert(counters.count == 42 && counters.shot_id == UINT32_MAX);
	struct stored_shot_log restored;
	assert(shot_log_restore(&restored, backend.settings[1].data, backend.settings[1].size, backend.settings[1].size));
	assert(!memcmp(&restored, &queue, sizeof(queue)));
	for (unsigned int i = 2; i < SETTING_COUNT; i++) {
		assert(backend.settings[i].size == 4 && !memcmp(backend.settings[i].data, scalars[i - 2], 4));
	}
	struct trace_store reboot;
	restored_count = 0;
	assert(!trace_store_load(&reboot, &trace_io, &scratch, collect, NULL));
	assert(restored_count == 1 && !memcmp(&received, &input, sizeof(input)));
}

int main(void)
{
	shot_log_reset(&queue);
	struct stored_shot shot = { .shot_count = 41, .shot_id = UINT32_MAX,
		.ax_mg = -1200, .ay_mg = 250, .az_mg = 16000, .threshold_cg = 325,
		.roll_cdeg = -123, .pitch_cdeg = 456, .yaw_cdeg = -789, .clicker_dt_ms = 15 };
	assert(!shot_log_append(&queue, &shot));
	input.shot_id = UINT32_MAX;
	input.version = 1; input.flags = TRACE_HAS_TIMING;
	input.count = TRACE_CAPACITY; input.first_time_ms = -11000;
	for (unsigned int i = 0; i < TRACE_CAPACITY; i++) {
		input.points[i] = (struct trace_point){ .roll_cdeg = (int16_t)i - 500,
			.pitch_cdeg = 1000 - (int16_t)i, .yaw_cdeg = (int16_t)i,
			.mic_amp = (uint8_t)i, .dt_ms = i ? 19 : 0 };
	}
	reset();
	assert(!sleep_flush(&values, &io));
	assert(backend.setting_calls == 12 && backend.trace_calls == 1 && !backend.delays);
	check_reboot();
	for (unsigned int mode = 0; mode < 3; mode++) {
		for (int key = 0; key < SETTING_COUNT; key++) {
			reset(); backend.fail_key = key; backend.setting_fail_passes = 1; backend.fail_mode = mode;
			assert(!sleep_flush(&values, &io));
			assert(backend.setting_calls == 24 && backend.trace_calls == 2 && backend.delays == 1);
			check_reboot();
			reset(); backend.fail_key = key; backend.setting_fail_passes = 3; backend.fail_mode = mode;
			assert(sleep_flush(&values, &io) == -EIO);
			assert(backend.setting_calls == 36 && backend.trace_calls == 3 && backend.delays == 2);
			assert(!backend.trace_dirty); /* Another failed key did not skip the trace. */
		}
		for (unsigned int part = 1; part <= TRACE_STORE_PARTS * 2 + 2; part++) {
			reset(); backend.fail_part = part; backend.trace_fail_passes = 1; backend.fail_mode = mode;
			assert(!sleep_flush(&values, &io));
			assert(backend.trace_attempts == 2 && backend.delays == 1);
			check_reboot();
			reset(); backend.fail_part = part; backend.trace_fail_passes = 3; backend.fail_mode = mode;
			assert(sleep_flush(&values, &io) == -EIO);
			assert(backend.setting_calls == 36 && backend.trace_attempts == 3 && backend.delays == 2);
			assert(backend.trace_dirty);
		}
	}
	/* A trace that exhausted ordinary retries is still offered to shutdown. */
	reset(); backend.fail_part = 20; backend.trace_fail_passes = 3;
	for (unsigned int attempt = 0; attempt < 3; attempt++) assert(write_traces(NULL) == -EIO);
	assert(backend.trace_dirty);
	assert(!sleep_flush(&values, &io) && !backend.delays);
	assert(backend.trace_attempts == 4);
	check_reboot();
	/* Mixed failures may move between settings and traces across passes. */
	reset(); backend.fail_key = 0; backend.setting_fail_passes = 1;
	backend.fail_part = 20; backend.trace_fail_passes = 2;
	assert(!sleep_flush(&values, &io));
	assert(backend.setting_calls == 36 && backend.trace_attempts == 3 && backend.delays == 2);
	check_reboot();
	puts("Sleep flush: all 12 values, transient/permanent/torn faults at every setting and 34 trace writes, bounded retries, and reboot recovery passed.");
	return 0;
}
