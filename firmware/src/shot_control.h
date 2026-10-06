/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SHOT_CONTROL_H
#define OPENFLOAT_SHOT_CONTROL_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

struct openfloat_shot_counters {
	uint32_t count;
	uint32_t shot_id;
};

_Static_assert(sizeof(struct openfloat_shot_counters) == 8, "Shot counter settings layout changed");

/* Existing four-byte settings used the lifetime count as the capture ID. New
 * settings save both fields in one value so corrections cannot rewind IDs on
 * reboot. Invalid layouts leave the current counters unchanged.
 */
static inline bool openfloat_restore_shot_counters(struct openfloat_shot_counters *counters,
						  const uint8_t *bytes, size_t size)
{
	if (size != sizeof(uint32_t) && size != sizeof(*counters)) return false;
	struct openfloat_shot_counters restored;
	memcpy(&restored.count, bytes, sizeof(restored.count));
	if (size == sizeof(uint32_t)) restored.shot_id = restored.count;
	else memcpy(&restored.shot_id, bytes + sizeof(restored.count), sizeof(restored.shot_id));
	*counters = restored;
	return true;
}

static inline void openfloat_set_shot_count(struct openfloat_shot_counters *counters, uint32_t count)
{
	counters->count = count;
}

/* Count corrections and resets preserve IDs. The lifetime count saturates at
 * its limit, while capture IDs retain their existing unsigned wrap behavior.
 */
static inline void openfloat_advance_shot(struct openfloat_shot_counters *counters)
{
	if (counters->count < UINT32_MAX) counters->count++;
	counters->shot_id++;
}

#endif
