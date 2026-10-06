/* SPDX-License-Identifier: Apache-2.0 */
#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "shot_log.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Frozen little-endian records from each persisted layout. Nonzero padding in
 * the current record verifies that migration never treats padding as a field.
 */
static const uint8_t current[][28] = {
	{0xff, 0xff, 0xa5, 0x5a, 0x98, 0xba, 0xdc, 0xfe, 0x50, 0xfb, 0xfa, 0x00,
	 0x80, 0x3e, 0x45, 0x01, 0x85, 0xff, 0xc8, 0x01, 0xeb, 0xfc, 0x0f, 0x00,
	 0xff, 0xff, 0xcc, 0xdd},
	{0x00, 0x00, 0xa5, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0xff, 0x7f,
	 0xff, 0xff, 0xb8, 0x0b, 0x00, 0x00, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x00,
	 0x00, 0x00, 0xcc, 0xdd},
};
static const uint8_t legacy[][22] = {
	{0xff, 0xff, 0x98, 0xba, 0x50, 0xfb, 0xfa, 0x00, 0x80, 0x3e, 0x45, 0x01,
	 0x85, 0xff, 0xc8, 0x01, 0xeb, 0xfc, 0x0f, 0x00, 0xff, 0xff},
	{0x00, 0x00, 0xff, 0xff, 0x00, 0x80, 0xff, 0x7f, 0xff, 0xff, 0xb8, 0x0b,
	 0x00, 0x00, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x00},
};

static void assert_shot(const struct stored_shot *shot, unsigned index, bool wide, bool timing)
{
	if (!index) {
		assert(shot->shot_count == 65535);
		assert(shot->shot_id == (wide ? UINT32_C(0xfedcba98) : UINT32_C(0xba98)));
		assert(shot->ax_mg == -1200 && shot->ay_mg == 250 && shot->az_mg == 16000);
		assert(shot->threshold_cg == 325);
		assert(shot->roll_cdeg == -123 && shot->pitch_cdeg == 456 && shot->yaw_cdeg == -789);
		assert(shot->clicker_dt_ms == (timing ? 15 : 0));
		assert(shot->impact_dt_ms == (timing ? 65535 : 0));
	} else {
		assert(shot->shot_count == 0 && shot->shot_id == (wide ? 0 : 65535));
		assert(shot->ax_mg == INT16_MIN && shot->ay_mg == INT16_MAX && shot->az_mg == -1);
		assert(shot->threshold_cg == 3000);
		assert(shot->roll_cdeg == 0 && shot->pitch_cdeg == INT16_MIN && shot->yaw_cdeg == INT16_MAX);
		assert(shot->clicker_dt_ms == 0 && shot->impact_dt_ms == 0);
	}
	const uint8_t *raw = (const uint8_t *)shot;
	assert(!raw[2] && !raw[3] && !raw[26] && !raw[27]);
}

static void assert_unused_cleared(const struct stored_shot_log *log)
{
	const uint8_t *raw = (const uint8_t *)log;
	assert(!raw[2] && !raw[3]);
	const uint8_t *tail = (const uint8_t *)&log->shots[log->count];
	size_t size = (STORED_SHOT_CAPACITY - log->count) * sizeof(log->shots[0]);
	for (size_t i = 0; i < size; i++) assert(!tail[i]);
}

