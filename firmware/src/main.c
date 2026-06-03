/*
 * OpenFloat full-rate serial telemetry prototype for Seeed XIAO nRF54L15 Sense.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/byteorder.h>

#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>

#define IMU_ODR_HZ 6664
#define IMU_ACCEL_FS_G 16
#define IMU_GYRO_FS_DPS 2000
#define BLE_OUTPUT_HZ 1000
#define BLE_OUTPUT_PERIOD_US (1000000 / BLE_OUTPUT_HZ)
#define SERIAL_PRINT_DIVIDER 100
#define BLE_NOTIFY_DIVIDER 1
#define OPENFLOAT_BLE_FRAME_SIZE 20
#define OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION 10
#define OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE \
	(OPENFLOAT_BLE_FRAME_SIZE * OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION)
#define OPENFLOAT_CONN_INTERVAL_MIN 6  /* 7.5 ms */
#define OPENFLOAT_CONN_INTERVAL_MAX 6  /* 7.5 ms */
#define OPENFLOAT_CONN_LATENCY 0
#define OPENFLOAT_CONN_TIMEOUT 400 /* 4 s */
#define MADGWICK_BETA 0.08f

#define RAD_TO_DEG 57.29577951308232f
#define SCALE_CDEG 100.0f
#define SCALE_QUAT 1000000.0f
#define SCALE_MG 101.97162129779283f
#define SCALE_GYRO_MDPS (RAD_TO_DEG * 1000.0f)
#define SCALE_GYRO_DPS_Q4 (RAD_TO_DEG * 16.0f)
#define LSM6DSL_REG_WHO_AM_I 0x0f
#define LSM6DSL_WHO_AM_I 0x6a
#define LSM6DSL_REG_CTRL1_XL 0x10
#define LSM6DSL_REG_CTRL2_G 0x11
#define LSM6DSL_REG_CTRL3_C 0x12
#define LSM6DSL_REG_CTRL6_C 0x15
#define LSM6DSL_REG_CTRL7_G 0x16
#define LSM6DSL_REG_OUTX_L_G 0x22
#define LSM6DSL_ODR_6664HZ 0x0a
#define LSM6DSL_ACCEL_FS_16G 0x01
#define LSM6DSL_GYRO_FS_2000DPS 0x03
#define LSM6DSL_CTRL3_C_BDU BIT(6)
#define LSM6DSL_CTRL3_C_IF_INC BIT(2)
#define LSM6DSL_CTRL6_C_XL_HM_MODE BIT(4)
#define LSM6DSL_CTRL7_G_HM_MODE BIT(7)
#define LSM6DSL_ACCEL_16G_MPS2_PER_LSB \
	((float)IMU_ACCEL_FS_G * MPS2_PER_G / 32768.0f)
#define LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB \
	(((float)IMU_GYRO_FS_DPS * 2.0f / 65536.0f) / RAD_TO_DEG)

/* Mounting: XIAO rotated 90 degrees about the cant/forward axis.
 * Flip this sign if the mounted board reads pitch or cant inverted.
 */
#define MOUNT_ROT_X_SIGN 1

#define MPS2_PER_G 9.81f
#define DEFAULT_SHOT_ACCEL_THRESHOLD_G 12.0f
#define MIN_SHOT_ACCEL_THRESHOLD_G 2.0f
#define MAX_SHOT_ACCEL_THRESHOLD_G 30.0f
#define SHOT_REFRACTORY_MS 800

#define LED_IDLE_PERIOD_MS 500
#define LED_SHOT_PULSE_MS 120

static const struct i2c_dt_spec imu_i2c = I2C_DT_SPEC_GET(DT_ALIAS(imu0));
static const struct gpio_dt_spec user_led =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(led0), gpios, { 0 });
static const struct gpio_dt_spec user_btn =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(sw0), gpios, { 0 });
static const struct device *const stream_uart =
	DEVICE_DT_GET(DT_NODELABEL(xiao_serial));

