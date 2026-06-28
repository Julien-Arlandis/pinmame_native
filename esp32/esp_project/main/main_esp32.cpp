// =========================================================================
// main_esp32.cpp — point d'entrée ESP32-S3 pour PinMAME (mode BLE)
// Périphérique BLE "PinMAME" avec les UUIDs identiques au runtime Node.js
// =========================================================================

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <dirent.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"

#if TRANSPORT_BLE
// NimBLE
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#endif

// USB Host + UAC
#include "usb/usb_host.h"
#include "usb/uac_host.h"

static const char* TAG = "PinMAME";

// ─── Audio USB ───────────────────────────────────────────────────────────────
extern "C" void   usb_audio_init(void);
extern "C" size_t usb_audio_read(void* dst, size_t want, uint32_t timeout_ms);
extern "C" void   audio_dump_init(void);
extern "C" void   audio_dump_send_ble(void);

static uac_host_device_handle_t g_uac_handle = NULL;
static volatile bool g_uac_ready = false;

// ─── Queue pour découpler uac_driver_cb de event_handler_task ────────────────
// uac_driver_cb est appelé depuis event_handler_task. Si on y appelle
// uac_host_device_open/start, les control transfers bloquent → deadlock car
// ctrl_xfer_done est aussi délivré par event_handler_task.
// Solution : poster dans la queue, traiter dans uac_setup_task (tâche séparée).
typedef struct { uint8_t addr; uint8_t iface_num; } uac_setup_req_t;
static QueueHandle_t g_uac_setup_queue = NULL;

// Appelé par le driver UAC quand l'état de l'interface change (event_handler_task)
static void uac_device_cb(uac_host_device_handle_t handle,
                           const uac_host_device_event_t event, void* arg) {
    // TX_DONE (event=1) fire ~187×/sec — ne pas logger pour ne pas bloquer l'UART
    if (event == UAC_HOST_DRIVER_EVENT_DISCONNECTED) {
        ESP_LOGE(TAG, "UAC device event: %d", (int)event);
        g_uac_ready = false;
        uac_host_device_stop(handle);
        uac_host_device_close(handle);
        g_uac_handle = NULL;
    }
}

// Appelé depuis event_handler_task — NE PAS faire de control transfer ici.
static void uac_driver_cb(uint8_t addr, uint8_t iface_num,
                           const uac_host_driver_event_t event, void* arg) {
    ESP_LOGE(TAG, "UAC driver event: %d  addr=%d iface=%d", (int)event, addr, iface_num);
    if (event == UAC_HOST_DRIVER_EVENT_TX_CONNECTED) {
        uac_setup_req_t req = {addr, iface_num};
        xQueueSend(g_uac_setup_queue, &req, 0);
    }
}

// Tâche séparée : fait le setup UAC avec control transfers (open + start).
// event_handler_task reste libre → ctrl_xfer_done peut être appelé sans deadlock.
static void uac_setup_task(void* arg) {
    uac_setup_req_t req;
    while (true) {
        if (xQueueReceive(g_uac_setup_queue, &req, portMAX_DELAY) != pdTRUE) continue;

        uac_host_device_config_t dev_cfg = {};
        dev_cfg.addr             = req.addr;
        dev_cfg.iface_num        = req.iface_num;
        /* 16 Ko = ~85ms d'audio 48kHz/16bit/2ch. Assez large pour absorber le jitter
         * entre les frames synth (typiquement 17ms mais jusqu'à 25ms parfois). */
        dev_cfg.buffer_size      = 16 * 1024;
        dev_cfg.buffer_threshold = 4 * 1024;
        dev_cfg.callback         = uac_device_cb;
        dev_cfg.callback_arg     = NULL;

        esp_err_t rc = uac_host_device_open(&dev_cfg, &g_uac_handle);
        if (rc != ESP_OK) {
            ESP_LOGE(TAG, "uac_host_device_open: %d", rc);
            g_uac_handle = NULL;
            continue;
        }

        uac_host_stream_config_t stream_cfg = {};
        stream_cfg.channels       = 2;
        stream_cfg.bit_resolution = 16;
        stream_cfg.sample_freq    = 48000;
        stream_cfg.flags          = 0;

        rc = uac_host_device_start(g_uac_handle, &stream_cfg);
        if (rc != ESP_OK) {
            ESP_LOGE(TAG, "uac_host_device_start: %d", rc);
            uac_host_device_close(g_uac_handle);
            g_uac_handle = NULL;
            continue;
        }

        // Pré-remplir le ring buffer UAC avec ~34ms de silence.
        // Sans ce pré-remplissage, les 2 URB soumis au 1er uac_host_device_write
        // consomment 384 octets immédiatement, ce qui vide le ring buffer 2ms avant
        // la frame suivante → underrun cyclique de 2ms toutes les 17ms → son "haché".
        {
            uint8_t z[192] = {};
            for (int i = 0; i < 34; i++)
                uac_host_device_write(g_uac_handle, z, sizeof(z), pdMS_TO_TICKS(10));
        }
        g_uac_ready = true;
        ESP_LOGE(TAG, "UAC: streaming 48000 Hz stereo 16-bit OK");
    }
}

