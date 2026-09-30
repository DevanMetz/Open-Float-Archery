#include "trace_buffer.h"
#include <string.h>

_Static_assert(sizeof(struct trace_point) == 8, "Trace point layout changed");
_Static_assert(sizeof(struct stored_trace) == 8012, "Persisted trace layout changed");

static uint16_t read16(const uint8_t *p)
{
	return (uint16_t)p[0] | (uint16_t)p[1] << 8;
}

static uint32_t read32(const uint8_t *p)
{
	return (uint32_t)read16(p) | (uint32_t)read16(p + 2) << 16;
}

static void write16(uint8_t *p, uint16_t value)
{
	p[0] = (uint8_t)value;
	p[1] = (uint8_t)(value >> 8);
}

void trace_ring_push(struct trace_ring *ring, struct trace_point point, uint32_t now_ms)
{
	uint32_t elapsed = now_ms - ring->last_ms;
	/* A pause longer than the compact delta can represent starts a new window.
	 * Never wrap a gap into a shorter interval. Unsigned subtraction handles
	 * the device millisecond clock wrapping during continuous capture. */
	if (ring->count && elapsed > UINT8_MAX) {
		ring->count = 0;
		ring->write_idx = 0;
	}
	point.dt_ms = ring->count ? (uint8_t)elapsed : 0;
	ring->points[ring->write_idx] = point;
	ring->write_idx = (ring->write_idx + 1) % TRACE_CAPACITY;
	if (ring->count < TRACE_CAPACITY) ring->count++;
	ring->last_ms = now_ms;
}

void trace_ring_freeze(const struct trace_ring *ring, struct stored_trace *dest,
		       uint32_t shot_id, uint32_t release_ms)
{
	memset(dest, 0, sizeof(*dest));
	dest->shot_id = shot_id;
	dest->version = 1;
	dest->flags = TRACE_HAS_TIMING;
	dest->count = ring->count;
	uint16_t read_idx = ring->count == TRACE_CAPACITY ? ring->write_idx : 0;
	uint32_t span_ms = 0;
	for (uint16_t i = 0; i < ring->count; i++) {
		dest->points[i] = ring->points[read_idx];
		if (i) span_ms += dest->points[i].dt_ms;
		read_idx = (read_idx + 1) % TRACE_CAPACITY;
	}
	dest->points[0].dt_ms = 0;
	dest->first_time_ms = (int32_t)(ring->last_ms - release_ms - span_ms);
}

bool trace_restore(struct stored_trace *dest, const uint8_t *bytes, size_t size)
{
	if (size == sizeof(*dest)) {
		if (bytes[4] != 1 || (bytes[5] & ~TRACE_HAS_TIMING) ||
		    read16(bytes + 6) > TRACE_CAPACITY || bytes[19] != 0) return false;
		memcpy(dest, bytes, size);
		return true;
	}
	/* Previous firmware persisted a padded 7008-byte struct: ID, count,
	 * then 1000 packed seven-byte angle/mic points. It had no timestamps. */
	if (size != 7008 || read16(bytes + 4) > TRACE_CAPACITY) return false;
	memset(dest, 0, sizeof(*dest));
	dest->shot_id = read32(bytes);
	dest->version = 1;
	dest->count = read16(bytes + 4);
	for (uint16_t i = 0; i < dest->count; i++) {
		const uint8_t *p = bytes + 6 + i * 7;
		dest->points[i] = (struct trace_point) {
			.roll_cdeg = (int16_t)read16(p),
			.pitch_cdeg = (int16_t)read16(p + 2),
			.yaw_cdeg = (int16_t)read16(p + 4),
			.mic_amp = p[6],
		};
	}
	return true;
}

static uint16_t wire_size(const struct stored_trace *trace, unsigned int mode)
{
	return mode == 3 ? 12 + trace->count * 8 : trace->count * 7;
}

/* Timed stream: version u8, flags u8, count u16, first_time_ms i32,
 * eight-byte points, then CRC-32/ISO-HDLC over header and points. */
static uint8_t wire_byte(const struct stored_trace *trace, unsigned int mode,
			 uint16_t offset, uint32_t crc)
{
	if (mode == 3) {
		if (offset == 0) return 1;
		if (offset == 1) return trace->flags;
		if (offset < 4) return (uint8_t)(trace->count >> (8 * (offset - 2)));
		if (offset < 8) return (uint8_t)((uint32_t)trace->first_time_ms >> (8 * (offset - 4)));
		offset -= 8;
		if (offset >= trace->count * 8) return (uint8_t)(crc >> (8 * (offset - trace->count * 8)));
	}
	uint8_t stride = mode == 3 ? 8 : 7;
	const struct trace_point *point = &trace->points[offset / stride];
	switch (offset % stride) {
	case 0: return (uint8_t)point->roll_cdeg;
	case 1: return (uint8_t)((uint16_t)point->roll_cdeg >> 8);
	case 2: return (uint8_t)point->pitch_cdeg;
	case 3: return (uint8_t)((uint16_t)point->pitch_cdeg >> 8);
	case 4: return (uint8_t)point->yaw_cdeg;
	case 5: return (uint8_t)((uint16_t)point->yaw_cdeg >> 8);
	case 6: return point->mic_amp;
	default: return point->dt_ms;
	}
}

uint32_t trace_wire_crc(const struct stored_trace *trace)
{
	uint32_t crc = UINT32_MAX;
	for (uint16_t i = 0; i < wire_size(trace, 3) - 4; i++) {
		crc ^= wire_byte(trace, 3, i, 0);
		for (int bit = 0; bit < 8; bit++) {
			crc = (crc >> 1) ^ ((crc & 1) ? UINT32_C(0xedb88320) : 0);
		}
	}
	return ~crc;
}

uint16_t trace_chunk_count(const struct stored_trace *trace, unsigned int mode)
{
	if (!trace->count || trace->count > TRACE_CAPACITY || mode < 1 || mode > 3) return 0;
	uint8_t payload_size = mode == 1 ? 19 : 15;
	uint16_t count = (wire_size(trace, mode) + payload_size - 1) / payload_size;
	return mode == 1 && count > UINT8_MAX ? 0 : count;
}

bool trace_build_chunk(const struct stored_trace *trace, unsigned int mode,
		      uint16_t index, uint32_t crc, uint8_t frame[TRACE_FRAME_SIZE])
{
	uint16_t chunks = trace_chunk_count(trace, mode);
	if (index >= chunks) return false;
	uint8_t payload_size = mode == 1 ? 19 : 15;
	uint16_t offset = index * payload_size;
	uint16_t remaining = wire_size(trace, mode) - offset;
	uint8_t length = remaining > payload_size ? payload_size : (uint8_t)remaining;
	memset(frame, 0, TRACE_FRAME_SIZE);
	frame[0] = 'O'; frame[1] = 'F'; frame[2] = mode == 1 ? 1 : 2; frame[3] = 6;
	write16(frame + 4, (uint16_t)trace->shot_id);
	if (mode == 1) {
		frame[6] = (uint8_t)index;
		frame[7] = (uint8_t)chunks;
		frame[8] = length;
		if (!index) frame[28] = 7;
	} else {
		write16(frame + 6, (uint16_t)(trace->shot_id >> 16));
		write16(frame + 8, index);
		write16(frame + 10, chunks);
		frame[12] = length;
		frame[13] = mode == 3 ? TRACE_TIMED_FORMAT : 7;
	}
	for (uint8_t i = 0; i < length; i++) {
		frame[(mode == 1 ? 9 : 14) + i] = wire_byte(trace, mode, offset + i, crc);
	}
	return true;
}
