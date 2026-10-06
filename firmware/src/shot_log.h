/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SHOT_LOG_H
#define OPENFLOAT_SHOT_LOG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define STORED_SHOT_CAPACITY 100
#define SHOT_LOG_LEGACY_TIMED_SIZE (2 + 22 * STORED_SHOT_CAPACITY)
#define SHOT_LOG_LEGACY_SIZE (2 + 18 * STORED_SHOT_CAPACITY)
#define STORED_SHOT_FRAME_SIZE 29

/* Keep the existing ARM32 Settings layout: padded 28-byte records at offset 4.
 * Older layouts used 16-bit IDs and 22/18-byte records at offset 2.
 */
struct stored_shot {
	uint16_t shot_count;
	uint32_t shot_id;
	int16_t ax_mg;
	int16_t ay_mg;
	int16_t az_mg;
	uint16_t threshold_cg;
	int16_t roll_cdeg;
	int16_t pitch_cdeg;
	int16_t yaw_cdeg;
	uint16_t clicker_dt_ms;
	uint16_t impact_dt_ms;
};

struct stored_shot_log {
	uint16_t count;
	struct stored_shot shots[STORED_SHOT_CAPACITY];
};

_Static_assert(sizeof(struct stored_shot) == 28 && offsetof(struct stored_shot, shot_count) == 0 &&
	       offsetof(struct stored_shot, shot_id) == 4 && offsetof(struct stored_shot, ax_mg) == 8 &&
	       offsetof(struct stored_shot, ay_mg) == 10 && offsetof(struct stored_shot, az_mg) == 12 &&
	       offsetof(struct stored_shot, threshold_cg) == 14 && offsetof(struct stored_shot, roll_cdeg) == 16 &&
	       offsetof(struct stored_shot, pitch_cdeg) == 18 && offsetof(struct stored_shot, yaw_cdeg) == 20 &&
	       offsetof(struct stored_shot, clicker_dt_ms) == 22 && offsetof(struct stored_shot, impact_dt_ms) == 24,
	       "Stored shot Settings layout changed");
_Static_assert(sizeof(struct stored_shot_log) == 2804 && offsetof(struct stored_shot_log, count) == 0 &&
	       offsetof(struct stored_shot_log, shots) == 4,
	       "Shot log Settings layout changed");

bool shot_log_valid_storage_size(size_t size);
/* Validate the declared Settings size and actual read result separately. A short
 * read cannot masquerade as a complete smaller legacy layout. Rejected bytes
 * leave dest unchanged; successful restores clear unused records and padding.
 */
bool shot_log_restore(struct stored_shot_log *dest, const uint8_t *bytes,
		      size_t size, size_t bytes_read);
/* Start from a zeroed/reset or successfully restored log. Mutations retain
 * zero padding and unused slots, making every empty queue byte-identical.
 * Callers provide locking. Append returns true if the oldest record was evicted;
 * remove matches the complete capture ID and leaves unknown IDs unchanged.
 */
void shot_log_reset(struct stored_shot_log *log);
bool shot_log_append(struct stored_shot_log *log, const struct stored_shot *shot);
bool shot_log_remove(struct stored_shot_log *log, uint32_t shot_id);
void shot_log_build_frame(const struct stored_shot *shot, uint8_t frame[STORED_SHOT_FRAME_SIZE]);

#endif