// Gestion des événements de la librairie USB host.
// NE PAS logger les events ISO normaux (err=0, flags=0) : ils arrivent ~200×/sec
// pendant le streaming audio et chaque ESP_LOGE bloque le port série assez longtemps
// pour retarder les transferts ISO suivants → gaps audio → son haché/lent.
static void usb_host_task(void* arg) {
    while (true) {
        uint32_t flags = 0;
        esp_err_t err = usb_host_lib_handle_events(portMAX_DELAY, &flags);
        if (err != ESP_OK || flags) {
            ESP_LOGE(TAG, "USB host event: err=%d flags=0x%x", err, (unsigned)flags);
        }
        if (flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            usb_host_device_free_all();
        }
    }
}

// Tâche de lecture du buffer audio → écriture vers les écouteurs USB.
// On envoie toujours les octets réellement reçus du StreamBuffer, même si le
// lot est partiel (timeout 20ms). Répéter l'ancien chunk causait un décalage
// du pitch vers le grave : les données partielles étaient jetées, l'ancien
// chunk rejoué, ce qui divisait le débit effectif et produisait un son "très
// grave". Le ring buffer UAC de 16 Ko absorbe le jitter inter-frame synth.
static void uac_audio_task(void* arg) {
    static uint8_t cur[4096];
    while (true) {
        size_t got = usb_audio_read(cur, sizeof(cur), 20);
        if (got > 0 && g_uac_ready && g_uac_handle) {
            uac_host_device_write(g_uac_handle, cur, (uint32_t)got, 200);
        }
    }
}

static char ROM_NAME[32] = "bonebstr";  // modifiable via @rom:name=

// Lire/écrire le nom de ROM dans NVS
static void nvs_load_rom(void) {
    nvs_handle_t h;
    if (nvs_open("pinmame", NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(ROM_NAME);
        nvs_get_str(h, "rom", ROM_NAME, &len);
        nvs_close(h);
    }
}
static void nvs_save_rom(const char* name) {
    nvs_handle_t h;
    if (nvs_open("pinmame", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "rom", name);
        nvs_commit(h);
        nvs_close(h);
    }
}

#if TRANSPORT_BLE
// ─── UUIDs — identiques au runtime Node.js (LSB-first pour NimBLE) ──────────
// Service :  ab120001-b5a3-f393-e0a9-e50e24dcca9e
// OUT(notify): ab120002-…    IN(write): ab120003-…
static const ble_uuid128_t ble_svc_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x01,0x00,0x12,0xab }
};
static const ble_uuid128_t ble_out_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x02,0x00,0x12,0xab }
};
static const ble_uuid128_t ble_in_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x03,0x00,0x12,0xab }
};

