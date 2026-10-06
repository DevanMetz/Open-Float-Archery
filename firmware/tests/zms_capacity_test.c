/* Capacity/GC check against the SDK's unchanged ZMS implementation.
 * Index entries reserve more space than Settings' actual names/linked nodes.
 * The flash shim models byte-alterable RRAM, not hardware timing or power loss. */
#include "trace_store.h"
#include "shot_log.h"
#include "sleep_flush.h"
#include <zephyr/fs/zms.h>
#include <stdio.h>
#include <errno.h>

static uint8_t rram[65536];
static const struct device device;
static const struct flash_parameters parameters = { 16, 0xff };
static struct zms_fs fs;
static struct stored_trace input, scratch;
static uint32_t restored_id[TRACE_STORE_SLOTS];
static unsigned int restored_count;
static uint8_t shotlog[sizeof(struct stored_shot_log)];
static unsigned int flash_writes, flash_erases;

const struct flash_parameters *flash_get_parameters(const struct device *dev)
{
	(void)dev;
	return &parameters;
}

int flash_get_page_info_by_offs(const struct device *dev, off_t offset, struct flash_pages_info *info)
{
	(void)dev;
	(void)offset;
	info->size = 4096;
	return 0;
}

int flash_read(const struct device *dev, off_t offset, void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	memcpy(data, rram + offset, size);
	return 0;
}

int flash_write(const struct device *dev, off_t offset, const void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram) && offset % 16 == 0 && size % 16 == 0);
	flash_writes++;
	memcpy(rram + offset, data, size);
	return 0;
}

int flash_erase(const struct device *dev, off_t offset, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	flash_erases++;
	memset(rram + offset, 0xff, size);
	return 0;
}

static uint32_t key(unsigned int slot, unsigned int part)
{
	return 1000 + slot * 100 + part * 3;
}

static int read_value(void *context, unsigned int slot, unsigned int part, void *data, size_t size)
{
	(void)context;
	ssize_t length = zms_get_data_length(&fs, key(slot, part));
	if (length < 0) return (int)length;
	if ((size_t)length != size) return -EBADMSG;
	ssize_t rc = zms_read(&fs, key(slot, part), data, size);
	return rc < 0 ? (int)rc : ((size_t)rc == size ? 0 : -EBADMSG);
}

static int write_value(void *context, unsigned int slot, unsigned int part, const void *data, size_t size)
{
	(void)context;
	ssize_t rc = zms_write(&fs, key(slot, part), data, size);
	return rc < 0 ? (int)rc : 0;
}

static const struct trace_store_io io = { NULL, read_value, write_value };

static void collect(void *context, const struct stored_trace *trace)
{
	(void)context;
	assert(restored_count < TRACE_STORE_SLOTS);
	restored_id[restored_count++] = trace->shot_id;
	assert(trace->count == TRACE_CAPACITY && trace->points[999].roll_cdeg == (int16_t)(trace->shot_id + 999));
}

static void remount(void)
{
	memset(&fs, 0, sizeof(fs));
	fs.flash_device = &device;
	fs.sector_size = 4096;
	fs.sector_count = 16;
	assert(!zms_mount(&fs));
}

