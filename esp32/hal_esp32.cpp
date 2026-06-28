// =========================================================================
// hal_esp32.cpp — HAL PinMAME pour ESP32-S3 (mode BLE)
// Protocol identique au runtime Node.js (@abandonware/bleno) :
//   premier octet du paquet = 0x00 (suite) ou 0x01 (dernier chunk)
//   reste du paquet = UTF-8
// Lignes envoyées : !display:action=text&data=<url>  !lamp:<24hex>  @status:…
// =========================================================================

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"

#if TRANSPORT_BLE
// NimBLE
#include "host/ble_hs.h"
#include "host/ble_att.h"
#endif

static const char* TAG = "HAL";

extern "C" void esp_loge_fps(float fps) {
    ESP_LOGE("FPS", "emulation: %.1f fps", fps);
    char msg[32];
    snprintf(msg, sizeof(msg), "FPS:%.1f", fps);
    ble_send_msg(msg);
}

typedef int64_t hal_cycles_t;

#if TRANSPORT_BLE
// Déclarés dans main_esp32.cpp
extern uint16_t g_ble_conn_handle;
extern uint16_t g_ble_out_handle;
#endif

// DAC depuis api.cpp
extern "C" {
    int  api_get_dac_count(int c);
    int* api_get_dac_buffer(int c);
    void api_reset_dac_buffer(int c);
}

// ─── Dernier état — renvoyé au client qui se connecte ────────────────────────
static char s_last_display[256] = {};
static char s_last_lamp[64]     = {};
static char s_last_status[256]  = {};

// ─── URL encode (A-Z a-z 0-9 -_.~ → tel quel, reste → %XX) ──────────────────
static void url_encode(const char* src, char* dst, size_t dstlen) {
    static const char hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 4 < dstlen; i++) {
        uint8_t c = (uint8_t)src[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            dst[j++] = (char)c;
        } else {
            dst[j++] = '%';
            dst[j++] = hex[c >> 4];
            dst[j++] = hex[c & 0xf];
        }
    }
    dst[j] = '\0';
}

