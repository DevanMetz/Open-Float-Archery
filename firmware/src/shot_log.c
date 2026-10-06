/* SPDX-License-Identifier: Apache-2.0 */
#include "shot_log.h"
#include <string.h>

static uint16_t read16(const uint8_t *p)
{
	return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read32(const uint8_t *p)
{
	return read16(p) | ((uint32_t)read16(p + 2) << 16);
}

static void write16(uint8_t *p, uint16_t value)
{
	p[0] = (uint8_t)value;
	p[1] = (uint8_t)(value >> 8);
}

bool shot_log_valid_storage_size(size_t size)
{
	return size == sizeof(struct stored_shot_log) || size == SHOT_LOG_LEGACY_TIMED_SIZE ||
		size == SHOT_LOG_LEGACY_SIZE;
}

bool shot_log_restore(struct stored_shot_log *dest, const uint8_t *bytes,
		      size_t size, size_t bytes_read)
{
	if (!shot_log_valid_storage_size(size) || bytes_read != size) return false;
	uint16_t count = read16(bytes);
	if (count > STORED_SHOT_CAPACITY) return false;
	bool current = size == sizeof(*dest);
	size_t stride = current ? sizeof(struct stored_shot) :
		(size == SHOT_LOG_LEGACY_TIMED_SIZE ? 22 : 18);
	size_t values = current ? 8 : 4;
	/* Length and count are checked before any mutation. All three formats are
	 * little-endian, so no packed or potentially unaligned struct casts are used.
	 */
	struct stored_shot_log restored;
	memset(&restored, 0, sizeof(restored));
	restored.count = count;
	for (uint16_t i = 0; i < count; i++) {
		const uint8_t *p = bytes + (current ? 4 : 2) + i * stride;
		struct stored_shot *shot = &restored.shots[i];
		shot->shot_count = read16(p);
		shot->shot_id = current ? read32(p + 4) : read16(p + 2);
		shot->ax_mg = (int16_t)read16(p + values);
		shot->ay_mg = (int16_t)read16(p + values + 2);
		shot->az_mg = (int16_t)read16(p + values + 4);
		shot->threshold_cg = read16(p + values + 6);
		shot->roll_cdeg = (int16_t)read16(p + values + 8);
		shot->pitch_cdeg = (int16_t)read16(p + values + 10);
		shot->yaw_cdeg = (int16_t)read16(p + values + 12);
		shot->clicker_dt_ms = stride == 18 ? 0 : read16(p + values + 14);
		shot->impact_dt_ms = stride == 18 ? 0 : read16(p + values + 16);
	}
	memcpy(dest, &restored, sizeof(*dest));
	return true;
}

void shot_log_reset(struct stored_shot_log *log)
{
	memset(log, 0, sizeof(*log));
}

bool shot_log_append(struct stored_shot_log *log, const struct stored_shot *shot)
{
	/* Copy before eviction so a record already in this log can be appended. */
	struct stored_shot copy;
	memcpy(&copy, shot, sizeof(copy));
	memset((uint8_t *)&copy + 2, 0, 2);
	memset((uint8_t *)&copy + 26, 0, 2);
	bool evicted = log->count >= STORED_SHOT_CAPACITY;
	if (evicted) {
		memmove(&log->shots[0], &log->shots[1],
			(STORED_SHOT_CAPACITY - 1) * sizeof(log->shots[0]));
		log->count = STORED_SHOT_CAPACITY - 1;
	}
	memcpy(&log->shots[log->count++], &copy, sizeof(copy));
	return evicted;
}

bool shot_log_remove(struct stored_shot_log *log, uint32_t shot_id)
{
	for (uint16_t i = 0; i < log->count; i++) {
		if (log->shots[i].shot_id != shot_id) continue;
		memmove(&log->shots[i], &log->shots[i + 1],
			(log->count - i - 1) * sizeof(log->shots[0]));
		memset(&log->shots[--log->count], 0, sizeof(log->shots[0]));
		return true;
	}
	return false;
}

void shot_log_build_frame(const struct stored_shot *shot, uint8_t frame[STORED_SHOT_FRAME_SIZE])
{
	memset(frame, 0, STORED_SHOT_FRAME_SIZE);
	frame[0] = 'O'; frame[1] = 'F'; frame[2] = 1; frame[3] = 4;
	write16(frame + 4, shot->shot_count);
	write16(frame + 6, (uint16_t)shot->shot_id);
	write16(frame + 8, (uint16_t)shot->ax_mg);
	write16(frame + 10, (uint16_t)shot->ay_mg);
	write16(frame + 12, (uint16_t)shot->az_mg);
	write16(frame + 14, shot->threshold_cg);
	write16(frame + 16, (uint16_t)shot->roll_cdeg);
	write16(frame + 18, (uint16_t)shot->pitch_cdeg);
	write16(frame + 20, (uint16_t)shot->yaw_cdeg);
	write16(frame + 22, shot->clicker_dt_ms);
	write16(frame + 24, shot->impact_dt_ms);
	write16(frame + 26, (uint16_t)(shot->shot_id >> 16));
}
