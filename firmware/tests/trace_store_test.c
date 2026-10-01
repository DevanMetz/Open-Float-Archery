#include "trace_store.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

struct value {
	size_t size;
	uint8_t data[TRACE_STORE_PART_SIZE];
};

struct backend {
	struct value values[TRACE_STORE_SLOTS][TRACE_STORE_PARTS + 1];
	unsigned int writes, fail_at, fail_mode;
	bool read_error;
};

static struct backend storage, baseline;
static struct stored_trace input, scratch, received[TRACE_STORE_SLOTS];
static unsigned int received_count;
static struct trace_store store;

static int read_value(void *context, unsigned int slot, unsigned int part, void *data, size_t size)
{
	struct backend *backend = context;
	assert(slot < TRACE_STORE_SLOTS && part <= TRACE_STORE_PARTS);
	if (backend->read_error) return -EIO;
	struct value *value = &backend->values[slot][part];
	if (!value->size) return -ENOENT;
	if (value->size != size) return -EBADMSG;
	memcpy(data, value->data, size);
	return 0;
}

static int write_value(void *context, unsigned int slot, unsigned int part, const void *data, size_t size)
{
	struct backend *backend = context;
	assert(slot < TRACE_STORE_SLOTS && part <= TRACE_STORE_PARTS);
	assert(size <= TRACE_STORE_PART_SIZE);
	bool fail = ++backend->writes == backend->fail_at;
	if (fail && backend->fail_mode == 0) return -EIO; /* Nothing committed. */
	struct value *value = &backend->values[slot][part];
	value->size = size;
	if (size) {
		if (fail && backend->fail_mode == 2) {
			memcpy(value->data, data, size / 2); /* Corrupted/torn value. */
			memset(value->data + size / 2, 0x5a, size - size / 2);
		} else memcpy(value->data, data, size);
	}
	return fail ? -EIO : 0; /* Mode 1 commits, then reports an error. */
}

static const struct trace_store_io io = {
	.context = &storage, .read = read_value, .write = write_value,
};

static void collect(void *context, const struct stored_trace *trace)
{
	(void)context;
	assert(received_count < TRACE_STORE_SLOTS);
	received[received_count++] = *trace;
}

static void load(struct trace_store *dest)
{
	received_count = 0;
	assert(!trace_store_load(dest, &io, &scratch, collect, NULL));
	assert(dest->ready);
}

static void make_trace(uint32_t id, uint16_t count)
{
	memset(&input, 0, sizeof(input));
	input.shot_id = id;
	input.version = 1;
	input.flags = TRACE_HAS_TIMING;
	input.count = count;
	input.first_time_ms = -7600 + (int32_t)id;
	for (uint16_t i = 0; i < count; i++) {
		input.points[i] = (struct trace_point){ .roll_cdeg = (int16_t)(id * 31 + i),
			.pitch_cdeg = -(int16_t)(id * 17 + i), .yaw_cdeg = (int16_t)(i * 3),
			.mic_amp = (uint8_t)(i + id), .dt_ms = i ? (uint8_t)(1 + i % 19) : 0 };
	}
}

static bool check_trace(uint32_t id, uint16_t count)
{
	for (unsigned int i = 0; i < received_count; i++) {
		if (received[i].shot_id != id) continue;
		make_trace(id, count);
		assert(!memcmp(&received[i], &input, sizeof(input)));
		return true;
	}
	return false;
}

