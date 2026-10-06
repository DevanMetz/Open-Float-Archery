/* SPDX-License-Identifier: Apache-2.0 */
#include "boot_restore.h"
#include <errno.h>
#include <stdio.h>

int boot_restore(const struct boot_restore_io *io)
{
	static const char *const keys[] = {
		"shots", "shotlog", "wakesens", "sleeptime", "sleepsens", "bufrate",
		"bufnvs", "autosleep", "streamrate", "followms", "cant_offset", "pitch_offset",
	};
	int result = 0;
	for (unsigned int attempt = 0; attempt < BOOT_RESTORE_ATTEMPTS; attempt++) {
		result = io->initialize(io->context);
		if (!result) {
			io->reset(io->context);
			for (unsigned int i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
				int rc = io->restore_setting(io->context, keys[i]);
				if (i >= 2 && (rc == -EBADMSG || rc == -EMSGSIZE)) continue;
				if (rc && !result) result = rc;
			}
			for (unsigned int slot = 0; slot < 10; slot++) {
				char key[4];
				snprintf(key, sizeof(key), "t%u", slot);
				int rc = io->restore_setting(io->context, key);
				if (rc == -EBADMSG || rc == -EMSGSIZE) continue;
				if (rc && !result) result = rc;
			}
			int rc = io->restore_traces(io->context);
			if (rc && !result) result = rc;
		}
		if (!result) result = io->commit_recovered(io->context);
		if (!result) return 0;
		if (attempt + 1 < BOOT_RESTORE_ATTEMPTS) io->retry_delay(io->context, BOOT_RESTORE_RETRY_DELAY_MS);
	}
	return result;
}