// ─── État global BLE ─────────────────────────────────────────────────────────
uint16_t g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
uint16_t g_ble_out_handle  = 0;   // handle valeur de la caractéristique OUT

// Dernier état connu — renvoyé au client à la connexion
static char s_last_display[128] = {};
static char s_last_lamp[64]     = {};
static char s_last_status[128]  = {};
#endif

#define ESP_FW_VER "3.227"

extern "C" void     ble_resend_last_state(void);
extern "C" void     ble_send_msg(const char* msg);
extern "C" uint8_t* pinmame_get_dsprom_ptr(void);
extern "C" void     api_start_synth_task(void);

// ─── Parsing des commandes BLE entrantes ─────────────────────────────────────
static void handle_ble_command(const char* line) {
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    ESP_LOGE(TAG, "[BLE←] \"%s\"", line);

    // @set:id=N&state=S  →  corridor[100 + N] = S
    if (strncmp(line, "@set:id=", 8) == 0) {
        int id = 0, state = 0;
        const char* p = line + 8;
        while (*p >= '0' && *p <= '9') id = id * 10 + (*p++ - '0');
        const char* s = strstr(p, "&state=");
        if (s) state = atoi(s + 7);
        if (id >= 0 && id < 80) {
            corridor[100 + id] = (uint8_t)(state ? 1 : 0);
            ESP_LOGE(TAG, "  → sw[%d] = %d (corridor[%d])", id, state, 100 + id);
        } else {
            ESP_LOGE(TAG, "  → id=%d hors limites (0-79)", id);
        }
        return;
    }

    // @sound:cmd=N  →  corridor[1060] = N
    if (strncmp(line, "@sound:cmd=", 11) == 0) {
        int cmd = atoi(line + 11);
        corridor[1060] = (uint8_t)cmd;
        ESP_LOGI(TAG, "  → sound cmd=%d", cmd);
        return;
    }

    // @sound:enabled=0/1  →  corridor[1061] : 0=activé, 1=muet
    if (strncmp(line, "@sound:enabled=", 15) == 0) {
        int on = atoi(line + 15);
        corridor[1061] = (uint8_t)(on ? 0 : 1);
        ESP_LOGI(TAG, "  → sound enabled=%d (corridor[1061]=%d)", on, corridor[1061]);
        return;
    }

    // @connect:  →  renvoyer l'état courant
    if (strncmp(line, "@connect:", 9) == 0) {
        ESP_LOGI(TAG, "  → @connect, renvoi état");
        ble_resend_last_state();
        return;
    }

    // @reboot:  →  redémarrage immédiat
    if (strncmp(line, "@reboot:", 8) == 0) {
        ESP_LOGI(TAG, "  → reboot");
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
        return;
    }

    // @rom:name=<name>  →  sauvegarder en NVS + reboot
    if (strncmp(line, "@rom:name=", 10) == 0) {
        const char* name = line + 10;
        // décoder %XX simple (juste les cas courants)
        char decoded[32] = {};
        int di = 0;
        for (int si = 0; name[si] && di < 31; ) {
            if (name[si] == '%' && name[si+1] && name[si+2]) {
                char hex[3] = { name[si+1], name[si+2], 0 };
                decoded[di++] = (char)strtol(hex, NULL, 16);
                si += 3;
            } else {
                decoded[di++] = name[si++];
            }
        }
        ESP_LOGI(TAG, "  → changement ROM : %s", decoded);
        nvs_save_rom(decoded);
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
        return;
    }

    // @getaudio:  →  envoyer les 0,5 s de PCM capturés en WAV via BLE
    if (strcmp(line, "@getaudio:") == 0) {
        audio_dump_send_ble();
        return;
    }

    // @version:  →  répondre avec la version firmware
    if (strcmp(line, "@version:") == 0) {
        ble_send_msg("FW:" ESP_FW_VER);
        return;
    }

    // Commandes ignorées silencieusement (audio, capture, dip, scope…)
    if (strncmp(line, "@audio:", 7) == 0 ||
        strncmp(line, "@dip:",   5) == 0 ||
        strncmp(line, "@capture:", 9) == 0 ||
        strncmp(line, "@scope:", 7) == 0) {
        return;
    }

    ESP_LOGW(TAG, "  → commande non reconnue : %s", line);
}

