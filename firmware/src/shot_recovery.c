/* SPDX-License-Identifier: Apache-2.0 */
#include "shot_recovery.h"
#include <errno.h>

static bool include_id(uint32_t *latest, bool *present, uint32_t id)
{
	if (!*present) {
		*latest = id;
		*present = true;
		return true;
	}
	uint32_t distance = id - *latest;
	if (distance == UINT32_C(0x80000000)) return false;
	if (distance && distance < UINT32_C(0x80000000)) *latest = id;
	return true;
}

int shot_recover_id(struct openfloat_shot_counters *counters, bool counter_present,
		    const struct stored_shot_log *log, bool full_log_ids,
		    const struct stored_trace *traces, size_t trace_slots)
{
	uint32_t latest = counters->shot_id;
	if (full_log_ids) {
		for (unsigned int i = 0; i < log->count; i++) {
			if (!include_id(&latest, &counter_present, log->shots[i].shot_id)) return -EBADMSG;
		}
	}
	for (size_t i = 0; i < trace_slots; i++) {
		if (traces[i].count && !include_id(&latest, &counter_present, traces[i].shot_id)) return -EBADMSG;
	}
	counters->shot_id = latest;
	return 0;
}