static void check_queue_mutations(void)
{
	const uint8_t empty[sizeof(struct stored_shot_log)] = { 0 };
	struct stored_shot_log log, before;
	struct stored_shot shot;
	memset(&log, 0xa5, sizeof(log));
	shot_log_reset(&log);
	assert(!memcmp(&log, empty, sizeof(log)));
	memcpy(&shot, current[0], sizeof(shot));
	assert(!shot_log_append(&log, &shot));
	assert(log.count == 1);
	assert_shot(&log.shots[0], 0, true, true);
	assert_unused_cleared(&log);
	assert(!memcmp(&shot, current[0], sizeof(shot)));
	memcpy(&before, &log, sizeof(log));
	assert(!shot_log_remove(&log, UINT32_MAX));
	assert(!memcmp(&log, &before, sizeof(log)));
	assert(shot_log_remove(&log, shot.shot_id));
	assert(!memcmp(&log, empty, sizeof(log)));

	const uint32_t ids[] = { 0, 1, 65536, UINT32_MAX, 70000 };
	for (unsigned i = 0; i < sizeof(ids) / sizeof(ids[0]); i++) {
		shot.shot_id = ids[i];
		assert(!shot_log_append(&log, &shot));
		assert_unused_cleared(&log);
	}
	assert(shot_log_remove(&log, 65536)); /* Matches the full ID, not ID zero. */
	assert(log.count == 4 && log.shots[0].shot_id == 0 && log.shots[1].shot_id == 1 &&
	       log.shots[2].shot_id == UINT32_MAX && log.shots[3].shot_id == 70000);
	assert_unused_cleared(&log);
	memcpy(&before, &log, sizeof(log));
	assert(!shot_log_remove(&log, 65536));
	assert(!memcmp(&log, &before, sizeof(log)));
	assert(shot_log_remove(&log, 0));
	assert(log.count == 3 && log.shots[0].shot_id == 1 && log.shots[1].shot_id == UINT32_MAX &&
	       log.shots[2].shot_id == 70000);
	assert_unused_cleared(&log);
	assert(shot_log_remove(&log, 70000));
	assert(log.count == 2 && log.shots[0].shot_id == 1 && log.shots[1].shot_id == UINT32_MAX);
	assert_unused_cleared(&log);
	assert(shot_log_remove(&log, UINT32_MAX));
	assert(log.count == 1 && log.shots[0].shot_id == 1);
	assert_unused_cleared(&log);
	assert(shot_log_remove(&log, 1));
	assert(!memcmp(&log, empty, sizeof(log)));

	for (uint32_t i = 0; i < STORED_SHOT_CAPACITY; i++) {
		shot.shot_id = 65536 + i;
		assert(!shot_log_append(&log, &shot));
	}
	shot.shot_id = UINT32_MAX;
	assert(shot_log_append(&log, &shot));
	assert(log.count == STORED_SHOT_CAPACITY);
	for (unsigned i = 0; i < STORED_SHOT_CAPACITY - 1; i++) {
		assert(log.shots[i].shot_id == 65537 + i && log.shots[i].ax_mg == -1200);
	}
	assert(log.shots[99].shot_id == UINT32_MAX);
	assert_unused_cleared(&log);
	/* Source aliases the first record that will be evicted. */
	assert(shot_log_append(&log, &log.shots[0]));
	assert(log.shots[0].shot_id == 65538 && log.shots[98].shot_id == UINT32_MAX &&
	       log.shots[99].shot_id == 65537);
	assert(shot_log_remove(&log, UINT32_MAX));
	assert_unused_cleared(&log);
	shot_log_reset(&log);
	assert(!memcmp(&log, empty, sizeof(log)));
	for (uint32_t i = 0; i < 1000; i++) {
		shot.shot_id = 70000 + i;
		shot.shot_count = (uint16_t)i;
		assert(!shot_log_append(&log, &shot));
		assert(shot_log_remove(&log, shot.shot_id));
		assert(!memcmp(&log, empty, sizeof(log)));
	}
}

