/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SLEEP_FLUSH_H
#define OPENFLOAT_SLEEP_FLUSH_H

#include "shot_control.h"
#include "shot_log.h"

#define SLEEP_FLUSH_ATTEMPTS 3
#define SLEEP_FLUSH_RETRY_DELAY_MS 1000

/* The caller stops mutations and drains background writers before taking this
 * snapshot. queue remains immutable until sleep_flush() returns. Layouts and
 * keys are the existing Settings values; this is not a new persisted schema.
 */
struct sleep_flush_values {
	struct openfloat_shot_counters counters;
	const struct stored_shot_log *queue;
	uint32_t wakesens, sleeptime, sleepsens, bufrate, bufnvs, autosleep, streamrate, followms;
	int32_t cant_offset, pitch_offset;
};

struct sleep_flush_io {
	void *context;
	int (*write_setting)(void *context, const char *key, const void *data, size_t size);
	/* Attempt every requested, unsaved trace once. Return zero only when all are
	 * committed; retain failed captures for the next pass or awake recovery.
	 */
	int (*write_traces)(void *context);
	void (*retry_delay)(void *context, uint32_t milliseconds);
};

/* Attempts all settings and traces on each pass, including after another key
 * fails. Returns zero only after an entirely successful pass. A failure after
 * three passes means the caller must stay awake; hardware is not stopped here.
 */
int sleep_flush(const struct sleep_flush_values *values, const struct sleep_flush_io *io);

#endif