#if TRANSPORT_BLE
// ─── Buffer d'assemblage des chunks IN ───────────────────────────────────────
static char  s_in_buf[512] = {};
static int   s_in_len      = 0;

// ─── GATT handlers ───────────────────────────────────────────────────────────
static int gatt_out_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt* ctxt, void* arg) {
    return 0;
}

static int gatt_in_access(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt* ctxt, void* arg) {
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    uint16_t pktlen = OS_MBUF_PKTLEN(ctxt->om);
    if (pktlen < 1) return 0;

    uint8_t flag = 0;
    os_mbuf_copydata(ctxt->om, 0, 1, &flag);
    ESP_LOGE(TAG, "[BLE chunk] flag=0x%02x len=%d", flag, pktlen);

    uint16_t dlen = pktlen - 1;
    if (dlen > 0 && s_in_len + (int)dlen < (int)sizeof(s_in_buf) - 1) {
        os_mbuf_copydata(ctxt->om, 1, dlen, s_in_buf + s_in_len);
        s_in_len += (int)dlen;
    }

    if (flag == 0x01) {  // dernier chunk — ligne complète
        s_in_buf[s_in_len] = '\0';
        // trim \n
        while (s_in_len > 0 && (s_in_buf[s_in_len-1] == '\n' || s_in_buf[s_in_len-1] == '\r'))
            s_in_buf[--s_in_len] = '\0';
        if (s_in_len > 0)
            handle_ble_command(s_in_buf);
        s_in_len = 0;
    }
    return 0;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &ble_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid       = &ble_out_uuid.u,
                .access_cb  = gatt_out_access,
                .flags      = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &g_ble_out_handle,
            },
            {
                .uuid      = &ble_in_uuid.u,
                .access_cb = gatt_in_access,
                .flags     = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            { 0 }
        },
    },
    { 0 }
};

// ─── GAP ─────────────────────────────────────────────────────────────────────
static void start_advertising(void);

static int gap_event_cb(struct ble_gap_event* event, void* arg) {
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            g_ble_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "BLE connecté (handle=%d)", g_ble_conn_handle);
            // Demander l'intervalle de connexion minimum (6×1.25ms=7.5ms) pour
            // maximiser le débit display. Le central peut refuser ou arrondir.
            struct ble_gap_upd_params upd = {};
            upd.itvl_min         = 6;    // 6 × 1.25ms = 7.5ms
            upd.itvl_max         = 12;   // 12 × 1.25ms = 15ms
            upd.latency          = 0;
            upd.supervision_timeout = 200; // 2s
            upd.min_ce_len       = BLE_GAP_INITIAL_CONN_MIN_CE_LEN;
            upd.max_ce_len       = BLE_GAP_INITIAL_CONN_MAX_CE_LEN;
            ble_gap_update_params(g_ble_conn_handle, &upd);
            // Renvoi de l'état courant au nouveau client
            vTaskDelay(pdMS_TO_TICKS(50));  // laisser le CCCD s'activer
            ble_send_msg("FW:" ESP_FW_VER);
            ble_resend_last_state();
        } else {
            g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            start_advertising();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "BLE déconnecté (raison=%d)", event->disconnect.reason);
        g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        start_advertising();
        break;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "BLE MTU négocié : %d octets", event->mtu.value);
        break;
    default:
        break;
    }
    return 0;
}

