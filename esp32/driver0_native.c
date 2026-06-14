/*
 * driver0_native.c — définit driver_0, le sentinelle GameDriver de MAME
 *
 * driver.c (non compilé en natif) génère normalement :
 *   const struct GameDriver driver_0 = { __FILE__, 0, "", 0, ..., NOT_A_DRIVER };
 *
 * Sans cela, driver_0 est zéro-initialisé (name=NULL, flags=0).
 * La boucle clone_of dans machine_init_gts80 traverse driver_bonebstr → driver_0,
 * puis strncasecmp(driver_0.name=NULL, ...) crashe.
 *
 * Ce fichier fournit la définition correcte avec name="" et flags=NOT_A_DRIVER.
 */

#include "driver.h"   /* GameDriver, NOT_A_DRIVER — trouvé via -I flags du build */

const struct GameDriver driver_0 = {
    __FILE__,          /* source_file */
    0,                 /* clone_of = NULL (racine de la hiérarchie) */
    "",                /* name = chaîne vide */
    0,                 /* bios */
    0,                 /* description */
    0,                 /* year */
    0,                 /* manufacturer */
    0,                 /* drv */
    0,                 /* input_ports */
    0,                 /* driver_init */
    0,                 /* rom */
    NOT_A_DRIVER       /* flags = 0x4000 */
};