static void emit(FILE *output, const struct stored_shot *shot)
{
	uint8_t frame[STORED_SHOT_FRAME_SIZE];
	memset(frame, 0xa5, sizeof(frame));
	shot_log_build_frame(shot, frame);
	assert(frame[0] == 'O' && frame[1] == 'F' && frame[2] == 1 && frame[3] == 4);
	assert(!frame[28]);
	assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	FILE *output = fopen(argv[1], "wb");
	assert(output);
	const size_t layouts[] = {sizeof(struct stored_shot_log), SHOT_LOG_LEGACY_TIMED_SIZE, SHOT_LOG_LEGACY_SIZE};
	uint8_t storage[sizeof(struct stored_shot_log) + 2];
	uint8_t *bytes = storage + 1; /* Deliberately unaligned input. */
	struct stored_shot_log log, before;
	for (unsigned format = 0; format < 3; format++) {
		size_t size = layouts[format], header = format == 0 ? 4 : 2;
		size_t stride = format == 0 ? 28 : format == 1 ? 22 : 18;
		assert(shot_log_valid_storage_size(size));
		memset(bytes, 0xcc, size);
		bytes[0] = 2; bytes[1] = 0;
		for (unsigned i = 0; i < 2; i++) {
			memcpy(bytes + header + i * stride, format == 0 ? current[i] : legacy[i], stride);
		}
		memset(&log, 0xa5, sizeof(log));
		log.count = 1; log.shots[0].shot_id = 70000;
		memcpy(&before, &log, sizeof(log));
		/* Includes zero, header-only, and prefixes matching a smaller layout. */
		for (size_t read = 0; read < size; read++) {
			assert(!shot_log_restore(&log, bytes, size, read));
			assert(!memcmp(&log, &before, sizeof(log)));
		}
		assert(!shot_log_restore(&log, bytes, size, size + 1));
		assert(!memcmp(&log, &before, sizeof(log)));
		assert(shot_log_restore(&log, bytes, size, size));
		assert(log.count == 2);
		for (unsigned i = 0; i < 2; i++) {
			assert_shot(&log.shots[i], i, format == 0, format != 2);
			emit(output, &log.shots[i]);
		}
		assert_unused_cleared(&log);
		if (format == 0) {
			for (unsigned i = 0; i < 2; i++) {
				const uint8_t *native = (const uint8_t *)&log.shots[i];
				assert(!memcmp(native, current[i], 2));
				assert(!memcmp(native + 4, current[i] + 4, 22));
			}
		}
		/* Staged decoding also supports bytes occupying the destination. */
		memcpy(&log, bytes, size);
		assert(shot_log_restore(&log, (const uint8_t *)&log, size, size));
		assert(log.count == 2);
		assert_shot(&log.shots[0], 0, format == 0, format != 2);
		assert_shot(&log.shots[1], 1, format == 0, format != 2);
		assert_unused_cleared(&log);
		memcpy(&before, &log, sizeof(log));
		bytes[0] = 101;
		assert(!shot_log_restore(&log, bytes, size, size));
		assert(!memcmp(&log, &before, sizeof(log)));
		bytes[0] = 0xff; bytes[1] = 0xff;
		assert(!shot_log_restore(&log, bytes, size, size));
		assert(!memcmp(&log, &before, sizeof(log)));
		bytes[0] = 0; bytes[1] = 0;
		assert(shot_log_restore(&log, bytes, size, size));
		assert(log.count == 0);
		assert_unused_cleared(&log);
		/* The final record must fit at capacity, preserving queue order. */
		bytes[0] = STORED_SHOT_CAPACITY;
		for (unsigned i = 0; i < STORED_SHOT_CAPACITY; i++) {
			uint8_t *record = bytes + header + i * stride;
			memcpy(record, format == 0 ? current[0] : legacy[0], stride);
			unsigned id_offset = format == 0 ? 4 : 2;
			record[id_offset] = (uint8_t)i;
			record[id_offset + 1] = 0;
			if (format == 0) { record[id_offset + 2] = 1; record[id_offset + 3] = 0; }
		}
		assert(shot_log_restore(&log, bytes, size, size));
		assert(log.count == STORED_SHOT_CAPACITY);
		for (unsigned i = 0; i < STORED_SHOT_CAPACITY; i++) {
			assert(log.shots[i].shot_id == (format == 0 ? 65536 + i : i));
			assert(log.shots[i].ax_mg == -1200);
		}
	}
	const size_t invalid_sizes[] = {0, 1, 2, 18, 22, 28, 1801, 1803, 2201, 2203, 2803, 2805, SIZE_MAX};
	memcpy(&before, &log, sizeof(log));
	for (unsigned i = 0; i < sizeof(invalid_sizes) / sizeof(invalid_sizes[0]); i++) {
		assert(!shot_log_valid_storage_size(invalid_sizes[i]));
		assert(!shot_log_restore(&log, NULL, invalid_sizes[i], invalid_sizes[i]));
		assert(!memcmp(&log, &before, sizeof(log)));
	}
	memset(bytes, 0, sizeof(log)); bytes[0] = 1;
	memcpy(bytes + 4, current[0], sizeof(current[0]));
	memset(bytes + 8, 0xff, 4);
	assert(shot_log_restore(&log, bytes, sizeof(log), sizeof(log)));
	assert(log.shots[0].shot_id == UINT32_MAX);
	emit(output, &log.shots[0]);
	assert(fclose(output) == 0);
	check_queue_mutations();
	puts("Shot log: complete reads, three layouts, canonical queue mutations, capacity, rejection without mutation, and stored frames passed.");
	return 0;
}