static float cant_offset_deg;
static float pitch_offset_deg;
static int shot_count;
static uint32_t shot_id;
static uint32_t telemetry_sequence;
static uint32_t raw_sample_sequence;
static uint32_t ble_dropped_samples;
static int64_t led_shot_until_ms;
static float shot_accel_threshold_mps2 =
	DEFAULT_SHOT_ACCEL_THRESHOLD_G * MPS2_PER_G;
static struct bt_conn *current_conn;
static bool ble_notify_enabled;
static void tune_ble_link_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(tune_ble_link_work, tune_ble_link_work_handler);

static struct bt_uuid_128 openfloat_service_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000001));
static struct bt_uuid_128 openfloat_live_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000002));
static struct bt_uuid_128 openfloat_control_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000003));

struct vec3 {
	float x;
	float y;
	float z;
};

struct quat {
	float w;
	float x;
	float y;
	float z;
};

static int32_t scale_float(float value, float scale)
{
	float scaled = value * scale;

	return (int32_t)(scaled + (scaled >= 0.0f ? 0.5f : -0.5f));
}

static uint64_t uptime_us(void)
{
	return k_ticks_to_us_floor64(k_uptime_ticks());
}

static float inv_sqrtf(float value)
{
	return 1.0f / sqrtf(value);
}

static void normalize_quat(struct quat *q)
{
	float norm = inv_sqrtf((q->w * q->w) + (q->x * q->x) +
			       (q->y * q->y) + (q->z * q->z));

	q->w *= norm;
	q->x *= norm;
	q->y *= norm;
	q->z *= norm;
}

static void madgwick_update_imu(struct quat *q, const struct vec3 *gyro,
				const struct vec3 *accel, float dt_s)
{
	float q1 = q->w;
	float q2 = q->x;
	float q3 = q->y;
	float q4 = q->z;
	float gx = gyro->x;
	float gy = gyro->y;
	float gz = gyro->z;
	float ax = accel->x;
	float ay = accel->y;
	float az = accel->z;
	float recip_norm;
	float s1;
	float s2;
	float s3;
	float s4;
	float q_dot1;
	float q_dot2;
	float q_dot3;
	float q_dot4;
	float two_q1 = 2.0f * q1;
	float two_q2 = 2.0f * q2;
	float two_q3 = 2.0f * q3;
	float two_q4 = 2.0f * q4;
	float four_q1 = 4.0f * q1;
	float four_q2 = 4.0f * q2;
	float four_q3 = 4.0f * q3;
	float eight_q2 = 8.0f * q2;
	float eight_q3 = 8.0f * q3;
	float q1q1 = q1 * q1;
	float q2q2 = q2 * q2;
	float q3q3 = q3 * q3;
	float q4q4 = q4 * q4;

	q_dot1 = 0.5f * ((-q2 * gx) - (q3 * gy) - (q4 * gz));
	q_dot2 = 0.5f * ((q1 * gx) + (q3 * gz) - (q4 * gy));
	q_dot3 = 0.5f * ((q1 * gy) - (q2 * gz) + (q4 * gx));
	q_dot4 = 0.5f * ((q1 * gz) + (q2 * gy) - (q3 * gx));

	if ((ax != 0.0f) || (ay != 0.0f) || (az != 0.0f)) {
		recip_norm = inv_sqrtf((ax * ax) + (ay * ay) + (az * az));
		ax *= recip_norm;
		ay *= recip_norm;
		az *= recip_norm;

		s1 = (four_q1 * q3q3) + (two_q3 * ax) +
		     (four_q1 * q2q2) - (two_q2 * ay);
		s2 = (four_q2 * q4q4) - (two_q4 * ax) +
		     (4.0f * q1q1 * q2) - (two_q1 * ay) -
		     four_q2 + (eight_q2 * q2q2) + (eight_q2 * q3q3) +
		     (four_q2 * az);
		s3 = (4.0f * q1q1 * q3) + (two_q1 * ax) +
		     (four_q3 * q4q4) - (two_q4 * ay) -
		     four_q3 + (eight_q3 * q2q2) + (eight_q3 * q3q3) +
		     (four_q3 * az);
		s4 = (4.0f * q2q2 * q4) - (two_q2 * ax) +
		     (4.0f * q3q3 * q4) - (two_q3 * ay);

		recip_norm = inv_sqrtf((s1 * s1) + (s2 * s2) +
				       (s3 * s3) + (s4 * s4));
		s1 *= recip_norm;
		s2 *= recip_norm;
		s3 *= recip_norm;
		s4 *= recip_norm;

		q_dot1 -= MADGWICK_BETA * s1;
		q_dot2 -= MADGWICK_BETA * s2;
		q_dot3 -= MADGWICK_BETA * s3;
		q_dot4 -= MADGWICK_BETA * s4;
	}

	q->w += q_dot1 * dt_s;
	q->x += q_dot2 * dt_s;
	q->y += q_dot3 * dt_s;
	q->z += q_dot4 * dt_s;
	normalize_quat(q);
}