static void check_live_ack_writes(void)
{
	struct stored_shot_log log;
	struct stored_shot shot;
	shot_log_reset(&log);
	assert(zms_write(&fs, 102, &log, sizeof(log)) == sizeof(log));
	unsigned int writes = flash_writes, erases = flash_erases;
	/* Padding varies too, as it can in stack-allocated shot records. */
	for (uint32_t i = 0; i < 100; i++) {
		memset(&shot, (int)(i + 1), sizeof(shot));
		shot.shot_id = 70000 + i;
		shot.shot_count = (uint16_t)i;
		assert(!shot_log_append(&log, &shot));
		assert(shot_log_remove(&log, shot.shot_id));
		/* The ack's persist job still runs; identical empty bytes suppress writes. */
		assert(zms_write(&fs, 102, &log, sizeof(log)) == 0);
		assert(flash_writes == writes && flash_erases == erases);
	}
	/* A missed live frame and its subsequent acknowledgment must change storage. */
	shot.shot_id = UINT32_MAX;
	assert(!shot_log_append(&log, &shot));
	assert(zms_write(&fs, 102, &log, sizeof(log)) == sizeof(log));
	assert(flash_writes > writes);
	writes = flash_writes;
	remount();
	assert(zms_read(&fs, 102, shotlog, sizeof(shotlog)) == sizeof(shotlog));
	assert(shot_log_restore(&log, shotlog, sizeof(shotlog), sizeof(shotlog)));
	assert(log.count == 1 && log.shots[0].shot_id == UINT32_MAX);
	assert(shot_log_remove(&log, UINT32_MAX));
	assert(zms_write(&fs, 102, &log, sizeof(log)) == sizeof(log));
	assert(flash_writes > writes);
	remount();
	assert(zms_read(&fs, 102, shotlog, sizeof(shotlog)) == sizeof(shotlog));
	for (size_t i = 0; i < sizeof(shotlog); i++) assert(!shotlog[i]);
	writes = flash_writes; erases = flash_erases;
	assert(zms_write(&fs, 102, &log, sizeof(log)) == 0);
	assert(flash_writes == writes && flash_erases == erases);
	puts("SDK ZMS live-ack check passed: 100 drained queues added zero flash writes/erases; persisted backlog and acknowledgment survived remounts.");
}

struct sleep_model {
	struct trace_store *store;
	struct trace_persist_queue queue;
};

static int sleep_write_setting(void *context, const char *name, const void *data, size_t size)
{
	(void)context;
	static const char *const names[] = {
		"openfloat/shots", "openfloat/shotlog", "openfloat/wakesens", "openfloat/sleeptime",
		"openfloat/sleepsens", "openfloat/bufrate", "openfloat/bufnvs", "openfloat/autosleep",
		"openfloat/streamrate", "openfloat/followms", "openfloat/cant_offset", "openfloat/pitch_offset",
	};
	for (unsigned int i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
		if (strcmp(name, names[i])) continue;
		/* Reuse the ordinary values reserved by the capacity test, plus the log. */
		ssize_t rc = zms_write(&fs, i == 1 ? 102 : 10 + i * 3, data, size);
		return rc < 0 ? (int)rc : 0;
	}
	assert(false);
	return -EINVAL;
}

static int sleep_write_traces(void *context)
{
	struct sleep_model *model = context;
	uint32_t token;
	int slot = trace_persist_take(&model->queue, UINT32_MAX, true, &token);
	if (slot < 0) return 0;
	int rc = trace_store_save(model->store, &io, &input);
	(void)trace_persist_finish(&model->queue, slot, token, rc);
	return rc;
}

static void sleep_retry_delay(void *context, uint32_t milliseconds)
{
	(void)context; (void)milliseconds;
	assert(false); /* This capacity scenario must fit without a save error. */
}

static void check_sleep_flush(struct trace_store *store)
{
	struct stored_shot_log log;
	shot_log_reset(&log);
	struct stored_shot shot = { .shot_count = 101, .shot_id = 70000 };
	assert(!shot_log_append(&log, &shot));
	const struct sleep_flush_values values = {
		.counters = { 101, 70000 }, .queue = &log,
		.wakesens = 2000, .sleeptime = 300000, .sleepsens = 150,
		.bufrate = 52, .bufnvs = 1, .autosleep = 1, .streamrate = 1, .followms = 1500,
		.cant_offset = -1234, .pitch_offset = 5678,
	};
	input.shot_id = 70000;
	for (unsigned int i = 0; i < TRACE_CAPACITY; i++) input.points[i].roll_cdeg = (int16_t)(input.shot_id + i);
	struct sleep_model model = { .store = store };
	trace_persist_ready(&model.queue, input.shot_id % TRACE_RAM_SLOTS);
	const struct sleep_flush_io sink = { &model, sleep_write_setting, sleep_write_traces, sleep_retry_delay };
	assert(!sleep_flush(&values, &sink));
	assert(!model.queue.pending_mask && !model.queue.failed_mask);
	remount();
	struct openfloat_shot_counters counters;
	assert(zms_read(&fs, 10, &counters, sizeof(counters)) == sizeof(counters));
	assert(counters.count == 101 && counters.shot_id == 70000);
	assert(zms_read(&fs, 102, shotlog, sizeof(shotlog)) == sizeof(shotlog));
	assert(shot_log_restore(&log, shotlog, sizeof(shotlog), sizeof(shotlog)));
	assert(log.count == 1 && log.shots[0].shot_id == 70000);
	struct trace_store reboot;
	restored_count = 0;
	assert(!trace_store_load(&reboot, &io, &scratch, collect, NULL));
	assert(restored_count == TRACE_STORE_SLOTS && restored_id[TRACE_STORE_SLOTS - 1] == 70000);
	unsigned int writes = flash_writes, erases = flash_erases;
	assert(!sleep_flush(&values, &sink));
	assert(flash_writes == writes && flash_erases == erases);
	puts("SDK ZMS sleep flush passed after GC stress: counter, backlog, and full trace survived remount; unchanged flush added zero writes/erases.");
}