static void start_advertising(void) {
    // Nom seul dans l'adv (UUID → scan response pour rester ≤31 octets)
    struct ble_hs_adv_fields fields = {};
    const char* name           = "flip-g80-esp32";
    fields.flags               = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name                = (const uint8_t*)name;
    fields.name_len            = (uint8_t)strlen(name);
    fields.name_is_complete    = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc) { ESP_LOGE(TAG, "ble_gap_adv_set_fields: %d", rc); return; }

    // UUID128 dans la scan response
    struct ble_hs_adv_fields rsp = {};
    rsp.uuids128            = &ble_svc_uuid;
    rsp.num_uuids128        = 1;
    rsp.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc) { ESP_LOGE(TAG, "ble_gap_adv_rsp_set_fields: %d", rc); return; }

    struct ble_gap_adv_params adv_params = {};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_cb, NULL);
    if (rc) { ESP_LOGE(TAG, "ble_gap_adv_start: %d", rc); return; }
    ESP_LOGI(TAG, "BLE advertising 'flip-g80-esp32'");
}

static void ble_sync_cb(void) {
    ble_hs_util_ensure_addr(0);
    start_advertising();
}

static void ble_reset_cb(int reason) {
    ESP_LOGW(TAG, "BLE reset (raison=%d)", reason);
    g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
}

// ─── Tâche NimBLE ─────────────────────────────────────────────────────────────
static void ble_host_task(void* param) {
    nimble_port_run();           // bloquant jusqu'à nimble_port_stop()
    nimble_port_freertos_deinit();
}
#endif // TRANSPORT_BLE

// ─── Tâche d'émulation ───────────────────────────────────────────────────────
extern "C" {
    uint8_t* pinmame_get_dsprom_ptr(void);
    void     pinmame_web_boot(void);
}

static void emulation_task(void* arg) {
    (void)arg;
#if TRANSPORT_BLE
    // Attendre la connexion BLE effective avant de démarrer l'émulation,
    // pour que le test des lampes et l'affichage au boot soient visibles.
    while (g_ble_conn_handle == BLE_HS_CONN_HANDLE_NONE) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    vTaskDelay(pdMS_TO_TICKS(300));  // laisser le CCCD s'activer
#endif
    // La tâche monopolise intentionnellement le core 1 — désactiver le watchdog
    esp_task_wdt_delete(xTaskGetCurrentTaskHandle());
    ESP_LOGI(TAG, "Démarrage émulation ROM: %s", ROM_NAME);
    pinmame_web_boot();
    ESP_LOGI(TAG, "osd_exit — émulation terminée");
    vTaskDelete(NULL);
}