static void quat_to_euler(const struct quat *q, float *roll_deg,
			  float *pitch_deg, float *yaw_deg)
{
	float sinr_cosp = 2.0f * ((q->w * q->x) + (q->y * q->z));
	float cosr_cosp = 1.0f - (2.0f * ((q->x * q->x) + (q->y * q->y)));
	float sinp = 2.0f * ((q->w * q->y) - (q->z * q->x));
	float siny_cosp = 2.0f * ((q->w * q->z) + (q->x * q->y));
	float cosy_cosp = 1.0f - (2.0f * ((q->y * q->y) + (q->z * q->z)));

	*roll_deg = atan2f(sinr_cosp, cosr_cosp) * RAD_TO_DEG;

	if (fabsf(sinp) >= 1.0f) {
		*pitch_deg = copysignf(90.0f, sinp);
	} else {
		*pitch_deg = asinf(sinp) * RAD_TO_DEG;
	}

	*yaw_deg = atan2f(siny_cosp, cosy_cosp) * RAD_TO_DEG;
}

static void apply_mount_rotation(struct vec3 *v)
{
	float y = v->y;
	float z = v->z;

	v->y = (float)(-MOUNT_ROT_X_SIGN) * z;
	v->z = (float)(MOUNT_ROT_X_SIGN) * y;
}

static int16_t le16_to_s16(const uint8_t *buf)
{
	return (int16_t)((uint16_t)buf[0] | ((uint16_t)buf[1] << 8));
}

static int configure_imu_raw_registers(void)
{
	uint8_t who_am_i;
	int err;

	if (!device_is_ready(imu_i2c.bus)) {
		printk("# IMU I2C bus %s is not ready\n", imu_i2c.bus->name);
		return -ENODEV;
	}

	err = i2c_reg_read_byte_dt(&imu_i2c, LSM6DSL_REG_WHO_AM_I, &who_am_i);
	if (err) {
		printk("# Could not read IMU WHO_AM_I: %d\n", err);
		return err;
	}
	if (who_am_i != LSM6DSL_WHO_AM_I) {
		printk("# Unexpected IMU WHO_AM_I: 0x%02x\n", who_am_i);
		return -ENODEV;
	}

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL3_C,
				     LSM6DSL_CTRL3_C_BDU |
					     LSM6DSL_CTRL3_C_IF_INC,
				     LSM6DSL_CTRL3_C_BDU |
					     LSM6DSL_CTRL3_C_IF_INC);
	if (err) {
		printk("# Could not enable IMU BDU/auto-increment: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_CTRL1_XL,
		(LSM6DSL_ODR_6664HZ << 4) | (LSM6DSL_ACCEL_FS_16G << 2));
	if (err) {
		printk("# Could not set raw accelerometer config: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_CTRL2_G,
		(LSM6DSL_ODR_6664HZ << 4) | (LSM6DSL_GYRO_FS_2000DPS << 2));
	if (err) {
		printk("# Could not set raw gyroscope config: %d\n", err);
		return err;
	}

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL6_C,
				     LSM6DSL_CTRL6_C_XL_HM_MODE, 0);
	if (err) {
		printk("# Could not enable accelerometer high performance: %d\n",
		       err);
		return err;
	}

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL7_G,
				     LSM6DSL_CTRL7_G_HM_MODE, 0);
	if (err) {
		printk("# Could not enable gyroscope high performance: %d\n", err);
		return err;
	}

	return 0;
}

