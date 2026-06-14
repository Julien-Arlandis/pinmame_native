/* stubs_native.c — symboles OSD/video/misc non utilisés en exécution GTS80 native */

#include <stdint.h>
#include <stddef.h>

/* Types opaques — évite d'inclure les headers MAME complexes */
struct mame_bitmap { int w; };
struct rectangle    { int min_x; };
typedef void mame_file;

/* ---- Variables globales ----------------------------------------- */
const char *cheatfile         = NULL;
const char *db_filename       = "hiscore.dat";
const char *history_filename  = NULL;
const char *mameinfo_filename = NULL;

struct mame_bitmap *tmpbitmap = NULL;

/* ---- Vidéo (GTS80 Caveman uniquement — pas utilisé pour bonebstr) */
void ui_text(struct mame_bitmap *b, const char *s, int x, int y)
    { (void)b; (void)s; (void)x; (void)y; }

void copybitmap(struct mame_bitmap *d, struct mame_bitmap *s,
                int fx, int fy, int sx, int sy,
                struct rectangle *c, int t, int col)
    { (void)d; (void)s; (void)fx; (void)fy; (void)sx; (void)sy;
      (void)c; (void)t; (void)col; }

/* ---- Artwork / snapshot ----------------------------------------- */
void artwork_override_screenshot_params(struct mame_bitmap **b,
                                        struct rectangle *r,
                                        uint32_t *rgb)
    { (void)b; (void)r; (void)rgb; }

struct mame_bitmap *osd_override_snapshot(struct mame_bitmap *b,
                                          struct rectangle *r)
    { (void)b; (void)r; return 0; }

int png_write_bitmap(mame_file *fp, struct mame_bitmap *b)
    { (void)fp; (void)b; return -1; }

/* ---- Throttle / LEDs -------------------------------------------- */
void SetThrottleAdj(int adj) { (void)adj; }
void UpdateSoundLEDS(int num, uint8_t bit) { (void)num; (void)bit; }

/* ---- construct_TABART2 : table sound board GTS1, jamais exécuté pour GTS80 */
/* signature générée par MACHINE_DRIVER_START(TABART2) dans tabart.c */
struct InternalMachineDriver;
void construct_TABART2(struct InternalMachineDriver *drv) { (void)drv; }

/* ---- __real_run_machine : --wrap=run_machine est WASM/lld uniquement.     */
/* run_machine() est static dans mame.c, jamais appelée depuis l'extérieur.  */
/* __wrap_run_machine est définie dans api.cpp mais jamais appelée en natif.  */
int __real_run_machine(void) { return 0; }

/* ---- YM2151 ALT (HAS_YM2151_ALT=0 → jamais compilé) ------------ */
void YM2151_data_port_1_w(int offset, int data) { (void)offset; (void)data; }
void YM2151_register_port_1_w(int offset, int data) { (void)offset; (void)data; }
int  YM2151Read(int n, int a) { (void)n; (void)a; return 0; }

/* ---- pic8259 read/write (api.cpp fournit config+issue_irq, pas r/w) */
/* READ_HANDLER(pic8259_0_r)  = unsigned char (unsigned int offset)   */
/* WRITE_HANDLER(pic8259_0_w) = void (unsigned int offset, unsigned char data) */
unsigned char pic8259_0_r(unsigned int offset) { (void)offset; return 0; }
void pic8259_0_w(unsigned int offset, unsigned char data) { (void)offset; (void)data; }

/* ---- OKIM6295 (source absente du pinmame_stock) ----------------- */
void OKIM6295_data_0_w(int offset, int data) { (void)offset; (void)data; }
void OKIM6295_set_bank_base(int which, int base) { (void)which; (void)base; }
void OKIM6295_set_pin7(int which, int pin7) { (void)which; (void)pin7; }
