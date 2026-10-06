#include "settings_retry.h"
#include "sleep_flush.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

static const char *const names[] = {
	"openfloat/shots", "openfloat/shotlog", "openfloat/wakesens", "openfloat/sleeptime",
	"openfloat/sleepsens", "openfloat/bufrate", "openfloat/bufnvs", "openfloat/autosleep",
	"openfloat/streamrate", "openfloat/followms", "openfloat/cant_offset", "openfloat/pitch_offset",
};
static struct settings_retry queue;
static struct stored_shot_log log;
static struct sleep_flush_values values;
static uint8_t saved[12][2804];
static unsigned int writes[12], fail_key, remaining_failures, failure_mode;

static uint32_t read32(const uint8_t *p)
{ return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static int write_value(void *context, const char *name, const void *data, size_t size)
{
	(void)context;
	unsigned int key = 0;
	while (key < 12 && strcmp(name, names[key])) key++;
	assert(key < 12 && size == (key == 0 ? 8u : (key == 1 ? 2804u : 4u)));
	writes[key]++;
	bool fail = key == fail_key && remaining_failures;
	if (fail) remaining_failures--;
	if (fail && failure_mode == 0) return -EIO;
	memcpy(saved[key], data, size);
	if (fail && failure_mode == 2) memset(saved[key] + size / 2, 0x5a, size - size / 2);
	return fail ? -EIO : 0;
}

static void check_saved(void)
{
	const int32_t expected[] = { 2500, 500000, 200, 104, 0, 1, 2, 2000, -8000, 2200 };
	for (unsigned int key = 2; key < 12; key++) assert(read32(saved[key]) == (uint32_t)expected[key - 2]);
	struct openfloat_shot_counters counter;
	assert(openfloat_restore_shot_counters(&counter, saved[0], 8));
	assert(counter.count == 43 && counter.shot_id == 90000);
	struct stored_shot_log restored;
	assert(shot_log_restore(&restored, saved[1], 2804, 2804));
	assert(restored.count == 1 && restored.shots[0].shot_id == 90000 && restored.shots[0].ax_mg == -12000);
	assert(!memcmp(&restored, &log, sizeof(log)));
}

static void drain(uint32_t now)
{
	unsigned int steps = 0;
	while (queue.pending_mask) {
		assert(++steps <= 36);
		uint32_t token;
		int key = settings_retry_take(&queue, now, &token);
		if (key < 0) {
			uint32_t delay = settings_retry_delay(&queue, now);
			assert(delay > 0 && delay <= 1000);
			now += delay;
			key = settings_retry_take(&queue, now, &token);
		}
		assert(key >= 0);
		int rc = settings_retry_save(key, &values, write_value, NULL);
		settings_retry_finish(&queue, key, token, rc, now);
	}
	assert(settings_retry_delay(&queue, now) == UINT32_MAX);
}

static void check_queue(void)
{
	uint32_t token;
	assert(settings_retry_take(&queue, 0, &token) == -1);
	assert(settings_retry_delay(&queue, 0) == UINT32_MAX);
	for (unsigned int key = 0; key < 12; key++) {
		queue = (struct settings_retry){ 0 };
		for (unsigned int update = 0; update < 1000; update++) settings_retry_request(&queue, UINT32_C(1) << key, update);
		assert(settings_retry_take(&queue, 999, &token) == (int)key && token == 1000 && queue.attempts[key] == 1);
		settings_retry_finish(&queue, key, token, 0, 999);
		assert(!queue.pending_mask && !queue.failed_mask);
		settings_retry_request(&queue, UINT32_C(1) << key, 1000);
		assert(settings_retry_take(&queue, 1000, &token) == (int)key);
		settings_retry_finish(&queue, key, token, -EIO, 1100);
		assert(settings_retry_delay(&queue, 1100) == 1000);
		assert(settings_retry_take(&queue, 2099, &token) == -1);
		assert(settings_retry_take(&queue, 2100, &token) == (int)key && queue.attempts[key] == 2);
		settings_retry_finish(&queue, key, token, -EIO, 2200);
		assert(settings_retry_take(&queue, 3200, &token) == (int)key && queue.attempts[key] == 3);
		settings_retry_finish(&queue, key, token, -EIO, 3300);
		assert(!queue.pending_mask && queue.failed_mask == (UINT32_C(1) << key));
		assert(settings_retry_take(&queue, 999999, &token) == -1);
		settings_retry_request(&queue, UINT32_C(1) << key, 999999);
		assert(!queue.failed_mask && settings_retry_take(&queue, 999999, &token) == (int)key && queue.attempts[key] == 1);
		settings_retry_finish(&queue, key, token, 0, 999999);
	}
	/* Unrelated ready keys run during a failure's backoff. */
	queue = (struct settings_retry){ 0 };
	settings_retry_request(&queue, 1, 0);
	assert(settings_retry_take(&queue, 0, &token) == 0);
	settings_retry_finish(&queue, 0, token, -EIO, 0);
	for (unsigned int key = 1; key < 12; key++) {
		settings_retry_request(&queue, UINT32_C(1) << key, 100);
		assert(settings_retry_take(&queue, 100, &token) == (int)key);
		settings_retry_finish(&queue, key, token, 0, 100);
	}
	assert(settings_retry_delay(&queue, 100) == 900 && settings_retry_take(&queue, 999, &token) == -1);
	/* Continuous replacement of one in-flight request cannot starve others. */
	queue = (struct settings_retry){ 0 };
	settings_retry_request(&queue, SETTINGS_ALL, 0);
	for (unsigned int step = 0; step < 600; step++) {
		int key = settings_retry_take(&queue, 0, &token);
		assert(key == (int)(step % 12));
		settings_retry_request(&queue, UINT32_C(1) << key, 0);
		struct settings_retry before;
		memcpy(&before, &queue, sizeof(before));
		settings_retry_finish(&queue, key, token, step % 2 ? 0 : -EIO, 0);
		assert(!memcmp(&before, &queue, sizeof(queue)));
	}
	/* Both token and deadline wrap, independently. */
	queue = (struct settings_retry){ 0 };
	queue.token[0] = UINT32_MAX;
	settings_retry_request(&queue, 1, UINT32_MAX - 500);
	assert(settings_retry_take(&queue, UINT32_MAX - 500, &token) == 0 && token == 0);
	settings_retry_finish(&queue, 0, token, -EIO, UINT32_MAX - 500);
	assert(settings_retry_delay(&queue, 498) == 1 && settings_retry_take(&queue, 498, &token) == -1);
	assert(settings_retry_take(&queue, 499, &token) == 0);
	settings_retry_finish(&queue, 0, token, 0, 499);
	assert(!queue.pending_mask && !queue.failed_mask);
	settings_retry_request(&queue, SETTINGS_ALL, 500);
	settings_retry_settle(&queue, SETTING_SHOTS, -EIO);
	assert(!(queue.pending_mask & 1) && (queue.failed_mask & 1));
	settings_retry_settle(&queue, SETTING_SHOTLOG, 0);
	assert(!(queue.pending_mask & 2));
	settings_retry_settle(&queue, SETTING_SHOTS, 0);
	assert(!queue.failed_mask && queue.pending_mask == (SETTINGS_ALL & ~UINT32_C(3)));
}

int main(void)
{
	check_queue();
	shot_log_reset(&log);
	struct stored_shot shot = { .shot_id = 90000, .ax_mg = -12000 };
	assert(!shot_log_append(&log, &shot));
	values = (struct sleep_flush_values){ .counters = { 43, 90000 }, .queue = &log,
		.wakesens = 2500, .sleeptime = 500000, .sleepsens = 200, .bufrate = 104,
		.bufnvs = 0, .autosleep = 1, .streamrate = 2, .followms = 2000,
		.cant_offset = -8000, .pitch_offset = 2200 };
	for (fail_key = 0; fail_key < 12; fail_key++) {
		for (failure_mode = 0; failure_mode < 3; failure_mode++) {
			for (unsigned int failures = 1; failures <= 3; failures++) {
				queue = (struct settings_retry){ 0 };
				memset(writes, 0, sizeof(writes));
				remaining_failures = failures;
				settings_retry_request(&queue, SETTINGS_ALL, 0);
				drain(0);
				for (unsigned int key = 0; key < 12; key++) assert(writes[key] == (key == fail_key ? (failures < 3 ? failures + 1 : 3) : 1));
				assert(queue.failed_mask == (failures == 3 ? (UINT32_C(1) << fail_key) : 0));
				if (failures == 3) {
					settings_retry_request(&queue, UINT32_C(1) << fail_key, 10000);
					drain(10000);
				}
				check_saved();
			}
		}
	}
	puts("Settings retry checks passed: all 12 layouts, 108 write-fault cases, bounded independent deadlines, coalescing/fairness, stale results, clock/token wrap, and recovery after exhaustion.");
	return 0;
}