static int configure_imu(void)
{
	int err;

	err = configure_imu_raw_registers();
	if (err) {
		return err;
	}

	printk("# IMU ready: raw I2C burst on %s@0x%02x, accel+gyro ODR %d Hz, accel +/- %dg, gyro +/- %d dps\n",
	       imu_i2c.bus->name, imu_i2c.addr, IMU_ODR_HZ, IMU_ACCEL_FS_G,
	       IMU_GYRO_FS_DPS);
	k_sleep(K_MSEC(100));

	return 0;
}

static int read_imu(struct vec3 *accel, struct vec3 *gyro)
{
	uint8_t raw[12];
	int16_t raw_gx;
	int16_t raw_gy;
	int16_t raw_gz;
	int16_t raw_ax;
	int16_t raw_ay;
	int16_t raw_az;
	int err;

	err = i2c_burst_read_dt(&imu_i2c, LSM6DSL_REG_OUTX_L_G, raw,
				sizeof(raw));
	if (err) {
		return err;
	}

	raw_gx = le16_to_s16(&raw[0]);
	raw_gy = le16_to_s16(&raw[2]);
	raw_gz = le16_to_s16(&raw[4]);
	raw_ax = le16_to_s16(&raw[6]);
	raw_ay = le16_to_s16(&raw[8]);
	raw_az = le16_to_s16(&raw[10]);

	accel->x = (float)raw_ax * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	accel->y = (float)raw_ay * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	accel->z = (float)raw_az * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	gyro->x = (float)raw_gx * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;
	gyro->y = (float)raw_gy * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;
	gyro->z = (float)raw_gz * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;

	apply_mount_rotation(accel);
	apply_mount_rotation(gyro);

	return 0;
}

static void init_user_led(void)
{
	if (user_led.port == NULL || !gpio_is_ready_dt(&user_led)) {
		printk("# User LED not ready\n");
		return;
	}

	int err = gpio_pin_configure_dt(&user_led, GPIO_OUTPUT_INACTIVE);

	if (err) {
		printk("# User LED configure failed: %d\n", err);
	}
}

static void init_user_btn(void)
{
	if (user_btn.port == NULL || !gpio_is_ready_dt(&user_btn)) {
		printk("# User button not ready\n");
		return;
	}

	int err = gpio_pin_configure_dt(&user_btn, GPIO_INPUT);

	if (err) {
		printk("# User button configure failed: %d\n", err);
	}
}

static bool user_btn_pressed(void)
{
	static bool was_pressed;
	bool pressed;

	if (user_btn.port == NULL || !gpio_is_ready_dt(&user_btn)) {
		return false;
	}

	pressed = gpio_pin_get_dt(&user_btn) > 0;

	if (pressed && !was_pressed) {
		was_pressed = true;
		return true;
	}

	if (!pressed) {
		was_pressed = false;
	}

	return false;
}

static void update_user_led(void)
{
	static int64_t last_toggle_ms;
	static bool led_on;
	int64_t now_ms = k_uptime_get();

	if (user_led.port == NULL || !gpio_is_ready_dt(&user_led)) {
		return;
	}

	if (led_shot_until_ms > now_ms) {
		(void)gpio_pin_set_dt(&user_led, 1);
		return;
	}

	if ((now_ms - last_toggle_ms) < LED_IDLE_PERIOD_MS) {
		return;
	}

	last_toggle_ms = now_ms;
	led_on = !led_on;
	(void)gpio_pin_set_dt(&user_led, led_on);
}

