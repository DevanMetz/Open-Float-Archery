/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_BOOT_RESTORE_H
#define OPENFLOAT_BOOT_RESTORE_H

#include <stdint.h>

#define BOOT_RESTORE_ATTEMPTS 3
#define BOOT_RESTORE_RETRY_DELAY_MS 1000

struct boot_restore_io {
	void *context;
	int (*initialize)(void *context);
	/* Reset RAM to startup defaults, including any partial prior restoration. */
	void (*reset)(void *context);
	/* Relative OpenFloat key. Zero means applied or absent; -EBADMSG/-EMSGSIZE
	 * means malformed. Other errors must propagate without being called absent. */
	int (*restore_setting)(void *context, const char *key);
	int (*restore_traces)(void *context);
	/* Called only after every read/restore succeeds. Persist a recovered capture
	 * ID before BLE acknowledgments can delete the records that established it.
	 * Fresh defaults and unchanged counters need no application writes. */
	int (*commit_recovered)(void *context);
	void (*retry_delay)(void *context, uint32_t milliseconds);
};

/* Run before BLE, acquisition, or application persistence. Malformed counters
 * or shot queues prevent startup; malformed tuning/legacy traces retain defaults.
 * A failure after three passes means the caller must keep startup closed and
 * may retry later. commit_recovered cannot run after any failed read/restore.
 */
int boot_restore(const struct boot_restore_io *io);

#endif
