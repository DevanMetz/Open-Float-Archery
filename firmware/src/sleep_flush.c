/* SPDX-License-Identifier: Apache-2.0 */
#include "sleep_flush.h"
#include "settings_retry.h"

int sleep_flush(const struct sleep_flush_values *values, const struct sleep_flush_io *io)
{
	int result = 0;
	for (unsigned int attempt = 0; attempt < SLEEP_FLUSH_ATTEMPTS; attempt++) {
		result = 0;
		for (enum openfloat_setting key = 0; key < SETTING_COUNT; key++) {
			int rc = settings_retry_save(key, values, io->write_setting, io->context);
			if (rc && !result) result = rc;
		}
		int rc = io->write_traces(io->context);
		if (rc && !result) result = rc;
		if (!result) return 0;
		if (attempt + 1 < SLEEP_FLUSH_ATTEMPTS) {
			io->retry_delay(io->context, SLEEP_FLUSH_RETRY_DELAY_MS);
		}
	}
	return result;
}