static void detect_shot(const struct vec3 *accel, uint64_t now_us)
{
	static int64_t last_shot_ms;
	float mag2 = (accel->x * accel->x) + (accel->y * accel->y) +
		     (accel->z * accel->z);
	float threshold = shot_accel_threshold_mps2;
	float thresh2 = threshold * threshold;
	int64_t now_ms = k_uptime_get();

	if (mag2 > thresh2 && (now_ms - last_shot_ms) > SHOT_REFRACTORY_MS) {
		shot_count++;
		shot_id++;
		last_shot_ms = now_ms;
		led_shot_until_ms = now_ms + LED_SHOT_PULSE_MS;
		printk("OFSHOT,1,%u,%llu,%d,%d,%d,%d\n",
		       shot_id,
		       (unsigned long long)now_us,
		       scale_float(accel->x, SCALE_MG),
		       scale_float(accel->y, SCALE_MG),
		       scale_float(accel->z, SCALE_MG),
		       shot_count);
	}
}

static void print_threshold_g(float threshold_g)
{
	int32_t tenths = scale_float(threshold_g, 10.0f);

	printk("# BLE control: shot threshold set to %d.%01d g\n",
	       tenths / 10, tenths % 10);
}

static bool set_shot_threshold_from_command(const char *command)
{
	const char *value = command + strlen("thresh:");
	char *end;
	float threshold_g;

	errno = 0;
	threshold_g = strtof(value, &end);
	if (errno != 0 || end == value || *end != '\0') {
		printk("# BLE control: invalid threshold command '%s'\n", command);
		return false;
	}

	if (threshold_g < MIN_SHOT_ACCEL_THRESHOLD_G) {
		threshold_g = MIN_SHOT_ACCEL_THRESHOLD_G;
	} else if (threshold_g > MAX_SHOT_ACCEL_THRESHOLD_G) {
		threshold_g = MAX_SHOT_ACCEL_THRESHOLD_G;
	}

	shot_accel_threshold_mps2 = threshold_g * MPS2_PER_G;
	print_threshold_g(threshold_g);
	return true;
}

static int16_t clamp_i16(int32_t value)
{
	if (value > INT16_MAX) {
		return INT16_MAX;
	}

	if (value < INT16_MIN) {
		return INT16_MIN;
	}

	return (int16_t)value;
}

static uint16_t checksum16(const uint8_t *data, size_t len)
{
	uint16_t sum = 0;

	for (size_t i = 0; i < len; i++) {
		sum = (uint16_t)(sum + data[i]);
	}

	return sum;
}

static void put_u16_le(uint8_t *buf, size_t offset, uint16_t value)
{
	sys_put_le16(value, &buf[offset]);
}

static void put_u32_le(uint8_t *buf, size_t offset, uint32_t value)
{
	sys_put_le32(value, &buf[offset]);
}

static void uart_write_bytes(const uint8_t *data, size_t len)
{
	if (!device_is_ready(stream_uart)) {
		return;
	}

	for (size_t i = 0; i < len; i++) {
		uart_poll_out(stream_uart, data[i]);
	}
}

static void build_openfloat_live_binary(uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE],
					uint32_t sequence,
					uint32_t dt_us,
					const struct vec3 *accel,
					const struct vec3 *gyro,
					uint16_t flags)
{
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1; /* protocol version */
	frame[3] = 1; /* live raw sample */
	put_u16_le(frame, 4, (uint16_t)sequence);
	put_u16_le(frame, 6, (uint16_t)dt_us);
	put_u16_le(frame, 8, (uint16_t)clamp_i16(scale_float(accel->x, SCALE_MG)));
	put_u16_le(frame, 10, (uint16_t)clamp_i16(scale_float(accel->y, SCALE_MG)));
	put_u16_le(frame, 12, (uint16_t)clamp_i16(scale_float(accel->z, SCALE_MG)));
	put_u16_le(frame, 14, (uint16_t)clamp_i16(scale_float(gyro->x, SCALE_GYRO_DPS_Q4)));
	put_u16_le(frame, 16, (uint16_t)clamp_i16(scale_float(gyro->y, SCALE_GYRO_DPS_Q4)));
	put_u16_le(frame, 18, (uint16_t)clamp_i16(scale_float(gyro->z, SCALE_GYRO_DPS_Q4)));
}