// ─── app_main ────────────────────────────────────────────────────────────────
extern "C" void app_main(void) {
    // Supprimer les logs diagnostiques verbeux du workspace (toutes les ~3s) qui
    // causent des rafales UART bloquantes perturbant le budget de frame de l'émulation.
    esp_log_level_set("MIXSRC", ESP_LOG_NONE);
    esp_log_level_set("MIXER",  ESP_LOG_NONE);
    esp_log_level_set("M6502",  ESP_LOG_NONE);
    esp_log_level_set("TMR",    ESP_LOG_NONE);
    esp_log_level_set("CPUCYC", ESP_LOG_NONE);
    esp_log_level_set("SLATCH", ESP_LOG_NONE);

    ESP_LOGI(TAG, "PinMAME ESP32-S3 démarrage (mode BLE)...");

    // NVS
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    // SPIFFS
    esp_vfs_spiffs_conf_t spiffs_conf = {
        .base_path              = "/spiffs",
        .partition_label        = NULL,
        .max_files              = 20,
        .format_if_mount_failed = false,
    };
    ret = esp_vfs_spiffs_register(&spiffs_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Échec montage SPIFFS (%s)", esp_err_to_name(ret));
    } else {
        size_t total = 0, used = 0;
        esp_spiffs_info(NULL, &total, &used);
        ESP_LOGE(TAG, "SPIFFS monté : %u Ko / %u Ko", (unsigned)(used/1024), (unsigned)(total/1024));
        // Lister les fichiers présents dans SPIFFS pour diagnostiquer le chemin
        DIR* d = opendir("/spiffs");
        if (!d) {
            ESP_LOGE(TAG, "SPIFFS: opendir('/spiffs') impossible");
        } else {
            struct dirent* ent;
            while ((ent = readdir(d)) != NULL) {
                ESP_LOGE(TAG, "SPIFFS fichier: /%s", ent->d_name);
            }
            closedir(d);
        }
    }

    // Charger le nom de ROM depuis NVS (si sauvegardé via @rom:name=)
    nvs_load_rom();
    ESP_LOGI(TAG, "ROM : %s", ROM_NAME);

    // Nom de la ROM dans le corridor partagé
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    strncpy((char*)(corridor + 1000), ROM_NAME, 20);
    corridor[1000 + strnlen(ROM_NAME, 20)] = '\0';

    // ── USB Host + UAC audio ──────────────────────────────────────────────────
    ESP_LOGE(TAG, "[MEM] avant USB  — SRAM libre: %u  bloc max: %u",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    usb_audio_init();
    audio_dump_init();  // buffer PSRAM 96 Ko pour dump WAV diagnostic

    usb_host_config_t host_cfg = {};
    host_cfg.skip_phy_setup = false;
    host_cfg.intr_flags     = ESP_INTR_FLAG_LEVEL1;
    ESP_ERROR_CHECK(usb_host_install(&host_cfg));
    xTaskCreatePinnedToCoreWithCaps(usb_host_task, "usb_host", 4096, NULL, 10, NULL, 0,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    ESP_LOGE(TAG, "[MEM] apres USB  — SRAM libre: %u  bloc max: %u",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    uac_host_driver_config_t uac_cfg = {};
    uac_cfg.create_background_task = true;
    uac_cfg.task_priority          = 10;
    uac_cfg.stack_size             = 4096;
    uac_cfg.core_id                = 0;
    uac_cfg.callback               = uac_driver_cb;
    uac_cfg.callback_arg           = NULL;
    g_uac_setup_queue = xQueueCreate(4, sizeof(uac_setup_req_t));
    ESP_ERROR_CHECK(uac_host_install(&uac_cfg));
    xTaskCreatePinnedToCoreWithCaps(uac_setup_task, "uac_setup", 4096, NULL, 9, NULL, 0,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    xTaskCreatePinnedToCoreWithCaps(uac_audio_task, "uac_audio", 4096, NULL, 8, NULL, 0,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);  // Core 0 avec synth — libère Core 1 pour emulation

    ESP_LOGE(TAG, "[MEM] apres UAC  — SRAM libre: %u  bloc max: %u",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

#if TRANSPORT_BLE
    // NimBLE
    ret = nimble_port_init();
    if (ret != ESP_OK) { ESP_LOGE(TAG, "nimble_port_init failed: %d", ret); return; }

    ble_hs_cfg.sync_cb  = ble_sync_cb;
    ble_hs_cfg.reset_cb = ble_reset_cb;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("flip-g80-esp32");

    ble_gatts_count_cfg(gatt_svcs);
    ble_gatts_add_svcs(gatt_svcs);

    nimble_port_freertos_init(ble_host_task);

    ESP_LOGE(TAG, "[MEM] apres BLE  — SRAM libre: %u  bloc max: %u",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
#endif


    // Pile agrandie 32K -> 49K : suspectée trop juste (cf. canary réactivé dans
    // sdkconfig.defaults), un dépassement silencieux pouvant corrompre des
    // variables locales (ex. IntegerDivideByZero observé dans le resampler).
    // SRAM INTERNAL obligatoire : la tâche accède à SPIFFS (cache SPI désactivé
    // pendant la lecture flash → SPIRAM inaccessible → crash immédiat si stack en PSRAM).
    api_start_synth_task();  // synth sur Core 0 — emulation_task seule sur Core 1

    BaseType_t ok = xTaskCreatePinnedToCoreWithCaps(
        emulation_task, "pinmame", 49152, NULL, 5, NULL, 1,
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
    );
    if (ok != pdPASS)
        ESP_LOGE(TAG, "Impossible de créer la tâche PinMAME");
}