int main(void)
{
	load(&store);
	assert(!received_count);
	make_trace(1, TRACE_CAPACITY);
	struct trace_store unready = { 0 };
	assert(trace_store_save(&unready, &io, &input) == -EACCES);
	for (uint32_t id = 1; id <= TRACE_STORE_SLOTS; id++) {
		make_trace(id, TRACE_CAPACITY);
		assert(!trace_store_save(&store, &io, &input));
	}
	load(&store);
	assert(received_count == TRACE_STORE_SLOTS);
	for (uint32_t id = 1; id <= TRACE_STORE_SLOTS; id++) {
		assert(received[id - 1].shot_id == id && check_trace(id, TRACE_CAPACITY));
	}
	baseline = storage;
	/* Every key operation: invalidate, clear staging, write pieces, then commit.
	 * Reboot after an error before/after/torn write. No recovered record may
	 * combine generations, and the other three full captures must survive. */
	unsigned int failures = 0;
	for (unsigned int mode = 0; mode < 3; mode++) {
		for (unsigned int at = 1; at <= TRACE_STORE_PARTS * 2 + 2; at++) {
			storage = baseline;
			load(&store);
			storage.writes = 0;
			storage.fail_at = at;
			storage.fail_mode = mode;
			make_trace(TRACE_STORE_SLOTS + 1, TRACE_CAPACITY);
			assert(trace_store_save(&store, &io, &input) == -EIO);
			struct trace_store reboot;
			load(&reboot);
			assert(received_count == TRACE_STORE_SLOTS - 1 || received_count == TRACE_STORE_SLOTS);
			for (uint32_t id = 2; id <= TRACE_STORE_SLOTS; id++) assert(check_trace(id, TRACE_CAPACITY));
			for (unsigned int i = 0; i < received_count; i++) {
				assert(received[i].shot_id >= 1 && received[i].shot_id <= TRACE_STORE_SLOTS + 1);
				assert(check_trace(received[i].shot_id, TRACE_CAPACITY));
			}
			assert(!check_trace(TRACE_STORE_SLOTS + 1, TRACE_CAPACITY) || (mode == 1 && at == TRACE_STORE_PARTS * 2 + 2));
			/* A live retry reuses staging even if a commit returned an error. */
			storage.fail_at = 0;
			make_trace(TRACE_STORE_SLOTS + 1, TRACE_CAPACITY);
			assert(!trace_store_save(&store, &io, &input));
			load(&store);
			assert(received_count == TRACE_STORE_SLOTS && !check_trace(1, TRACE_CAPACITY));
			for (uint32_t id = 2; id <= TRACE_STORE_SLOTS + 1; id++) assert(check_trace(id, TRACE_CAPACITY));
			failures++;
		}
	}
	/* Every stored part and manifest is integrity protected, including IDs and
	 * generation. Wrong lengths, missing parts, and extra old tails are rejected. */
	unsigned int corruptions = 0;
	for (unsigned int part = 0; part <= TRACE_STORE_PARTS; part++) {
		for (unsigned int kind = 0; kind < 3; kind++) {
			storage = baseline;
			struct value *value = &storage.values[0][part];
			if (kind == 0) value->data[part == TRACE_STORE_PARTS ? 4 : 0] ^= 0x40;
			else if (kind == 1) value->size--;
			else value->size = 0;
			load(&store);
			assert(received_count == TRACE_STORE_SLOTS - 1 && !check_trace(1, TRACE_CAPACITY));
			for (uint32_t id = 2; id <= TRACE_STORE_SLOTS; id++) assert(check_trace(id, TRACE_CAPACITY));
			corruptions++;
		}
	}
	storage = baseline;
	/* A corrupt generation close to the half-range sequence boundary must be
	 * rejected before sorting valid records, not merely before their callback. */
	uint8_t *manifest = storage.values[0][TRACE_STORE_MANIFEST_PART].data;
	manifest[4] = 3; manifest[5] = 0; manifest[6] = 0; manifest[7] = 0x80;
	load(&store);
	assert(received_count == TRACE_STORE_SLOTS - 1);
	for (unsigned int i = 0; i < received_count; i++) assert(received[i].shot_id == i + 2);
	storage = baseline;
	load(&store);
	/* Variable-sized writes reuse a slot containing a full trace. Its stale
	 * unused keys cannot add points to the shorter record on boot. */
	make_trace(TRACE_STORE_SLOTS + 1, 1);
	assert(!trace_store_save(&store, &io, &input));
	load(&store);
	assert(check_trace(TRACE_STORE_SLOTS + 1, 1));
	for (uint32_t id = TRACE_STORE_SLOTS + 2; id <= 40; id++) {
		make_trace(id, id % 2 ? 333 : TRACE_CAPACITY);
		assert(!trace_store_save(&store, &io, &input));
		load(&store);
		assert(received_count == TRACE_STORE_SLOTS && check_trace(id, id % 2 ? 333 : TRACE_CAPACITY));
		assert(received[0].shot_id == id - TRACE_STORE_SLOTS + 1 && received[TRACE_STORE_SLOTS - 1].shot_id == id);
	}
	/* A reset count can reuse an ID. Restoration order must let the newer
	 * record win, and untimed migrated points remain explicitly untimed. */
	make_trace(40, 2);
	input.flags = 0;
	input.first_time_ms = 0;
	input.points[1].dt_ms = 0;
	assert(!trace_store_save(&store, &io, &input));
	load(&store);
	assert(received[TRACE_STORE_SLOTS - 1].shot_id == 40 && received[TRACE_STORE_SLOTS - 1].count == 2 && !received[TRACE_STORE_SLOTS - 1].flags);
	assert(!memcmp(&received[TRACE_STORE_SLOTS - 1], &input, sizeof(input)));
	unsigned int before = storage.writes;
	input.count = 0;
	assert(trace_store_save(&store, &io, &input) == -EINVAL);
	input.count = TRACE_CAPACITY + 1;
	assert(trace_store_save(&store, &io, &input) == -EINVAL);
	input.count = 1;
	input.version = 2;
	assert(trace_store_save(&store, &io, &input) == -EINVAL);
	input.version = 1;
	input.flags = 0x80;
	assert(trace_store_save(&store, &io, &input) == -EINVAL);
	input.flags = TRACE_HAS_TIMING;
	input.points[0].dt_ms = 1;
	assert(trace_store_save(&store, &io, &input) == -EINVAL);
	assert(storage.writes == before);
	storage.read_error = true;
	assert(trace_store_load(&store, &io, &scratch, collect, NULL) == -EIO);
	assert(!store.ready);
	printf("Trace storage checks passed: %u interrupted writes, %u corrupt/missing values, retention, retry, short records, reused IDs, and validation.\n", failures, corruptions);
	return 0;
}