#if TRANSPORT_BLE
// ─── bleSend : envoie une ligne via BLE notify (chunking identique Node.js) ──
static void bleSend(const char* line) {
    if (g_ble_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    if (!g_ble_out_handle) return;

    // Buffer = line + '\n'
    char buf[512];
    size_t total = (size_t)snprintf(buf, sizeof(buf) - 1, "%s\n", line);
    if (total >= sizeof(buf)) total = sizeof(buf) - 1;

    // MTU : ATT MTU - 3 (header ATT) - 1 (byte protocole) = max data par chunk
    uint16_t att_mtu = ble_att_mtu(g_ble_conn_handle);
    if (att_mtu < 4) att_mtu = 23;
    int chunk_size = (int)(att_mtu - 3 - 1);
    if (chunk_size < 1) chunk_size = 1;

    size_t offset = 0;
    while (offset < total) {
        size_t chunk = (size_t)chunk_size;
        if (offset + chunk > total) chunk = total - offset;
        bool is_last = (offset + chunk >= total);

        // Packet : [0x00|0x01][data...]
        uint8_t packet[512];
        packet[0] = is_last ? 0x01 : 0x00;
        memcpy(packet + 1, buf + offset, chunk);

        struct os_mbuf* om = ble_hs_mbuf_from_flat(packet, chunk + 1);
        if (!om) break;

        int rc = ble_gatts_notify_custom(g_ble_conn_handle, g_ble_out_handle, om);
        if (rc != 0) {
            // om consommé par ble_gatts_notify_custom même en erreur
            g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            break;
        }

        offset += chunk;
    }
}

// ─── Renvoi de l'état au client qui vient de se connecter ────────────────────
extern "C" void ble_resend_last_state(void) {
    if (s_last_status[0])  bleSend(s_last_status);
    if (s_last_display[0]) bleSend(s_last_display);
    if (s_last_lamp[0])    bleSend(s_last_lamp);
}

// Wrapper pour envoyer un message BLE arbitraire depuis d'autres TUs.
extern "C" void ble_send_msg(const char* msg) { bleSend(msg); }

#else
static void bleSend(const char*) {}
extern "C" void ble_resend_last_state(void) {}
extern "C" void ble_send_msg(const char*) {}
#endif

// ─── Prototype audio-over-BLE ─────────────────────────────────────────────
// Paquet = [0x02][échantillons mono 8-bit, 11025Hz] — tag 0x02 distinct des
extern "C" {

hal_cycles_t hal_cycles(void) {
    return (hal_cycles_t)(esp_timer_get_time() * 1000LL);
}

hal_cycles_t hal_cycles_per_second(void) { return 1000000000LL; }

void hal_sleep_ms(int ms) {
    if (ms > 0) vTaskDelay(pdMS_TO_TICKS(ms));
}

void hal_osd_exit(void) {
    ESP_LOGI(TAG, "osd_exit");
}

// ─── Audio USB ───────────────────────────────────────────────────────────────
// 800 samples stéréo 16-bit par frame × 2 octets = 3200 octets/frame (48000Hz)
// 16 frames de tampon ≈ 267 ms de latence max
#define USB_AUDIO_FRAME_BYTES  3200
#define USB_AUDIO_SB_SIZE      (USB_AUDIO_FRAME_BYTES * 16)

static StreamBufferHandle_t g_audio_sb  = NULL;

// ─── Dump PCM diagnostic (0,5 s → WAV → BLE) ─────────────────────────────────
#define DUMP_PCM_BYTES 96000U   // 0,5 s stéréo 16-bit 48kHz = 96000 octets
static uint8_t*          s_dump_buf       = NULL;
static uint32_t          s_dump_pos       = 0;
static bool              s_dump_done      = false;
static volatile bool     s_dump_capturing = false;  // capture déclenchée par @getaudio:
static volatile bool     s_dump_sending   = false;

extern "C" void usb_audio_init(void) {
    g_audio_sb = xStreamBufferCreate(USB_AUDIO_SB_SIZE, USB_AUDIO_FRAME_BYTES);
}

extern "C" size_t usb_audio_read(void* dst, size_t want, uint32_t timeout_ms) {
    if (!g_audio_sb) return 0;
    return xStreamBufferReceive(g_audio_sb, dst, want, pdMS_TO_TICKS(timeout_ms));
}

void hal_push_audio(uintptr_t ptr, int count, uint32_t gen) {
    (void)gen;
    for (int c = 0; c < 2; c++) api_reset_dac_buffer(c);
    if (!g_audio_sb || !ptr || count <= 0) return;
    size_t bytes = (size_t)(count * 2);  // count INT16 → count*2 octets
    xStreamBufferSend(g_audio_sb, (const void*)ptr, bytes, 0);
    // Capture pour dump diagnostic (déclenchée uniquement par @getaudio:)
    if (s_dump_buf && s_dump_capturing && !s_dump_done) {
        uint32_t avail = DUMP_PCM_BYTES - s_dump_pos;
        uint32_t n = (uint32_t)(bytes < (size_t)avail ? bytes : (size_t)avail);
        memcpy(s_dump_buf + s_dump_pos, (const void*)ptr, n);
        s_dump_pos += n;
        if (s_dump_pos >= DUMP_PCM_BYTES) {
            s_dump_done = true;
            ESP_LOGE(TAG, "audio_dump: capture terminée (%u octets)", s_dump_pos);
        }
    }
}

void audio_dump_init(void) {
    s_dump_buf = (uint8_t*)heap_caps_malloc(DUMP_PCM_BYTES,
                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_LOGE(TAG, "audio_dump: %s (%u octets)",
             s_dump_buf ? "PSRAM OK" : "ÉCHEC alloc PSRAM", DUMP_PCM_BYTES);
}

static void audio_dump_task(void* pv) {
    (void)pv;

    // 1. Déclencher la capture du son actuel
    s_dump_pos  = 0;
    s_dump_done = false;
    s_dump_capturing = true;
    bleSend("WAVE_CAP");
    ESP_LOGE(TAG, "audio_dump: capture démarrée…");

    // 2. Attendre la fin (max 1,5 s)
    for (int i = 0; i < 150 && !s_dump_done; i++)
        vTaskDelay(pdMS_TO_TICKS(10));
    s_dump_capturing = false;

    if (!s_dump_done) {
        bleSend("WAVE_ERR:timeout");
        s_dump_sending = false;
        vTaskDelete(NULL);
        return;
    }

    // 3. Construire et envoyer le WAV
    static const char hx[] = "0123456789ABCDEF";
    uint32_t pcm_bytes = s_dump_pos;
    uint32_t riff_sz   = 36 + pcm_bytes;
    uint32_t byte_rate = 48000u * 2u * 2u;  // 192000
    uint8_t hdr[44]    = {};
    hdr[0]='R'; hdr[1]='I'; hdr[2]='F'; hdr[3]='F';
    for (int i=0;i<4;i++) hdr[ 4+i]=(uint8_t)(riff_sz  >>(i*8));
    hdr[8]='W'; hdr[9]='A'; hdr[10]='V'; hdr[11]='E';
    hdr[12]='f'; hdr[13]='m'; hdr[14]='t'; hdr[15]=' ';
    hdr[16]=16; hdr[20]=1; hdr[22]=2;  // PCM, 2 canaux
    for (int i=0;i<4;i++) hdr[24+i]=(uint8_t)(48000u   >>(i*8));
    for (int i=0;i<4;i++) hdr[28+i]=(uint8_t)(byte_rate>>(i*8));
    hdr[32]=4; hdr[34]=16;  // block_align=4, bits=16
    hdr[36]='d'; hdr[37]='a'; hdr[38]='t'; hdr[39]='a';
    for (int i=0;i<4;i++) hdr[40+i]=(uint8_t)(pcm_bytes>>(i*8));

    // Taille de chunk adaptée au MTU réel : chaque WAVE: doit tenir dans 1 seul paquet BLE.
    // ATT payload = MTU - 3 (header ATT) - 1 (flag protocole) = MTU - 4.
    // Overhead ligne WAVE: "WAVE:NNNN:\n" = 11 chars → rest = hex.
    // 1 byte = 2 chars hex → bytes_per_chunk = (ATT_payload - 11) / 2.
    uint16_t att_mtu = ble_att_mtu(g_ble_conn_handle);
    if (att_mtu < 16) att_mtu = 23;
    int att_payload    = (int)(att_mtu - 4);
    int bytes_per_chunk = (att_payload - 11) / 2;
    if (bytes_per_chunk < 1)   bytes_per_chunk = 1;
    if (bytes_per_chunk > 120) bytes_per_chunk = 120;

    uint32_t total = 44 + pcm_bytes;
    ESP_LOGE(TAG, "audio_dump: MTU=%u chunk=%d bytes total=%u", att_mtu, bytes_per_chunk, (unsigned)total);

    char line[300];
    snprintf(line, sizeof(line), "WAVE_START:%u", (unsigned)total);
    bleSend(line);
    vTaskDelay(pdMS_TO_TICKS(30));

    uint32_t offset = 0;
    int chunk_id = 0;
    while (offset < total) {
        uint32_t n = (uint32_t)bytes_per_chunk;
        if (offset + n > total) n = total - offset;
        char* p = line;
        p += snprintf(p, 12, "WAVE:%04d:", chunk_id);
        for (uint32_t i = 0; i < n; i++) {
            uint8_t b = (offset+i < 44) ? hdr[offset+i] : s_dump_buf[(offset+i)-44];
            *p++ = hx[b>>4]; *p++ = hx[b&0xf];
        }
        *p = '\0';
        bleSend(line);
        vTaskDelay(pdMS_TO_TICKS(5));
        offset += n;
        chunk_id++;
    }
    bleSend("WAVE_END");
    ESP_LOGE(TAG, "audio_dump: %d chunks envoyés via BLE", chunk_id);
    s_dump_sending = false;
    vTaskDelete(NULL);
}

void audio_dump_send_ble(void) {
    if (!s_dump_buf)   { bleSend("WAVE_ERR:no_buffer"); return; }
    // Note : s_dump_done est géré par audio_dump_task lui-même (capture on-demand).
    // Ne pas vérifier s_dump_done ici, sinon on renvoyait toujours "not_ready".
    if (s_dump_sending){ bleSend("WAVE_ERR:busy");      return; }
    s_dump_sending = true;
    ESP_LOGE(TAG, "audio_dump: lancement tâche BLE (%u octets)", s_dump_pos);
    BaseType_t ok = xTaskCreatePinnedToCoreWithCaps(
        audio_dump_task, "wavdump", 4096, NULL, 3, NULL, 0,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ok != pdPASS) { s_dump_sending = false; bleSend("WAVE_ERR:task_fail"); }
}

void hal_push_display(uintptr_t ptr, uint32_t gen) {
    (void)gen;
    if (!ptr) return;

    // Format identique au runtime WASM : "!display:action=raw&data=<160 hex chars>"
    // 40 uint16_t little-endian, chacun en 4 hex chars
    const uint8_t* p = (const uint8_t*)ptr;
    char line[200]; // 25 + 160 + 1
    memcpy(line, "!display:action=raw&data=", 25);
    int off = 25;
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 40; i++) {
        uint16_t val = (uint16_t)(p[i * 2] | ((uint16_t)p[i * 2 + 1] << 8));
        line[off++] = hex[(val >> 12) & 0xf];
        line[off++] = hex[(val >>  8) & 0xf];
        line[off++] = hex[(val >>  4) & 0xf];
        line[off++] = hex[ val        & 0xf];
    }
    line[off] = '\0';

    strncpy(s_last_display, line, sizeof(s_last_display) - 1);
    bleSend(line);
}

// ─── Display texte → !display:action=text&data=<urlencode> ───────────────────
void hal_push_display_text(const char* text, uint32_t gen) {
    // Non utilisé côté ESP32 : hal_push_display (action=raw) est le format rendu
    (void)text; (void)gen;
}

// ─── Lampes → !lamp:<24 hex chars> (12 octets = lampMatrix[0..11]) ───────────
void hal_push_lamps(uintptr_t ptr, uint32_t gen) {
    (void)gen;
    if (!ptr) return;

    const uint8_t* lamp = (const uint8_t*)ptr;
    char line[32];
    // "!lamp:" + 24 hex chars + '\0' = 31 chars
    int off = 0;
    line[off++] = '!'; line[off++] = 'l'; line[off++] = 'a';
    line[off++] = 'm'; line[off++] = 'p'; line[off++] = ':';
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 12; i++) {
        line[off++] = hex[lamp[i] >> 4];
        line[off++] = hex[lamp[i] & 0xf];
    }
    line[off] = '\0';

    strncpy(s_last_lamp, line, sizeof(s_last_lamp) - 1);
    bleSend(line);
}

void hal_push_solens(uint32_t state, uint32_t gen) {
    (void)gen; (void)state;
}

// ─── Machine info → @status:state=ready&<info> ───────────────────────────────
void hal_post_machine_info(const char* info) {
    ESP_LOGI(TAG, "[MACHINE] %s", info);
    ESP_LOGE("MEM", "heap_free=%u internal_free=%u",
        (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_free_internal_heap_size());
    char line[256];
    snprintf(line, sizeof(line), "@status:state=ready&%s", info ? info : "");
    strncpy(s_last_status, line, sizeof(s_last_status) - 1);
    bleSend(line);
}

void hal_post_log(uint32_t cmd, uint32_t gen) {
    (void)gen;
    ESP_LOGD(TAG, "[SND] cmd=0x%02X", (unsigned)cmd);
}

const char* hal_rompath(void) { return "/spiffs/roms"; }

} // extern "C"