static void __maybe_unused write_openfloat_live_binary(uint32_t sequence,
						       uint32_t dt_us,
						       const struct vec3 *accel,
						       const struct vec3 *gyro,
						       uint16_t flags)
{
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];

	build_openfloat_live_binary(frame, sequence, dt_us, accel, gyro, flags);
	uart_write_bytes(frame, sizeof(frame));
}

static ssize_t write_openfloat_control(struct bt_conn *conn,
				       const struct bt_gatt_attr *attr,
				       const void *buf, uint16_t len,
				       uint16_t offset, uint8_t flags)
{
	char command[16];

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}

	if (len >= sizeof(command)) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}

	memcpy(command, buf, len);
	command[len] = '\0';

	if (!strcmp(command, "zero")) {
		printk("# BLE control: zero requested, press user button path still owns live zeroing\n");
	} else if (!strcmp(command, "start")) {
		ble_notify_enabled = true;
	} else if (!strcmp(command, "stop")) {
		ble_notify_enabled = false;
	} else if (!strncmp(command, "thresh:", strlen("thresh:"))) {
		(void)set_shot_threshold_from_command(command);
	} else {
		printk("# BLE control: unknown command '%s'\n", command);
	}

	return len;
}

static void openfloat_live_ccc_changed(const struct bt_gatt_attr *attr,
				       uint16_t value)
{
	ble_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	printk("# BLE live notifications %s\n",
	       ble_notify_enabled ? "enabled" : "disabled");
}

BT_GATT_SERVICE_DEFINE(openfloat_svc,
	BT_GATT_PRIMARY_SERVICE(&openfloat_service_uuid),
	BT_GATT_CHARACTERISTIC(&openfloat_live_uuid.uuid,
			       BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(openfloat_live_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(&openfloat_control_uuid.uuid,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE,
			       NULL, write_openfloat_control, NULL),
);

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		      BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
					 0x000000000001)),
};

static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static int start_ble_advertising(void)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad),
				  sd, ARRAY_SIZE(sd));

	if (err) {
		printk("# BLE advertising failed: %d\n", err);
		return err;
	}

	printk("# BLE advertising: %s\n", CONFIG_BT_DEVICE_NAME);
	return 0;
}

static void tune_ble_link_work_handler(struct k_work *work)
{
	struct bt_le_conn_param conn_param = BT_LE_CONN_PARAM_INIT(
		OPENFLOAT_CONN_INTERVAL_MIN,
		OPENFLOAT_CONN_INTERVAL_MAX,
		OPENFLOAT_CONN_LATENCY,
		OPENFLOAT_CONN_TIMEOUT);
	const struct bt_conn_le_data_len_param *data_len_param =
		BT_LE_DATA_LEN_PARAM_MAX;
	const struct bt_conn_le_phy_param *phy_param = BT_CONN_LE_PHY_PARAM_2M;
	int err;

	ARG_UNUSED(work);

	if (!current_conn) {
		return;
	}

	err = bt_conn_le_param_update(current_conn, &conn_param);
	if (err) {
		printk("# BLE conn param update request failed: %d\n", err);
	} else {
		printk("# BLE conn param update requested: interval %u-%u units\n",
		       conn_param.interval_min, conn_param.interval_max);
	}

	err = bt_conn_le_data_len_update(current_conn, data_len_param);
	if (err) {
		printk("# BLE data length update request failed: %d\n", err);
	} else {
		printk("# BLE data length update requested: tx %u bytes %u us\n",
		       data_len_param->tx_max_len, data_len_param->tx_max_time);
	}

	err = bt_conn_le_phy_update(current_conn, phy_param);
	if (err) {
		printk("# BLE PHY update request failed: %d\n", err);
	} else {
		printk("# BLE PHY update requested: 2M\n");
	}
}

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		printk("# BLE connection failed: %u %s\n", err,
		       bt_hci_err_to_str(err));
		return;
	}

	current_conn = bt_conn_ref(conn);
	printk("# BLE connected\n");
	(void)k_work_reschedule(&tune_ble_link_work, K_MSEC(500));
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	printk("# BLE disconnected: %u %s\n", reason, bt_hci_err_to_str(reason));
	ble_notify_enabled = false;
	(void)k_work_cancel_delayable(&tune_ble_link_work);

	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}

	(void)start_ble_advertising();
}