int main(void)
{
	memset(rram, 0xff, sizeof(rram));
	remount();
	assert(zms_write(&fs, 1, &input, sizeof(input)) == -EINVAL);
	uint8_t name[32] = { 0 };
	uint64_t link = 0;
	/* All bounded trace keys reserve 32-byte names (actual maximum 16),
	 * an eight-byte linked node, and separately written trace values. */
	for (unsigned int slot = 0; slot < TRACE_STORE_SLOTS; slot++) {
		for (unsigned int part = 0; part <= TRACE_STORE_PARTS; part++) {
			uint32_t id = key(slot, part);
			link = id;
			assert(zms_write(&fs, id + 1, name, sizeof(name)) >= 0);
			assert(zms_write(&fs, id + 2, &link, sizeof(link)) >= 0);
		}
	}
	/* Ordinary settings, two linked-list markers, and a maximum 100-shot log. */
	for (uint32_t i = 0; i < 14; i++) {
		assert(zms_write(&fs, 10 + i * 3, &link, 4) >= 0);
		assert(zms_write(&fs, 11 + i * 3, name, sizeof(name)) >= 0);
		assert(zms_write(&fs, 12 + i * 3, &link, sizeof(link)) >= 0);
	}
	assert(zms_write(&fs, 100, &link, sizeof(link)) >= 0);
	assert(zms_write(&fs, 101, &link, sizeof(link)) >= 0);
	assert(zms_write(&fs, 102, shotlog, sizeof(shotlog)) >= 0);
	struct trace_store store;
	assert(!trace_store_load(&store, &io, &scratch, NULL, NULL));
	for (uint32_t shot = 1; shot <= 100; shot++) {
		memset(&input, 0, sizeof(input));
		input.shot_id = shot;
		input.version = 1;
		input.flags = TRACE_HAS_TIMING;
		input.count = TRACE_CAPACITY;
		for (unsigned int i = 0; i < TRACE_CAPACITY; i++) {
			input.points[i].roll_cdeg = (int16_t)(shot + i);
			input.points[i].dt_ms = i ? 19 : 0;
		}
		int rc = trace_store_save(&store, &io, &input);
		if (rc) {
			fprintf(stderr, "ZMS save %u failed: %d, free=%lld\n", shot, rc, (long long)zms_calc_free_space(&fs));
			return 1;
		}
		/* Stress additional shot-log and linked-list churn through actual GC. */
		shotlog[0] = (uint8_t)shot;
		link = shot;
		assert(zms_write(&fs, 102, shotlog, sizeof(shotlog)) >= 0);
		assert(zms_write(&fs, 101, &link, sizeof(link)) >= 0);
		remount();
		restored_count = 0;
		assert(!trace_store_load(&store, &io, &scratch, collect, NULL));
		unsigned int expected = shot < TRACE_STORE_SLOTS ? shot : TRACE_STORE_SLOTS;
		assert(restored_count == expected);
		for (unsigned int i = 0; i < expected; i++) assert(restored_id[i] == shot - expected + 1 + i);
		uint8_t check[sizeof(shotlog)];
		assert(zms_read(&fs, 102, check, sizeof(check)) == sizeof(check) && !memcmp(shotlog, check, sizeof(check)));
	}
	printf("SDK ZMS capacity/GC passed: 100 full traces, 100 shot-log updates, 100 remounts, 64 KB partition; free=%lld bytes.\n", (long long)zms_calc_free_space(&fs));
	check_live_ack_writes();
	check_sleep_flush(&store);
	return 0;
}
