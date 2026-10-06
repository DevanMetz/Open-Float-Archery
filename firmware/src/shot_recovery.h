/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SHOT_RECOVERY_H
#define OPENFLOAT_SHOT_RECOVERY_H

#include "shot_control.h"
#include "shot_log.h"
#include "trace_buffer.h"

/* Boot only, after validated settings/traces have loaded and before writers or
 * acquisition start. Count corrections stay authoritative. Retained full IDs
 * fence an older/missing counter; legacy 16-bit log IDs cannot infer high bits.
 * Sequence comparisons assume retained IDs span less than half the 32-bit
 * range. An exactly half-range comparison is ambiguous and rejects startup
 * without changing counters. No Settings writes or storage-layout changes.
 */
int shot_recover_id(struct openfloat_shot_counters *counters, bool counter_present,
		    const struct stored_shot_log *log, bool full_log_ids,
		    const struct stored_trace *traces, size_t trace_slots);

#endif