static void le_param_updated(struct bt_conn *conn, uint16_t interval,
			     uint16_t latency, uint16_t timeout)
{
	printk("# BLE conn params: interval=%u units latency=%u timeout=%u\n",
	       interval, latency, timeout);
}

static void le_phy_updated(struct bt_conn *conn,
			   struct bt_conn_le_phy_info *param)
{
	printk("# BLE PHY updated: tx=%u rx=%u\n", param->tx_phy, param->rx_phy);
}

static void le_data_len_updated(struct bt_conn *conn,
				struct bt_conn_le_data_len_info *info)
{
	printk("# BLE data length updated: tx=%u/%u us rx=%u/%u us\n",
	       info->tx_max_len, info->tx_max_time,
	       info->rx_max_len, info->rx_max_time);
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
	.le_param_updated = le_param_updated,
	.le_phy_updated = le_phy_updated,
	.le_data_len_updated = le_data_len_updated,
};

static int init_ble(void)
{
	int err;

	err = bt_enable(NULL);
	if (err) {
		printk("# Bluetooth init failed: %d\n", err);
		return err;
	}

	return start_ble_advertising();
}

static void notify_openfloat_live_binary(const uint8_t *payload, size_t len,
					 uint8_t frame_count)
{
	int err;

	if (!current_conn || !ble_notify_enabled) {
		return;
	}

	err = bt_gatt_notify(current_conn, &openfloat_svc.attrs[2],
			     payload, len);
	if (err) {
		ble_dropped_samples += frame_count;
	}
}

static void print_openfloat_live_text(uint32_t sequence, uint32_t dt_us,
				      const struct vec3 *accel,
				      const struct vec3 *gyro,
				      const struct quat *q,
				      float roll_deg, float pitch_deg,
				      float yaw_deg)
{
	printk("OFRAW,1,%u,%llu,%u,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
	       sequence,
	       (unsigned long long)uptime_us(),
	       dt_us,
	       scale_float(accel->x, SCALE_MG),
	       scale_float(accel->y, SCALE_MG),
	       scale_float(accel->z, SCALE_MG),
	       scale_float(gyro->x, SCALE_GYRO_MDPS),
	       scale_float(gyro->y, SCALE_GYRO_MDPS),
	       scale_float(gyro->z, SCALE_GYRO_MDPS),
	       scale_float(roll_deg - cant_offset_deg, SCALE_CDEG),
	       scale_float(pitch_deg - pitch_offset_deg, SCALE_CDEG),
	       scale_float(yaw_deg, SCALE_CDEG),
	       scale_float(q->w, SCALE_QUAT),
	       scale_float(q->x, SCALE_QUAT),
	       scale_float(q->y, SCALE_QUAT),
	       scale_float(q->z, SCALE_QUAT),
	       shot_count);
}

int main(void)
{
	struct quat q = {
		.w = 1.0f,
		.x = 0.0f,
		.y = 0.0f,
		.z = 0.0f,
	};
	uint64_t last_sample_us;
	uint64_t last_output_us;
	int err;

	printk("# OPENFLOAT_PROTO,1\n");
	printk("# target: Seeed XIAO nRF54L15 Sense\n");
	printk("# imu_odr_hz: %d\n", IMU_ODR_HZ);
	printk("# ble_output_hz: %d averaged samples/s\n", BLE_OUTPUT_HZ);
	printk("# ui: user LED status, user button calibration\n");
	printk("# ble: %s, batch %d averaged frames per notification\n",
	       CONFIG_BT_DEVICE_NAME, OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION);
	printk("# BLE live frame: 20 bytes each, batched payload %d bytes, magic[2]='OF', proto u8, type u8, seq u16, dt_us u16, accel_mg int16[3], gyro_dps_q4 int16[3]\n",
	       OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE);
	printk("# format: OFSHOT,proto,shot_id,uptime_us,ax_mg,ay_mg,az_mg,shot_count\n");

	init_user_led();
	init_user_btn();

	(void)init_ble();

	err = configure_imu();
	if (err) {
		return 0;
	}

	last_sample_us = uptime_us();
	last_output_us = last_sample_us;

	while (1) {
		struct vec3 accel;
		struct vec3 gyro;
		static uint8_t ble_payload[OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE];
		static uint8_t ble_payload_frames;
		static struct vec3 accel_sum;
		static struct vec3 gyro_sum;
		static uint32_t avg_count;
		float roll_deg;
		float pitch_deg;
		float yaw_deg;
		uint16_t flags = 0;
		uint64_t now_us = uptime_us();
		uint32_t dt_us = (uint32_t)(now_us - last_sample_us);
		float dt_s = (float)dt_us / 1000000.0f;

		last_sample_us = now_us;

		err = read_imu(&accel, &gyro);
		if (err) {
			printk("# IMU sample failed: %d\n", err);
			k_yield();
			continue;
		}

		raw_sample_sequence++;
		accel_sum.x += accel.x;
		accel_sum.y += accel.y;
		accel_sum.z += accel.z;
		gyro_sum.x += gyro.x;
		gyro_sum.y += gyro.y;
		gyro_sum.z += gyro.z;
		avg_count++;

		if ((now_us - last_output_us) >= BLE_OUTPUT_PERIOD_US) {
			struct vec3 avg_accel = {
				.x = accel_sum.x / avg_count,
				.y = accel_sum.y / avg_count,
				.z = accel_sum.z / avg_count,
			};
			struct vec3 avg_gyro = {
				.x = gyro_sum.x / avg_count,
				.y = gyro_sum.y / avg_count,
				.z = gyro_sum.z / avg_count,
			};
			uint32_t output_dt_us = (uint32_t)(now_us - last_output_us);

			last_output_us += BLE_OUTPUT_PERIOD_US;
			if ((now_us - last_output_us) >= BLE_OUTPUT_PERIOD_US) {
				last_output_us = now_us;
			}
			accel_sum = (struct vec3){ 0 };
			gyro_sum = (struct vec3){ 0 };
			avg_count = 0;

			if (dt_s <= 0.0f || dt_s > 0.2f) {
				dt_s = (float)output_dt_us / 1000000.0f;
			}

			detect_shot(&avg_accel, now_us);
			madgwick_update_imu(&q, &avg_gyro, &avg_accel,
					    (float)output_dt_us / 1000000.0f);
			quat_to_euler(&q, &roll_deg, &pitch_deg, &yaw_deg);

			if (user_btn_pressed()) {
				cant_offset_deg = roll_deg;
				pitch_offset_deg = pitch_deg;
				flags |= BIT(0);
				printk("# Calibrated: cant=0 pitch=0\n");
			}

			update_user_led();
			if (shot_count > 0) {
				flags |= BIT(1);
			}
			if ((telemetry_sequence % SERIAL_PRINT_DIVIDER) == 0) {
				print_openfloat_live_text(telemetry_sequence,
							  output_dt_us,
							  &avg_accel, &avg_gyro,
							  &q, roll_deg,
							  pitch_deg, yaw_deg);
			}

			size_t offset = ble_payload_frames * OPENFLOAT_BLE_FRAME_SIZE;

			build_openfloat_live_binary(&ble_payload[offset],
						    telemetry_sequence, output_dt_us,
						    &avg_accel, &avg_gyro, flags);
			ble_payload_frames++;
			if (ble_payload_frames >= OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION) {
				notify_openfloat_live_binary(
					ble_payload, sizeof(ble_payload),
					ble_payload_frames);
				ble_payload_frames = 0;
			}

			telemetry_sequence++;
		}

	}

	return 0;
}
